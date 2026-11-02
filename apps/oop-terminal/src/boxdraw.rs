//! 박스 드로잉/블록/점자 문자를 폰트 대신 셀 픽셀에 직접 그린다.
//!
//! 폰트 글리프는 줄 간격/셀 크기에 따라 이웃 셀과 틈이 생기므로,
//! 셀 경계까지 정확히 닿는 사각형(또는 호/대각선 마스크)으로 만든다.
//! 이중선(U+2550..256C 일부)은 폰트 글리프에 맡긴다 (`glyph`가 None).

/// 셀 안의 픽셀 사각형. `alpha`는 0..=255 (음영 문자용).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixRect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    pub alpha: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Drawn {
    Rects(Vec<PixRect>),
    /// 셀 크기의 알파 마스크 (호, 대각선)
    Mask {
        w: u32,
        h: u32,
        alpha: Vec<u8>,
    },
}

/// 선 스타일: 0 없음, 1 가는 선, 2 굵은 선, 3 이중선
type Arms = [u8; 4]; // left, right, up, down

#[rustfmt::skip]
const BOX: [Arms; 0x50] = [
    [1,1,0,0],[2,2,0,0],[0,0,1,1],[0,0,2,2],[1,1,0,0],[2,2,0,0],[0,0,1,1],[0,0,2,2], // 2500
    [1,1,0,0],[2,2,0,0],[0,0,1,1],[0,0,2,2],[0,1,0,1],[0,2,0,1],[0,1,0,2],[0,2,0,2], // 2508
    [1,0,0,1],[2,0,0,1],[1,0,0,2],[2,0,0,2],[0,1,1,0],[0,2,1,0],[0,1,2,0],[0,2,2,0], // 2510
    [1,0,1,0],[2,0,1,0],[1,0,2,0],[2,0,2,0],[0,1,1,1],[0,2,1,1],[0,1,2,1],[0,1,1,2], // 2518
    [0,1,2,2],[0,2,2,1],[0,2,1,2],[0,2,2,2],[1,0,1,1],[2,0,1,1],[1,0,2,1],[1,0,1,2], // 2520
    [1,0,2,2],[2,0,2,1],[2,0,1,2],[2,0,2,2],[1,1,0,1],[2,1,0,1],[1,2,0,1],[2,2,0,1], // 2528
    [1,1,0,2],[2,1,0,2],[1,2,0,2],[2,2,0,2],[1,1,1,0],[2,1,1,0],[1,2,1,0],[2,2,1,0], // 2530
    [1,1,2,0],[2,1,2,0],[1,2,2,0],[2,2,2,0],[1,1,1,1],[2,1,1,1],[1,2,1,1],[2,2,1,1], // 2538
    [1,1,2,1],[1,1,1,2],[1,1,2,2],[2,1,2,1],[1,2,2,1],[2,1,1,2],[1,2,1,2],[2,2,2,1], // 2540
    [2,2,1,2],[2,1,2,2],[1,2,2,2],[2,2,2,2],[1,1,0,0],[2,2,0,0],[0,0,1,1],[0,0,2,2], // 2548
];

fn arms_of(cp: u32) -> Option<Arms> {
    match cp {
        0x2500..=0x254F => Some(BOX[(cp - 0x2500) as usize]),
        0x2574 => Some([1, 0, 0, 0]),
        0x2575 => Some([0, 0, 1, 0]),
        0x2576 => Some([0, 1, 0, 0]),
        0x2577 => Some([0, 0, 0, 1]),
        0x2578 => Some([2, 0, 0, 0]),
        0x2579 => Some([0, 0, 2, 0]),
        0x257A => Some([0, 2, 0, 0]),
        0x257B => Some([0, 0, 0, 2]),
        0x257C => Some([1, 2, 0, 0]),
        0x257D => Some([0, 0, 1, 2]),
        0x257E => Some([2, 1, 0, 0]),
        0x257F => Some([0, 0, 2, 1]),
        _ => None,
    }
}

/// 가는 선 두께(px). 글자 크기에 비례한다.
pub fn light_thickness(cell_h: u32) -> u32 {
    ((cell_h as f32 / 17.0).round() as u32).max(1)
}

fn heavy_of(t: u32) -> u32 {
    if t <= 1 { 2 } else { t + t.div_ceil(2) }
}

fn thickness(style: u8, t: u32) -> u32 {
    match style {
        0 => 0,
        1 => t,
        _ => heavy_of(t),
    }
}

fn rect(x0: u32, y0: u32, x1: u32, y1: u32) -> PixRect {
    PixRect {
        x0,
        y0,
        x1,
        y1,
        alpha: 255,
    }
}

/// 이 문자를 직접 그릴 수 있으면 그리는 방법을 돌려준다.
pub fn glyph(ch: char, w: u32, h: u32, t: u32) -> Option<Drawn> {
    let cp = ch as u32;
    match cp {
        0x2500..=0x254F | 0x2574..=0x257F => {
            let arms = arms_of(cp)?;
            if arms.contains(&3) {
                return None;
            }
            Some(Drawn::Rects(line_rects(arms, w, h, t)))
        }
        0x2550..=0x256C => None, // 이중선: 폰트 글리프 사용
        0x256D..=0x2570 => Some(arc(cp, w, h, t)),
        0x2571..=0x2573 => Some(diagonal(cp, w, h, t)),
        0x2580..=0x259F => Some(Drawn::Rects(block(cp, w, h))),
        0x2800..=0x28FF => Some(Drawn::Rects(braille(cp, w, h))),
        _ => None,
    }
}

fn line_rects(arms: Arms, w: u32, h: u32, t: u32) -> Vec<PixRect> {
    let [l, r, u, d] = arms;
    let vth = thickness(u, t).max(thickness(d, t)); // 세로선 두께 (가로 팔의 연장 기준)
    let hth = thickness(l, t).max(thickness(r, t));
    let cx_lo = (w.saturating_sub(vth)) / 2;
    let cx_hi = cx_lo + vth;
    let cy_lo = (h.saturating_sub(hth)) / 2;
    let cy_hi = cy_lo + hth;
    let mut out = Vec::with_capacity(4);
    // 가로 팔: 두께는 팔 자신의 스타일, 세로 위치는 가운데
    let arm_y = |style: u8| {
        let th = thickness(style, t);
        let y0 = (h.saturating_sub(th)) / 2;
        (y0, y0 + th)
    };
    let arm_x = |style: u8| {
        let th = thickness(style, t);
        let x0 = (w.saturating_sub(th)) / 2;
        (x0, x0 + th)
    };
    if l > 0 {
        let (y0, y1) = arm_y(l);
        out.push(rect(0, y0, cx_hi.max(w / 2), y1));
    }
    if r > 0 {
        let (y0, y1) = arm_y(r);
        out.push(rect(cx_lo.min(w / 2), y0, w, y1));
    }
    if u > 0 {
        let (x0, x1) = arm_x(u);
        out.push(rect(x0, 0, x1, cy_hi.max(h / 2)));
    }
    if d > 0 {
        let (x0, x1) = arm_x(d);
        out.push(rect(x0, cy_lo.min(h / 2), x1, h));
    }
    // 세로선이 없는 단순 가로선(─)의 중앙 틈 방지: l/r 이 모두 있으면 위 규칙으로 이미 이어진다.
    out
}

fn block(cp: u32, w: u32, h: u32) -> Vec<PixRect> {
    let frac = |n: u32, d: u32, total: u32| (total as f32 * n as f32 / d as f32).round() as u32;
    let full = |a: u8| {
        vec![PixRect {
            x0: 0,
            y0: 0,
            x1: w,
            y1: h,
            alpha: a,
        }]
    };
    let (mx, my) = (frac(1, 2, w), frac(1, 2, h));
    match cp {
        0x2580 => vec![rect(0, 0, w, my)],
        0x2581..=0x2587 => {
            let n = cp - 0x2580;
            vec![rect(0, h - frac(n, 8, h), w, h)]
        }
        0x2588 => full(255),
        0x2589..=0x258F => {
            let n = 0x2590 - cp;
            vec![rect(0, 0, frac(n, 8, w), h)]
        }
        0x2590 => vec![rect(mx, 0, w, h)],
        0x2591 => full(64),
        0x2592 => full(128),
        0x2593 => full(192),
        0x2594 => vec![rect(0, 0, w, frac(1, 8, h).max(1))],
        0x2595 => vec![rect(w - frac(1, 8, w).max(1), 0, w, h)],
        0x2596..=0x259F => {
            // UL=1, UR=2, LL=4, LR=8
            let mask = [4u8, 8, 1, 13, 9, 7, 11, 2, 6, 14][(cp - 0x2596) as usize];
            let mut out = Vec::new();
            if mask & 1 != 0 {
                out.push(rect(0, 0, mx, my));
            }
            if mask & 2 != 0 {
                out.push(rect(mx, 0, w, my));
            }
            if mask & 4 != 0 {
                out.push(rect(0, my, mx, h));
            }
            if mask & 8 != 0 {
                out.push(rect(mx, my, w, h));
            }
            out
        }
        _ => Vec::new(),
    }
}

fn braille(cp: u32, w: u32, h: u32) -> Vec<PixRect> {
    let bits = cp - 0x2800;
    let d = (w / 4).max(2);
    // (col, row) 점 배치: 비트 0..7
    const POS: [(u32, u32); 8] = [
        (0, 0),
        (0, 1),
        (0, 2),
        (1, 0),
        (1, 1),
        (1, 2),
        (0, 3),
        (1, 3),
    ];
    let mut out = Vec::new();
    for (bit, (c, r)) in POS.iter().enumerate() {
        if bits & (1 << bit) == 0 {
            continue;
        }
        let cx = w * (2 * c + 1) / 4;
        let cy = h * (2 * r + 1) / 8;
        let x0 = cx.saturating_sub(d / 2).min(w.saturating_sub(d));
        let y0 = cy.saturating_sub(d / 2).min(h.saturating_sub(d));
        out.push(rect(x0, y0, (x0 + d).min(w), (y0 + d).min(h)));
    }
    out
}

fn seg_dist(px: f32, py: f32, a: (f32, f32), b: (f32, f32)) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((px - a.0) * dx + (py - a.1) * dy) / len2).clamp(0.0, 1.0)
    };
    let (qx, qy) = (a.0 + t * dx, a.1 + t * dy);
    ((px - qx).powi(2) + (py - qy).powi(2)).sqrt()
}

fn cover(dist: f32, t: f32) -> u8 {
    ((t / 2.0 + 0.5 - dist).clamp(0.0, 1.0) * 255.0).round() as u8
}

fn arc(cp: u32, w: u32, h: u32, t: u32) -> Drawn {
    // ╭ 256D: 오른쪽+아래, ╮ 256E: 왼쪽+아래, ╯ 256F: 왼쪽+위, ╰ 2570: 오른쪽+위
    let (right, down) = match cp {
        0x256D => (true, true),
        0x256E => (false, true),
        0x256F => (false, false),
        _ => (true, false),
    };
    let tf = t as f32;
    // 직선 팔과 같은 정수 스냅 중심을 쓴다
    let cx = ((w.saturating_sub(t)) / 2) as f32 + tf / 2.0;
    let cy = ((h.saturating_sub(t)) / 2) as f32 + tf / 2.0;
    let (wf, hf) = (w as f32, h as f32);
    let sx = if right { 1.0 } else { -1.0 };
    let sy = if down { 1.0 } else { -1.0 };
    let edge_x = if right { wf } else { 0.0 };
    let edge_y = if down { hf } else { 0.0 };
    let r = (edge_x - cx).abs().min((edge_y - cy).abs());
    let (ccx, ccy) = (cx + sx * r, cy + sy * r);
    let vert = ((cx, cy + sy * r), (cx, edge_y));
    let horiz = ((cx + sx * r, cy), (edge_x, cy));
    let mut alpha = vec![0u8; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let mut d = seg_dist(px, py, vert.0, vert.1).min(seg_dist(px, py, horiz.0, horiz.1));
            if (px - ccx) * sx <= 0.0 && (py - ccy) * sy <= 0.0 {
                d = d.min((((px - ccx).powi(2) + (py - ccy).powi(2)).sqrt() - r).abs());
            }
            alpha[(y * w + x) as usize] = cover(d, tf);
        }
    }
    Drawn::Mask { w, h, alpha }
}

fn diagonal(cp: u32, w: u32, h: u32, t: u32) -> Drawn {
    let (wf, hf, tf) = (w as f32, h as f32, t as f32);
    let mut alpha = vec![0u8; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let mut d = f32::MAX;
            if cp == 0x2571 || cp == 0x2573 {
                d = d.min(seg_dist(px, py, (wf, 0.0), (0.0, hf)));
            }
            if cp == 0x2572 || cp == 0x2573 {
                d = d.min(seg_dist(px, py, (0.0, 0.0), (wf, hf)));
            }
            alpha[(y * w + x) as usize] = cover(d, tf);
        }
    }
    Drawn::Mask { w, h, alpha }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = 16;
    const H: u32 = 34;
    const T: u32 = 2;

    fn rects(ch: char) -> Vec<PixRect> {
        match glyph(ch, W, H, T) {
            Some(Drawn::Rects(r)) => r,
            other => panic!("{ch}: rects 아님: {other:?}"),
        }
    }

    /// 사각형들이 덮는 픽셀 집합 (alpha>0)
    fn coverage(rs: &[PixRect]) -> Vec<Vec<bool>> {
        let mut g = vec![vec![false; W as usize]; H as usize];
        for r in rs {
            for y in r.y0..r.y1 {
                for x in r.x0..r.x1 {
                    g[y as usize][x as usize] = true;
                }
            }
        }
        g
    }

    #[test]
    fn horizontal_line_spans_cell_edge_to_edge_without_gap() {
        let g = coverage(&rects('─'));
        let row = (H / 2) as usize;
        assert!(
            (0..W as usize).all(|x| g[row][x]),
            "가로선은 셀 전체 폭을 덮어야 한다"
        );
        assert!(!g[0][0] && !g[H as usize - 1][0]);
    }

    #[test]
    fn vertical_line_spans_cell_edge_to_edge_without_gap() {
        let g = coverage(&rects('│'));
        let col = (W / 2) as usize;
        assert!(
            (0..H as usize).all(|y| g[y][col]),
            "세로선은 셀 전체 높이를 덮어야 한다"
        );
    }

    #[test]
    fn corner_joins_both_arms_at_the_center() {
        let g = coverage(&rects('┐'));
        let (cx, cy) = ((W / 2) as usize, (H / 2) as usize);
        assert!(g[cy][0] && g[cy][cx]);
        assert!(g[H as usize - 1][cx] && g[cy + 1][cx]);
        assert!(!g[cy][W as usize - 1], "┐ 는 오른쪽으로 뻗지 않는다");
        assert!(!g[0][cx], "┐ 는 위로 뻗지 않는다");
    }

    #[test]
    fn cross_is_symmetric() {
        let g = coverage(&rects('┼'));
        let (cx, cy) = ((W / 2) as usize, (H / 2) as usize);
        assert!(g[cy][0] && g[cy][W as usize - 1] && g[0][cx] && g[H as usize - 1][cx]);
    }

    #[test]
    fn heavy_is_thicker_than_light() {
        let thick = |ch| rects(ch).iter().map(|r| r.y1 - r.y0).max().unwrap();
        assert!(thick('━') > thick('─'));
    }

    #[test]
    fn full_block_covers_everything_and_halves_split() {
        let g = coverage(&rects('█'));
        assert!(g.iter().all(|r| r.iter().all(|&c| c)));
        let upper = coverage(&rects('▀'));
        assert!(upper[0][0] && !upper[H as usize - 1][0]);
        let right = coverage(&rects('▐'));
        assert!(right[0][W as usize - 1] && !right[0][0]);
    }

    #[test]
    fn lower_eighths_grow_monotonically_to_full() {
        let heights: Vec<u32> = ('\u{2581}'..='\u{2588}')
            .map(|c| rects(c).iter().map(|r| r.y1 - r.y0).sum())
            .collect();
        assert!(heights.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(*heights.last().unwrap(), H);
    }

    #[test]
    fn shades_use_alpha() {
        assert_eq!(rects('░')[0].alpha, 64);
        assert_eq!(rects('▒')[0].alpha, 128);
        assert_eq!(rects('▓')[0].alpha, 192);
    }

    #[test]
    fn quadrants_have_expected_cells() {
        assert_eq!(rects('▖').len(), 1);
        assert_eq!(rects('▙').len(), 3);
        assert_eq!(rects('▚').len(), 2);
        let ul = coverage(&rects('▘'));
        assert!(ul[0][0] && !ul[0][W as usize - 1] && !ul[H as usize - 1][0]);
    }

    #[test]
    fn braille_dot_count_matches_bits() {
        assert_eq!(rects('\u{2800}').len(), 0);
        assert_eq!(rects('\u{28FF}').len(), 8);
        assert_eq!(rects('\u{2801}').len(), 1);
        assert_eq!(rects('\u{28C0}').len(), 2);
    }

    #[test]
    fn double_lines_are_left_to_the_font() {
        assert!(glyph('═', W, H, T).is_none());
        assert!(glyph('╔', W, H, T).is_none());
        assert!(glyph('╬', W, H, T).is_none());
    }

    #[test]
    fn non_box_chars_are_not_drawn() {
        assert!(glyph('a', W, H, T).is_none());
        assert!(glyph('한', W, H, T).is_none());
    }

    #[test]
    fn arc_touches_the_edges_where_neighbours_continue() {
        let Some(Drawn::Mask { w, h, alpha }) = glyph('╭', W, H, T) else {
            panic!("mask 기대")
        };
        let at = |x: u32, y: u32| alpha[(y * w + x) as usize];
        let (cx, cy) = ((W - T) / 2, (H - T) / 2);
        assert!(
            at(w - 1, cy) > 100,
            "오른쪽 가장자리 가운데에서 이웃 가로선과 이어진다"
        );
        assert!(
            at(cx, h - 1) > 100,
            "아래쪽 가장자리 가운데에서 이웃 세로선과 이어진다"
        );
        assert_eq!(at(0, 0), 0, "바깥 모서리는 비어 있다");
        assert_eq!(at(w - 1, h - 1), 0);
    }

    #[test]
    fn arc_corners_mirror_correctly() {
        let mass = |ch| match glyph(ch, W, H, T) {
            Some(Drawn::Mask { w, alpha, .. }) => {
                // (왼쪽 절반 합, 위쪽 절반 합)
                let (mut left, mut top) = (0u32, 0u32);
                for (i, a) in alpha.iter().enumerate() {
                    let (x, y) = (i as u32 % w, i as u32 / w);
                    if x < W / 2 {
                        left += *a as u32;
                    }
                    if y < H / 2 {
                        top += *a as u32;
                    }
                }
                (left, top)
            }
            _ => panic!(),
        };
        let (l1, t1) = mass('╭'); // 오른쪽+아래
        let (l2, t2) = mass('╯'); // 왼쪽+위
        assert!(l2 > l1 && t2 > t1);
    }

    #[test]
    fn diagonals_cross_at_center() {
        let Some(Drawn::Mask { w, h, alpha }) = glyph('╳', W, H, T) else {
            panic!()
        };
        assert!(alpha[((h / 2) * w + w / 2) as usize] > 100);
        assert_eq!(alpha[(h / 2 * w) as usize], 0);
    }
}
