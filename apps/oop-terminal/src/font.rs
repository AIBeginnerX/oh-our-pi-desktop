//! 글꼴 탐색/셰이핑(cosmic-text) + 글리프 래스터화(swash) + 아틀라스 패킹.
//!
//! 터미널은 셀 격자가 우선이므로 글리프를 한 글자씩 래스터화해 격자에 직접 놓는다.
//! (glyphon 같은 문단 레이아웃은 폴백 글꼴의 advance 차이로 격자가 어긋난다.)

use std::collections::HashMap;
use std::path::Path;

use cosmic_text::{
    Attrs, Buffer, Family, FontSystem, Metrics, Shaping, Stretch, Style, SwashCache, SwashContent,
    Weight, fontdb,
};

pub const ATLAS_SIZE: u32 = 2048;

/// 셀(물리 픽셀) 크기와 기준선.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellMetrics {
    pub cell_w: u32,
    pub cell_h: u32,
    /// 셀 위쪽에서 기준선까지 거리
    pub baseline: i32,
    /// 밑줄/취소선 두께
    pub line: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct GlyphKey {
    pub ch: char,
    pub bold: bool,
    pub italic: bool,
}

/// 아틀라스에 올라간 글리프.
#[derive(Clone, Copy, Debug)]
pub struct Entry {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// 그리기 위치 = (셀 x + left, 셀 y + baseline - top)
    pub left: i32,
    pub top: i32,
    /// 글꼴이 정한 advance (물리 px)
    pub advance: f32,
    /// 컬러 글리프(이모지)면 true: 색을 곱하지 않는다
    pub color: bool,
}

pub struct Upload {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

struct Shelf {
    x: u32,
    y: u32,
    row_h: u32,
}

pub struct Atlas {
    shelf: Shelf,
    pub uploads: Vec<Upload>,
    pub generation: u32,
}

impl Atlas {
    fn new() -> Self {
        Self {
            shelf: Shelf {
                x: 1,
                y: 1,
                row_h: 0,
            },
            uploads: Vec::new(),
            generation: 0,
        }
    }

    fn alloc(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        if w + 2 > ATLAS_SIZE || h + 2 > ATLAS_SIZE {
            return None;
        }
        let s = &mut self.shelf;
        if s.x + w + 1 > ATLAS_SIZE {
            s.y += s.row_h + 1;
            s.x = 1;
            s.row_h = 0;
        }
        if s.y + h + 1 > ATLAS_SIZE {
            return None;
        }
        let pos = (s.x, s.y);
        s.x += w + 1;
        s.row_h = s.row_h.max(h);
        Some(pos)
    }

    /// `alloc`, and when the atlas is full, start it over once (the glyphs drawn from it must then be
    /// rasterized again). The flag says it was started over.
    fn alloc_or_reset(&mut self, w: u32, h: u32) -> Option<((u32, u32), bool)> {
        if let Some(pos) = self.alloc(w, h) {
            return Some((pos, false));
        }
        if w + 2 > ATLAS_SIZE || h + 2 > ATLAS_SIZE {
            return None;
        }
        self.reset();
        self.alloc(w, h).map(|pos| (pos, true))
    }

    fn reset(&mut self) {
        self.shelf = Shelf {
            x: 1,
            y: 1,
            row_h: 0,
        };
        self.uploads.clear();
        self.generation += 1;
    }
}

pub struct Fonts {
    fs: FontSystem,
    swash: SwashCache,
    buffer: Buffer,
    family: Family<'static>,
    family_name: Option<String>,
    size_px: f32,
    metrics: CellMetrics,
    cache: HashMap<GlyphKey, Option<Entry>>,
    /// boxdraw 가 만든 마스크 (호/대각선) 캐시
    masks: HashMap<(char, u32, u32), Entry>,
    pub atlas: Atlas,
}

#[cfg(target_os = "macos")]
const FONT_FILES: &[&str] = &[
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Apple Color Emoji.ttc",
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/CJKSymbolsFallback.ttc",
    "/System/Library/Fonts/Geneva.ttf",
];
#[cfg(not(target_os = "macos"))]
const FONT_FILES: &[&str] = &[];

const PREFERRED_MONO: &[&str] = &[
    "Menlo",
    "SF Mono",
    "Consolas",
    "DejaVu Sans Mono",
    "Liberation Mono",
    "Noto Sans Mono",
    "Cascadia Mono",
    "Courier New",
];

fn build_db() -> fontdb::Database {
    let mut db = fontdb::Database::new();
    let mut loaded = 0;
    for f in FONT_FILES {
        if Path::new(f).exists() && db.load_font_file(f).is_ok() {
            loaded += 1;
        }
    }
    // 알려진 파일이 없으면(Linux/Windows 등) 시스템 글꼴 전체를 읽는다.
    if loaded == 0 {
        db.load_system_fonts();
    }
    db
}

fn pick_family(db: &fontdb::Database) -> Option<String> {
    PREFERRED_MONO.iter().find_map(|want| {
        db.faces().find_map(|f| {
            f.families
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(want))
                .map(|(n, _)| n.clone())
        })
    })
}

impl Fonts {
    pub fn new(size_px: f32) -> Self {
        let db = build_db();
        let family_name = pick_family(&db);
        let mut fs = FontSystem::new_with_locale_and_db("ko".to_string(), db);
        let buffer = Buffer::new(&mut fs, Metrics::new(size_px, (size_px * 1.4).ceil()));
        let mut me = Self {
            fs,
            swash: SwashCache::new(),
            buffer,
            family: Family::Monospace,
            family_name,
            size_px,
            metrics: CellMetrics {
                cell_w: 1,
                cell_h: 1,
                baseline: 1,
                line: 1,
            },
            cache: HashMap::new(),
            masks: HashMap::new(),
            atlas: Atlas::new(),
        };
        me.measure();
        me
    }

    pub fn metrics(&self) -> CellMetrics {
        self.metrics
    }

    /// 글꼴 크기를 바꾸고 캐시를 비운다.
    pub fn set_size_px(&mut self, size_px: f32) {
        self.size_px = size_px;
        self.cache.clear();
        self.masks.clear();
        self.atlas.reset();
        self.measure();
    }

    fn attrs(&self, bold: bool, italic: bool) -> Attrs<'_> {
        let family = match &self.family_name {
            Some(n) => Family::Name(n.as_str()),
            None => self.family,
        };
        Attrs::new()
            .family(family)
            .weight(if bold { Weight::BOLD } else { Weight::NORMAL })
            .style(if italic { Style::Italic } else { Style::Normal })
            .stretch(Stretch::Normal)
    }

    fn measure(&mut self) {
        let lh = (self.size_px * 1.4).ceil();
        self.buffer.set_metrics(Metrics::new(self.size_px, lh));
        self.buffer.set_size(None, None);
        let attrs = self.attrs_owned(false, false);
        self.buffer
            .set_text("M", &attrs.as_attrs(), Shaping::Advanced, None);
        self.buffer.shape_until_scroll(&mut self.fs, false);
        let mut adv = self.size_px * 0.6;
        if let Some(run) = self.buffer.layout_runs().next()
            && let Some(g) = run.glyphs.first()
        {
            adv = g.w;
        }
        let (mut asc, mut desc) = (self.size_px * 0.9, self.size_px * 0.25);
        if let Some(lines) = self.buffer.line_layout(&mut self.fs, 0)
            && let Some(l) = lines.first()
        {
            asc = l.max_ascent;
            desc = l.max_descent;
        }
        let cell_w = adv.round().max(1.0) as u32;
        let cell_h = (asc + desc).ceil().max(2.0) as u32;
        self.metrics = CellMetrics {
            cell_w,
            cell_h,
            baseline: asc.round() as i32,
            line: ((self.size_px / 14.0).round() as u32).max(1),
        };
    }

    fn attrs_owned(&self, bold: bool, italic: bool) -> cosmic_text::AttrsOwned {
        cosmic_text::AttrsOwned::new(&self.attrs(bold, italic))
    }

    /// 글리프를 래스터화해 아틀라스에 올리고 캐시한다. 빈 글리프(공백 등)는 None.
    pub fn glyph(&mut self, key: GlyphKey) -> Option<Entry> {
        if let Some(e) = self.cache.get(&key) {
            return *e;
        }
        let entry = self.rasterize(key);
        self.cache.insert(key, entry);
        entry
    }

    fn rasterize(&mut self, key: GlyphKey) -> Option<Entry> {
        let attrs = self.attrs_owned(key.bold, key.italic);
        let mut text = [0u8; 4];
        self.buffer.set_text(
            key.ch.encode_utf8(&mut text),
            &attrs.as_attrs(),
            Shaping::Advanced,
            None,
        );
        self.buffer.shape_until_scroll(&mut self.fs, false);
        let (cache_key, advance) = {
            let run = self.buffer.layout_runs().next()?;
            let g = run.glyphs.first()?;
            (g.physical((0.0, 0.0), 1.0).cache_key, g.w)
        };
        let image = self.swash.get_image(&mut self.fs, cache_key).as_ref()?;
        let (w, h) = (image.placement.width, image.placement.height);
        if w == 0 || h == 0 {
            return None;
        }
        let (rgba, color) = match image.content {
            SwashContent::Mask => {
                let mut v = Vec::with_capacity((w * h * 4) as usize);
                for a in &image.data {
                    v.extend_from_slice(&[255, 255, 255, *a]);
                }
                (v, false)
            }
            SwashContent::SubpixelMask => {
                let mut v = Vec::with_capacity((w * h * 4) as usize);
                for px in image.data.chunks_exact(4) {
                    let a = ((px[0] as u32 + px[1] as u32 + px[2] as u32) / 3) as u8;
                    v.extend_from_slice(&[255, 255, 255, a]);
                }
                (v, false)
            }
            SwashContent::Color => (image.data.clone(), true),
        };
        let (left, top) = (image.placement.left, image.placement.top);
        let (x, y) = self.place(w, h, rgba)?;
        Some(Entry {
            x,
            y,
            w,
            h,
            left,
            top,
            advance,
            color,
        })
    }

    fn place(&mut self, w: u32, h: u32, rgba: Vec<u8>) -> Option<(u32, u32)> {
        let ((x, y), restarted) = self.atlas.alloc_or_reset(w, h)?;
        if restarted {
            // The cached positions pointed into what was dropped; the scene builds the frame again.
            self.cache.clear();
            self.masks.clear();
        }
        self.atlas.uploads.push(Upload { x, y, w, h, rgba });
        Some((x, y))
    }

    /// 호/대각선 같은 셀 크기 알파 마스크를 아틀라스에 올린다.
    pub fn mask(&mut self, ch: char, w: u32, h: u32, alpha: &[u8]) -> Option<Entry> {
        if let Some(e) = self.masks.get(&(ch, w, h)) {
            return Some(*e);
        }
        let mut rgba = Vec::with_capacity(alpha.len() * 4);
        for a in alpha {
            rgba.extend_from_slice(&[255, 255, 255, *a]);
        }
        let (x, y) = self.place(w, h, rgba)?;
        let e = Entry {
            x,
            y,
            w,
            h,
            left: 0,
            top: 0,
            advance: w as f32,
            color: false,
        };
        self.masks.insert((ch, w, h), e);
        Some(e)
    }

    pub fn atlas_generation(&self) -> u32 {
        self.atlas.generation
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn fonts() -> Fonts {
        Fonts::new(28.0)
    }

    #[test]
    fn cell_metrics_are_sane_for_retina_size() {
        let f = fonts();
        let m = f.metrics();
        assert!(m.cell_w >= 12 && m.cell_w <= 20, "{m:?}");
        assert!(m.cell_h > m.cell_w && m.cell_h < 50, "{m:?}");
        assert!(m.baseline > 0 && (m.baseline as u32) < m.cell_h, "{m:?}");
    }

    #[test]
    fn latin_glyph_rasterizes_inside_the_cell_height() {
        let mut f = fonts();
        let m = f.metrics();
        let e = f
            .glyph(GlyphKey {
                ch: 'M',
                bold: false,
                italic: false,
            })
            .expect("M");
        assert!(e.w > 0 && e.h > 0);
        assert!(e.top > 0 && (e.top as u32) <= m.cell_h);
        assert!((e.advance - m.cell_w as f32).abs() < 1.0, "고정폭 advance");
    }

    #[test]
    fn korean_falls_back_to_a_hangul_font_and_is_about_two_cells_wide() {
        let mut f = fonts();
        let m = f.metrics();
        let e = f
            .glyph(GlyphKey {
                ch: '한',
                bold: false,
                italic: false,
            })
            .expect("한 글리프가 있어야 한다 (한글 폴백)");
        assert!(
            e.w > m.cell_w / 2,
            "한글 글리프 비트맵이 비어 있지 않다: {e:?}"
        );
        assert!(
            e.advance > m.cell_w as f32 * 1.3,
            "한글 advance는 한 셀보다 넓다: {} vs {}",
            e.advance,
            m.cell_w
        );
        assert!(e.advance < m.cell_w as f32 * 2.4);
    }

    #[test]
    fn bold_and_regular_are_cached_separately() {
        let mut f = fonts();
        let a = f
            .glyph(GlyphKey {
                ch: 'A',
                bold: false,
                italic: false,
            })
            .unwrap();
        let b = f
            .glyph(GlyphKey {
                ch: 'A',
                bold: true,
                italic: false,
            })
            .unwrap();
        assert!((a.x, a.y) != (b.x, b.y));
    }

    #[test]
    fn space_has_no_bitmap() {
        let mut f = fonts();
        assert!(
            f.glyph(GlyphKey {
                ch: ' ',
                bold: false,
                italic: false
            })
            .is_none()
        );
    }

    #[test]
    fn color_emoji_is_flagged_color_and_bounded() {
        let mut f = fonts();
        let m = f.metrics();
        if let Some(e) = f.glyph(GlyphKey {
            ch: '😀',
            bold: false,
            italic: false,
        }) {
            assert!(e.color);
            assert!(e.w <= m.cell_w * 4, "이모지가 지나치게 크다: {e:?}");
        }
    }

    #[test]
    fn atlas_shelf_packing_never_overlaps_and_resets() {
        let mut a = Atlas::new();
        let p1 = a.alloc(100, 50).unwrap();
        let p2 = a.alloc(100, 50).unwrap();
        assert_ne!(p1, p2);
        assert!(p2.0 >= p1.0 + 100);
        while a.alloc(500, 500).is_some() {}
        assert!(a.alloc(500, 500).is_none());
        a.reset();
        assert!(a.alloc(500, 500).is_some());
        assert_eq!(a.generation, 1);
    }

    #[test]
    fn a_full_atlas_starts_over_instead_of_dropping_glyphs() {
        let mut a = Atlas::new();
        let mut restarted = false;
        for _ in 0..100 {
            let (_, again) = a.alloc_or_reset(500, 500).unwrap();
            if again {
                restarted = true;
                break;
            }
        }
        assert!(restarted);
        assert_eq!(a.generation, 1);
        // A glyph that could never fit stays refused and does not wipe the atlas.
        assert!(a.alloc_or_reset(ATLAS_SIZE, 10).is_none());
        assert_eq!(a.generation, 1);
    }
}
