//! wgpu 렌더러: 인스턴스 사각형 + 아틀라스 글리프 두 파이프라인.
//! 창 표면과 오프스크린 텍스처 양쪽에 같은 코드로 그린다.

use std::sync::Arc;

use bytemuck::{Pod, Zeroable};

use crate::font::{ATLAS_SIZE, Upload};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
pub struct RectInst {
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub color: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
pub struct GlyphInst {
    pub pos: [f32; 2],
    pub size: [f32; 2],
    /// 아틀라스 안의 x, y, w, h (px)
    pub uv: [f32; 4],
    pub color: [f32; 4],
    /// 1.0 이면 컬러 글리프
    pub color_glyph: f32,
    pub _pad: [f32; 3],
}

#[derive(Default)]
pub struct Frame {
    pub clear: [f32; 4],
    pub rects_under: Vec<RectInst>,
    pub glyphs: Vec<GlyphInst>,
    pub rects_over: Vec<RectInst>,
}

impl Frame {
    pub fn clear(&mut self) {
        self.rects_under.clear();
        self.glyphs.clear();
        self.rects_over.clear();
    }
}

const SHADER: &str = r#"
struct U { vp: vec2<f32>, atlas: vec2<f32> }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var atlas_tex: texture_2d<f32>;
@group(0) @binding(2) var atlas_smp: sampler;

fn corner(vi: u32) -> vec2<f32> {
    var c = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
    return c[vi];
}

fn to_ndc(px: vec2<f32>) -> vec4<f32> {
    return vec4<f32>(px.x / u.vp.x * 2.0 - 1.0, 1.0 - px.y / u.vp.y * 2.0, 0.0, 1.0);
}

struct RectOut { @builtin(position) p: vec4<f32>, @location(0) color: vec4<f32> }

@vertex
fn vs_rect(@builtin(vertex_index) vi: u32,
           @location(0) pos: vec2<f32>, @location(1) size: vec2<f32>, @location(2) color: vec4<f32>) -> RectOut {
    var o: RectOut;
    o.p = to_ndc(pos + corner(vi) * size);
    o.color = color;
    return o;
}

@fragment
fn fs_rect(in: RectOut) -> @location(0) vec4<f32> {
    return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}

struct GlyphOut {
    @builtin(position) p: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) flag: f32,
}

@vertex
fn vs_glyph(@builtin(vertex_index) vi: u32,
            @location(0) pos: vec2<f32>, @location(1) size: vec2<f32>, @location(2) uvr: vec4<f32>,
            @location(3) color: vec4<f32>, @location(4) flag: f32) -> GlyphOut {
    var o: GlyphOut;
    let q = corner(vi);
    o.p = to_ndc(pos + q * size);
    o.uv = (uvr.xy + q * uvr.zw) / u.atlas;
    o.color = color;
    o.flag = flag;
    return o;
}

@fragment
fn fs_glyph(in: GlyphOut) -> @location(0) vec4<f32> {
    let s = textureSample(atlas_tex, atlas_smp, in.uv);
    if (in.flag > 0.5) {
        let a = s.a * in.color.a;
        return vec4<f32>(s.rgb * a, a);
    }
    let a = s.a * in.color.a;
    return vec4<f32>(in.color.rgb * a, a);
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    vp: [f32; 2],
    atlas: [f32; 2],
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// 디버그 화면 덤프에서만 읽는다.
    #[cfg_attr(not(any(test, debug_assertions)), allow(dead_code))]
    pub format: wgpu::TextureFormat,
    rect_pipeline: wgpu::RenderPipeline,
    glyph_pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    uniforms: wgpu::Buffer,
    atlas_tex: wgpu::Texture,
    rect_buf: wgpu::Buffer,
    rect_cap: usize,
    glyph_buf: wgpu::Buffer,
    glyph_cap: usize,
}

pub struct WindowSurface {
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
}

fn instance() -> wgpu::Instance {
    wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle())
}

impl Gpu {
    /// 창에 그릴 수 있는 GPU와 표면을 만든다.
    pub fn for_window(window: Arc<winit::window::Window>) -> Result<(Self, WindowSurface), String> {
        let instance = instance();
        let surface = instance
            .create_surface(window.clone())
            .map_err(|e| format!("surface: {e}"))?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        }))
        .map_err(|e| format!("adapter: {e}"))?;
        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .or_else(|| caps.formats.first().copied())
            .ok_or("no surface format")?;
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps
                .alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto),
            color_space: Default::default(),
            view_formats: vec![],
        };
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|e| format!("device: {e}"))?;
        surface.configure(&device, &config);
        Ok((
            Self::build(device, queue, format),
            WindowSurface { surface, config },
        ))
    }

    /// 창 없이 텍스처에 그리는 GPU (테스트/스크린샷용).
    #[cfg(test)]
    pub fn offscreen() -> Result<Self, String> {
        let instance = instance();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: None,
            force_fallback_adapter: false,
            apply_limit_buckets: false,
        }))
        .map_err(|e| format!("adapter: {e}"))?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|e| format!("device: {e}"))?;
        Ok(Self::build(device, queue, wgpu::TextureFormat::Rgba8Unorm))
    }

    fn build(device: wgpu::Device, queue: wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("oop-terminal"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let atlas_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glyph atlas"),
            size: wgpu::Extent3d {
                width: ATLAS_SIZE,
                height: ATLAS_SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let atlas_view = atlas_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bind group"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pipeline layout"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let blend = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let rect_attrs = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4];
        let glyph_attrs = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32x4, 4 => Float32];
        let make =
            |label: &str, vs: &str, fs: &str, stride: usize, attrs: &[wgpu::VertexAttribute]| {
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some(label),
                    layout: Some(&layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some(vs),
                        compilation_options: Default::default(),
                        buffers: &[Some(wgpu::VertexBufferLayout {
                            array_stride: stride as u64,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: attrs,
                        })],
                    },
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some(fs),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format,
                            blend: Some(blend),
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    multiview_mask: None,
                    cache: None,
                })
            };
        let rect_pipeline = make(
            "rects",
            "vs_rect",
            "fs_rect",
            std::mem::size_of::<RectInst>(),
            &rect_attrs,
        );
        let glyph_pipeline = make(
            "glyphs",
            "vs_glyph",
            "fs_glyph",
            std::mem::size_of::<GlyphInst>(),
            &glyph_attrs,
        );
        let buf = |label: &str, bytes: usize| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: bytes as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let rect_cap = 4096;
        let glyph_cap = 4096;
        let rect_buf = buf("rects", rect_cap * std::mem::size_of::<RectInst>());
        let glyph_buf = buf("glyphs", glyph_cap * std::mem::size_of::<GlyphInst>());
        Self {
            device,
            queue,
            format,
            rect_pipeline,
            glyph_pipeline,
            bind_group,
            uniforms,
            atlas_tex,
            rect_buf,
            rect_cap,
            glyph_buf,
            glyph_cap,
        }
    }

    pub fn upload_atlas(&self, uploads: &mut Vec<Upload>) {
        for u in uploads.drain(..) {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.atlas_tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: u.x,
                        y: u.y,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                &u.rgba,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(4 * u.w),
                    rows_per_image: Some(u.h),
                },
                wgpu::Extent3d {
                    width: u.w,
                    height: u.h,
                    depth_or_array_layers: 1,
                },
            );
        }
    }

    fn ensure_capacity(&mut self, rects: usize, glyphs: usize) {
        if rects > self.rect_cap {
            self.rect_cap = rects.next_power_of_two();
            self.rect_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("rects"),
                size: (self.rect_cap * std::mem::size_of::<RectInst>()) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        if glyphs > self.glyph_cap {
            self.glyph_cap = glyphs.next_power_of_two();
            self.glyph_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("glyphs"),
                size: (self.glyph_cap * std::mem::size_of::<GlyphInst>()) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
    }

    /// 프레임을 `view`(크기 `size`)에 그린다.
    pub fn draw(&mut self, view: &wgpu::TextureView, size: (u32, u32), frame: &Frame) {
        let n_under = frame.rects_under.len();
        let total_rects = n_under + frame.rects_over.len();
        self.ensure_capacity(total_rects, frame.glyphs.len());
        let u = Uniforms {
            vp: [size.0 as f32, size.1 as f32],
            atlas: [ATLAS_SIZE as f32, ATLAS_SIZE as f32],
        };
        self.queue
            .write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&u));
        if total_rects > 0 {
            let mut all = Vec::with_capacity(total_rects);
            all.extend_from_slice(&frame.rects_under);
            all.extend_from_slice(&frame.rects_over);
            self.queue
                .write_buffer(&self.rect_buf, 0, bytemuck::cast_slice(&all));
        }
        if !frame.glyphs.is_empty() {
            self.queue
                .write_buffer(&self.glyph_buf, 0, bytemuck::cast_slice(&frame.glyphs));
        }
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame"),
            });
        {
            let c = frame.clear;
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("frame"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: c[0] as f64,
                            g: c[1] as f64,
                            b: c[2] as f64,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_bind_group(0, &self.bind_group, &[]);
            if n_under > 0 {
                pass.set_pipeline(&self.rect_pipeline);
                pass.set_vertex_buffer(0, self.rect_buf.slice(..));
                pass.draw(0..6, 0..n_under as u32);
            }
            if !frame.glyphs.is_empty() {
                pass.set_pipeline(&self.glyph_pipeline);
                pass.set_vertex_buffer(0, self.glyph_buf.slice(..));
                pass.draw(0..6, 0..frame.glyphs.len() as u32);
            }
            if total_rects > n_under {
                pass.set_pipeline(&self.rect_pipeline);
                pass.set_vertex_buffer(0, self.rect_buf.slice(..));
                pass.draw(0..6, n_under as u32..total_rects as u32);
            }
        }
        self.queue.submit([encoder.finish()]);
    }

    /// 오프스크린 텍스처에 그리고 RGBA 픽셀을 읽어 온다 (테스트와 디버그 화면 덤프용).
    #[cfg(any(test, debug_assertions))]
    pub fn render_to_rgba(&mut self, size: (u32, u32), frame: &Frame) -> Vec<u8> {
        let tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("offscreen"),
            size: wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        self.draw(&view, size, frame);
        let row = (size.0 * 4).next_multiple_of(256);
        let out = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: (row * size.1) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("readback"),
            });
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &out,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: Some(size.1),
                },
            },
            wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([enc.finish()]);
        let slice = out.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv().expect("map callback").expect("map");
        let data = slice.get_mapped_range().expect("mapped range");
        let mut pixels = Vec::with_capacity((size.0 * size.1 * 4) as usize);
        for y in 0..size.1 {
            let start = (y * row) as usize;
            pixels.extend_from_slice(&data[start..start + (size.0 * 4) as usize]);
        }
        drop(data);
        out.unmap();
        pixels
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 창 없이 그려서 픽셀을 읽는다: 배경 + 사각형 하나. GPU 가 없으면 건너뛴다.
    #[test]
    fn offscreen_render_draws_rect_over_clear_color() {
        let Ok(mut gpu) = Gpu::offscreen() else {
            eprintln!("GPU 어댑터 없음: 건너뜀");
            return;
        };
        let mut frame = Frame {
            clear: [0.0, 0.0, 1.0, 1.0],
            ..Frame::default()
        };
        frame.rects_under.push(RectInst {
            pos: [8.0, 8.0],
            size: [16.0, 16.0],
            color: [1.0, 0.0, 0.0, 1.0],
        });
        let px = gpu.render_to_rgba((64, 64), &frame);
        assert_eq!(px.len(), 64 * 64 * 4);
        let at = |x: usize, y: usize| &px[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4];
        let (red_rgba, red_bgra) = (
            |c: &[u8]| c[0] > 200 && c[1] < 10 && c[2] < 10,
            |c: &[u8]| c[2] > 200 && c[1] < 10 && c[0] < 10,
        );
        let blue = |c: &[u8]| (c[2] > 200 && c[0] < 10) || (c[0] > 200 && c[2] < 10);
        let inside = at(16, 16);
        assert!(
            red_rgba(inside) || red_bgra(inside),
            "안쪽 픽셀: {inside:?}"
        );
        assert!(blue(at(2, 2)), "바깥 픽셀: {:?}", at(2, 2));
        assert!(blue(at(40, 40)), "바깥 픽셀: {:?}", at(40, 40));
    }
}
