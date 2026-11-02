//! pane 들의 화면 상태를 GPU 인스턴스 목록(`Frame`)으로 바꾼다.

use std::collections::HashMap;

use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::vte::ansi::{CursorShape, Rgb};
use unicode_width::UnicodeWidthChar;

use crate::boxdraw::{self, Drawn};
use crate::font::{CellMetrics, Fonts, GlyphKey};
use crate::gpu::{Frame, GlyphInst, RectInst};
use crate::ime::ImeState;
use crate::layout::{Divider, PaneId, Rect};
use crate::pane::Pane;
use crate::theme;

/// pane 안쪽 여백 (논리 px)
pub const PAD: f32 = 6.0;
/// pane 사이 간격 (논리 px)
pub const GAP: f32 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaneGeom {
    pub x: f32,
    pub y: f32,
    pub cols: u16,
    pub rows: u16,
}

/// pane 영역 안에서 글자 격자의 원점과 크기.
pub fn geometry(rect: Rect, scale: f32, m: &CellMetrics) -> PaneGeom {
    let pad = (PAD * scale).round();
    let inner_w = (rect.w - 2.0 * pad).max(0.0);
    let inner_h = (rect.h - 2.0 * pad).max(0.0);
    let cols = ((inner_w / m.cell_w as f32).floor() as u16).max(1);
    let rows = ((inner_h / m.cell_h as f32).floor() as u16).max(1);
    PaneGeom {
        x: (rect.x + pad).round(),
        y: (rect.y + pad).round(),
        cols,
        rows,
    }
}

pub struct ViewState<'a> {
    pub fonts: &'a mut Fonts,
    pub scale: f32,
    pub window_focused: bool,
    pub blink_on: bool,
    pub ime: &'a ImeState,
    pub focus: PaneId,
    pub active_divider: Option<&'a [bool]>,
}

#[derive(Default, Debug)]
pub struct SceneOut {
    /// IME 후보창을 띄울 위치 (물리 px: x, y, w, h)
    pub ime_area: Option<(f32, f32, f32, f32)>,
}

fn color(c: Rgb) -> [f32; 4] {
    theme::to_f32(c)
}

fn rect_inst(x: f32, y: f32, w: f32, h: f32, c: [f32; 4]) -> RectInst {
    RectInst {
        pos: [x, y],
        size: [w, h],
        color: c,
    }
}

fn border(out: &mut Vec<RectInst>, r: Rect, t: f32, c: [f32; 4]) {
    out.push(rect_inst(r.x, r.y, r.w, t, c));
    out.push(rect_inst(r.x, r.bottom() - t, r.w, t, c));
    out.push(rect_inst(r.x, r.y + t, t, r.h - 2.0 * t, c));
    out.push(rect_inst(r.right() - t, r.y + t, t, r.h - 2.0 * t, c));
}

/// 프레임 전체를 만든다. 아틀라스가 가득 차 비워졌다면 한 번 더 만든다.
pub fn build(
    frame: &mut Frame,
    view: &mut ViewState,
    panes: &HashMap<PaneId, Pane>,
    rects: &[(PaneId, Rect)],
    dividers: &[Divider],
) -> SceneOut {
    for _ in 0..2 {
        let generation = view.fonts.atlas_generation();
        frame.clear();
        let out = build_once(frame, view, panes, rects, dividers);
        if view.fonts.atlas_generation() == generation {
            return out;
        }
    }
    SceneOut::default()
}

fn build_once(
    frame: &mut Frame,
    view: &mut ViewState,
    panes: &HashMap<PaneId, Pane>,
    rects: &[(PaneId, Rect)],
    dividers: &[Divider],
) -> SceneOut {
    frame.clear = theme::to_f32(theme::BACKGROUND);
    let mut out = SceneOut::default();
    let m = view.fonts.metrics();
    let multi = rects.len() > 1;
    let scale = view.scale;
    let line_t = scale.round().max(1.0);

    for d in dividers {
        let active = view.active_divider == Some(d.path.as_slice());
        if active {
            frame.rects_under.push(rect_inst(
                d.rect.x,
                d.rect.y,
                d.rect.w,
                d.rect.h,
                color(theme::BRAND_DIM),
            ));
        }
    }

    for (id, rect) in rects {
        let Some(pane) = panes.get(id) else { continue };
        let focused = *id == view.focus;
        let g = geometry(*rect, scale, &m);
        draw_pane(frame, view, pane, g, focused, &m, &mut out);
        if multi {
            if focused {
                let c = if view.window_focused {
                    theme::BRAND
                } else {
                    theme::BRAND_DIM
                };
                border(
                    &mut frame.rects_over,
                    *rect,
                    (2.0 * scale).round().max(2.0),
                    color(c),
                );
            } else {
                border(&mut frame.rects_over, *rect, line_t, color(theme::BORDER));
            }
        }
    }
    out
}

fn draw_pane(
    frame: &mut Frame,
    view: &mut ViewState,
    pane: &Pane,
    g: PaneGeom,
    focused: bool,
    m: &CellMetrics,
    out: &mut SceneOut,
) {
    let cw = m.cell_w as f32;
    let ch = m.cell_h as f32;
    let term = pane.term.lock();
    let content = term.renderable_content();
    let offset = content.display_offset as i32;
    let colors = content.colors;
    let selection = content.selection;
    let cursor_shape = content.cursor.shape;
    let cursor_row = content.cursor.point.line.0 + offset;
    let cursor_col = content.cursor.point.column.0;
    let show_cursor = content
        .mode
        .contains(alacritty_terminal::term::TermMode::SHOW_CURSOR)
        && cursor_shape != CursorShape::Hidden
        && (0..g.rows as i32).contains(&cursor_row);
    let pane_active = focused && view.window_focused;
    let cursor_on = show_cursor && (view.blink_on || !pane_active);
    let block = cursor_on && pane_active && cursor_shape == CursorShape::Block;

    // IME 조합 중인 글자는 커서 위치에 덮어 그린다.
    let preedit: Option<(Vec<(char, usize)>, usize)> = if pane_active && show_cursor {
        view.ime.preedit().map(|s| {
            let mut cells = Vec::new();
            let mut used = 0usize;
            for c in s.chars() {
                let w = c.width().unwrap_or(1).max(1);
                if cursor_col + used + w > g.cols as usize {
                    break;
                }
                cells.push((c, w));
                used += w;
            }
            (cells, used)
        })
    } else {
        None
    };
    let preedit_span = preedit
        .as_ref()
        .map(|(_, used)| (cursor_row, cursor_col, cursor_col + used));

    let mut last_bg: Option<(f32, f32, [f32; 4], usize)> = None; // (y, x_end, color, rects_under index)
    let mut block_wide_until: Option<(i32, usize)> = None;

    for indexed in content.display_iter {
        let row = indexed.point.line.0 + offset;
        if row < 0 || row >= g.rows as i32 {
            continue;
        }
        let col = indexed.point.column.0;
        if col >= g.cols as usize {
            continue;
        }
        let cell = indexed.cell;
        let x = g.x + col as f32 * cw;
        let y = g.y + row as f32 * ch;
        let covered_by_preedit =
            preedit_span.is_some_and(|(r, c0, c1)| row == r && col >= c0 && col < c1);
        let spacer = cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER);
        let wide = cell.flags.contains(Flags::WIDE_CHAR);

        let dim = cell.flags.contains(Flags::DIM);
        let mut fg = theme::resolve(cell.fg, colors, dim);
        let mut bg = theme::resolve(cell.bg, colors, false);
        if cell.flags.contains(Flags::INVERSE) {
            std::mem::swap(&mut fg, &mut bg);
        }
        let selected = selection.is_some_and(|s| s.contains(indexed.point));
        if selected {
            bg = theme::SELECTION_BG;
            fg = theme::SELECTION_FG;
        }
        let at_cursor = row == cursor_row && col == cursor_col;
        if block && (at_cursor || block_wide_until == Some((row, col))) {
            bg = theme::BRAND;
            fg = theme::BACKGROUND;
            if at_cursor && wide {
                block_wide_until = Some((row, col + 1));
            }
        }
        if covered_by_preedit {
            continue;
        }

        if bg != theme::BACKGROUND {
            let c = color(bg);
            match &mut last_bg {
                Some((ly, lx, lc, idx)) if *ly == y && (*lx - x).abs() < 0.5 && *lc == c => {
                    frame.rects_under[*idx].size[0] += cw;
                    *lx += cw;
                }
                _ => {
                    frame.rects_under.push(rect_inst(x, y, cw, ch, c));
                    last_bg = Some((y, x + cw, c, frame.rects_under.len() - 1));
                }
            }
        } else {
            last_bg = None;
        }

        if spacer || cell.flags.contains(Flags::HIDDEN) {
            continue;
        }
        let c = cell.c;
        if c != ' ' && c != '\0' {
            emit_char(frame, view.fonts, c, cell.flags, wide, x, y, color(fg), m);
        }
        let uc = color(fg);
        if cell.flags.intersects(Flags::ALL_UNDERLINES) {
            let uy = (y + m.baseline as f32 + m.line as f32).min(y + ch - m.line as f32);
            let w = if wide { 2.0 * cw } else { cw };
            frame
                .rects_over
                .push(rect_inst(x, uy, w, m.line as f32, uc));
            if cell.flags.contains(Flags::DOUBLE_UNDERLINE) {
                frame
                    .rects_over
                    .push(rect_inst(x, uy - 2.0 * m.line as f32, w, m.line as f32, uc));
            }
        }
        if cell.flags.contains(Flags::STRIKEOUT) {
            let w = if wide { 2.0 * cw } else { cw };
            frame.rects_over.push(rect_inst(
                x,
                y + (m.baseline as f32 * 0.6).round(),
                w,
                m.line as f32,
                uc,
            ));
        }
    }
    drop(term);

    // 커서 (블록은 위에서 셀 색으로 처리했으므로 나머지 모양만)
    if cursor_on {
        let cx = g.x + cursor_col as f32 * cw;
        let cy = g.y + cursor_row as f32 * ch;
        let c = color(theme::BRAND);
        if !pane_active {
            border(
                &mut frame.rects_over,
                Rect::new(cx, cy, cw, ch),
                m.line as f32,
                c,
            );
        } else {
            match cursor_shape {
                CursorShape::Beam => {
                    frame
                        .rects_over
                        .push(rect_inst(cx, cy, (m.line as f32 * 2.0).max(2.0), ch, c))
                }
                CursorShape::Underline => frame.rects_over.push(rect_inst(
                    cx,
                    cy + ch - (m.line as f32 * 2.0).max(2.0),
                    cw,
                    (m.line as f32 * 2.0).max(2.0),
                    c,
                )),
                CursorShape::HollowBlock => border(
                    &mut frame.rects_over,
                    Rect::new(cx, cy, cw, ch),
                    m.line as f32,
                    c,
                ),
                CursorShape::Block | CursorShape::Hidden => {}
            }
        }
    }

    if let (Some((cells, used)), true) = (preedit.as_ref(), pane_active) {
        let start_x = g.x + cursor_col as f32 * cw;
        let y = g.y + cursor_row as f32 * ch;
        if *used > 0 {
            frame.rects_under.push(rect_inst(
                start_x,
                y,
                *used as f32 * cw,
                ch,
                color(theme::PREEDIT_BG),
            ));
            frame.rects_over.push(rect_inst(
                start_x,
                y + ch - m.line as f32,
                *used as f32 * cw,
                m.line as f32,
                color(theme::BRAND),
            ));
        }
        let mut x = start_x;
        let caret = view.ime.preedit_cursor_chars().min(cells.len());
        let mut caret_x = start_x + *used as f32 * cw;
        for (i, (c, w)) in cells.iter().enumerate() {
            if i == caret {
                caret_x = x;
            }
            emit_char(
                frame,
                view.fonts,
                *c,
                Flags::empty(),
                *w == 2,
                x,
                y,
                color(theme::FOREGROUND),
                m,
            );
            x += *w as f32 * cw;
        }
        frame.rects_over.push(rect_inst(
            caret_x,
            y,
            (m.line as f32 * 2.0).max(2.0),
            ch,
            color(theme::BRAND),
        ));
        out.ime_area = Some((start_x, y, (*used as f32 * cw).max(cw), ch));
    } else if pane_active && show_cursor {
        out.ime_area = Some((
            g.x + cursor_col as f32 * cw,
            g.y + cursor_row as f32 * ch,
            cw,
            ch,
        ));
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_char(
    frame: &mut Frame,
    fonts: &mut Fonts,
    c: char,
    flags: Flags,
    wide: bool,
    x: f32,
    y: f32,
    fg: [f32; 4],
    m: &CellMetrics,
) {
    let cell_w = if wide { 2 * m.cell_w } else { m.cell_w };
    let t = boxdraw::light_thickness(m.cell_h);
    if let Some(drawn) = boxdraw::glyph(c, cell_w, m.cell_h, t) {
        match drawn {
            Drawn::Rects(rs) => {
                for r in rs {
                    let mut col = fg;
                    col[3] *= r.alpha as f32 / 255.0;
                    frame.rects_over.push(rect_inst(
                        x + r.x0 as f32,
                        y + r.y0 as f32,
                        (r.x1 - r.x0) as f32,
                        (r.y1 - r.y0) as f32,
                        col,
                    ));
                }
            }
            Drawn::Mask { w, h, alpha } => {
                if let Some(e) = fonts.mask(c, w, h, &alpha) {
                    push_glyph(frame, &e, x, y, 0.0, fg, m, true);
                }
            }
        }
        return;
    }
    let key = GlyphKey {
        ch: c,
        bold: flags.contains(Flags::BOLD),
        italic: flags.contains(Flags::ITALIC),
    };
    if let Some(e) = fonts.glyph(key) {
        let off = if wide {
            ((cell_w as f32 - e.advance) / 2.0).round().max(0.0)
        } else {
            0.0
        };
        push_glyph(frame, &e, x, y, off, fg, m, false);
    }
}

#[allow(clippy::too_many_arguments)]
fn push_glyph(
    frame: &mut Frame,
    e: &crate::font::Entry,
    x: f32,
    y: f32,
    off: f32,
    fg: [f32; 4],
    m: &CellMetrics,
    cell_aligned: bool,
) {
    let (gx, gy) = if cell_aligned {
        (x, y)
    } else {
        (
            x + off + e.left as f32,
            y + m.baseline as f32 - e.top as f32,
        )
    };
    frame.glyphs.push(GlyphInst {
        pos: [gx, gy],
        size: [e.w as f32, e.h as f32],
        uv: [e.x as f32, e.y as f32, e.w as f32, e.h as f32],
        color: fg,
        color_glyph: if e.color { 1.0 } else { 0.0 },
        _pad: [0.0; 3],
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: CellMetrics = CellMetrics {
        cell_w: 16,
        cell_h: 34,
        baseline: 27,
        line: 2,
    };

    #[test]
    fn geometry_fits_whole_cells_inside_padding() {
        let g = geometry(Rect::new(0.0, 0.0, 1000.0, 700.0), 2.0, &M);
        assert_eq!(g.x, 12.0);
        assert_eq!(g.cols, (976.0f32 / 16.0).floor() as u16);
        assert_eq!(g.rows, (676.0f32 / 34.0).floor() as u16);
    }

    #[test]
    fn geometry_never_returns_zero() {
        let g = geometry(Rect::new(0.0, 0.0, 5.0, 5.0), 2.0, &M);
        assert_eq!((g.cols, g.rows), (1, 1));
    }
}
