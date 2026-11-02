//! 이진 분할 트리 기반 pane 레이아웃. GUI/PTY와 무관한 순수 로직이다.
//!
//! 좌표는 모두 물리 픽셀(f32)이다. 분할은 항상 두 자식으로만 나뉘며,
//! pane을 닫으면 형제 노드가 부모 자리를 이어받는다.

pub type PaneId = u32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    Left,
    Right,
    Up,
    Down,
}

/// `Horizontal`: 자식이 좌우로 나란히. `Vertical`: 위아래로 쌓임.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }

    pub fn contains(&self, px: f32, py: f32) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }
}

#[derive(Debug)]
enum Node {
    Leaf(PaneId),
    Split(Box<Split>),
}

#[derive(Debug)]
struct Split {
    axis: Axis,
    /// first 자식이 차지하는 비율 (0..1, 구분선 제외).
    ratio: f32,
    first: Node,
    second: Node,
}

/// 마우스로 끌 수 있는 구분선.
#[derive(Clone, Debug, PartialEq)]
pub struct Divider {
    /// 루트에서 이 분할 노드까지의 경로 (false = first, true = second).
    pub path: Vec<bool>,
    pub axis: Axis,
    /// 구분선이 차지하는 영역(드래그 hit 영역의 기준).
    pub rect: Rect,
    /// 이 분할 노드가 차지하는 전체 영역.
    pub parent: Rect,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseOutcome {
    /// 닫힘. 새 포커스 pane.
    Closed(PaneId),
    /// 마지막 pane이었다 (창을 닫아야 한다).
    Last,
    /// 존재하지 않는 id.
    Unknown,
}

pub struct Layout {
    root: Node,
    focus: PaneId,
    zoomed: Option<PaneId>,
    next_id: PaneId,
}

impl Layout {
    pub fn new() -> Self {
        Self {
            root: Node::Leaf(0),
            focus: 0,
            zoomed: None,
            next_id: 1,
        }
    }

    pub fn focus(&self) -> PaneId {
        self.focus
    }

    pub fn zoomed(&self) -> Option<PaneId> {
        self.zoomed
    }

    pub fn first_id(&self) -> PaneId {
        0
    }

    pub fn leaves(&self) -> Vec<PaneId> {
        let mut out = Vec::new();
        collect_leaves(&self.root, &mut out);
        out
    }

    pub fn len(&self) -> usize {
        self.leaves().len()
    }

    pub fn set_focus(&mut self, id: PaneId) -> bool {
        if self.leaves().contains(&id) {
            if self.focus != id {
                self.zoomed = None;
            }
            self.focus = id;
            true
        } else {
            false
        }
    }

    /// `target`을 `dir` 방향으로 분할해 새 pane을 만들고 포커스를 옮긴다.
    pub fn split(&mut self, target: PaneId, dir: Dir) -> Option<PaneId> {
        let new_id = self.next_id;
        let done = split_node(&mut self.root, target, dir, new_id);
        if !done {
            return None;
        }
        self.next_id += 1;
        self.focus = new_id;
        self.zoomed = None;
        Some(new_id)
    }

    pub fn close(&mut self, id: PaneId) -> CloseOutcome {
        if !self.leaves().contains(&id) {
            return CloseOutcome::Unknown;
        }
        if matches!(self.root, Node::Leaf(_)) {
            return CloseOutcome::Last;
        }
        let was_focus = self.focus == id;
        let replacement = remove_leaf(&mut self.root, id);
        if self.zoomed == Some(id) {
            self.zoomed = None;
        }
        if was_focus {
            self.focus = replacement.unwrap_or_else(|| first_leaf(&self.root));
        }
        CloseOutcome::Closed(self.focus)
    }

    pub fn toggle_zoom(&mut self) -> bool {
        if self.zoomed.is_some() {
            self.zoomed = None;
            true
        } else if self.len() > 1 {
            self.zoomed = Some(self.focus);
            true
        } else {
            false
        }
    }

    /// 보이는 pane들의 영역. 줌 상태면 줌된 pane 하나가 전체를 차지한다.
    pub fn rects(&self, area: Rect, gap: f32) -> Vec<(PaneId, Rect)> {
        if let Some(z) = self.zoomed {
            return vec![(z, area)];
        }
        let mut out = Vec::new();
        layout_rects(&self.root, area, gap, &mut out);
        out
    }

    pub fn dividers(&self, area: Rect, gap: f32) -> Vec<Divider> {
        let mut out = Vec::new();
        if self.zoomed.is_none() {
            collect_dividers(&self.root, area, gap, &mut Vec::new(), &mut out);
        }
        out
    }

    /// 경로가 가리키는 분할 노드의 비율을 설정한다 (0.05..0.95로 제한).
    pub fn set_ratio(&mut self, path: &[bool], ratio: f32) -> bool {
        let mut node = &mut self.root;
        for step in path {
            match node {
                Node::Split(s) => node = if *step { &mut s.second } else { &mut s.first },
                Node::Leaf(_) => return false,
            }
        }
        match node {
            Node::Split(s) => {
                s.ratio = ratio.clamp(0.05, 0.95);
                true
            }
            Node::Leaf(_) => false,
        }
    }

    /// 방향 이동 대상 pane (인접 + 가장 많이 겹치는 pane).
    pub fn neighbor(&self, from: PaneId, dir: Dir, area: Rect, gap: f32) -> Option<PaneId> {
        let rects = self.rects_ignoring_zoom(area, gap);
        let cur = rects.iter().find(|(id, _)| *id == from)?.1;
        let eps = gap.max(1.0) + 0.5;
        let mut best: Option<(PaneId, f32, f32)> = None; // (id, distance, overlap)
        for (id, r) in &rects {
            if *id == from {
                continue;
            }
            let (dist, overlap) = match dir {
                Dir::Right => (
                    r.x - cur.right(),
                    overlap_1d(cur.y, cur.bottom(), r.y, r.bottom()),
                ),
                Dir::Left => (
                    cur.x - r.right(),
                    overlap_1d(cur.y, cur.bottom(), r.y, r.bottom()),
                ),
                Dir::Down => (
                    r.y - cur.bottom(),
                    overlap_1d(cur.x, cur.right(), r.x, r.right()),
                ),
                Dir::Up => (
                    cur.y - r.bottom(),
                    overlap_1d(cur.x, cur.right(), r.x, r.right()),
                ),
            };
            if dist < -0.5 || dist > eps || overlap <= 0.0 {
                continue;
            }
            let better = match best {
                None => true,
                Some((_, bd, bo)) => dist < bd - 0.5 || ((dist - bd).abs() <= 0.5 && overlap > bo),
            };
            if better {
                best = Some((*id, dist, overlap));
            }
        }
        best.map(|(id, _, _)| id)
    }

    /// 포커스를 `dir` 방향으로 옮긴다. 옮겼으면 true.
    pub fn focus_dir(&mut self, dir: Dir, area: Rect, gap: f32) -> bool {
        match self.neighbor(self.focus, dir, area, gap) {
            Some(id) => {
                self.focus = id;
                self.zoomed = None;
                true
            }
            None => false,
        }
    }

    /// 트리 순서대로 다음/이전 pane으로 포커스를 순환한다.
    pub fn focus_cycle(&mut self, forward: bool) -> bool {
        let leaves = self.leaves();
        if leaves.len() < 2 {
            return false;
        }
        let pos = leaves.iter().position(|&l| l == self.focus).unwrap_or(0);
        let next = if forward {
            (pos + 1) % leaves.len()
        } else {
            (pos + leaves.len() - 1) % leaves.len()
        };
        self.focus = leaves[next];
        self.zoomed = None;
        true
    }

    fn rects_ignoring_zoom(&self, area: Rect, gap: f32) -> Vec<(PaneId, Rect)> {
        let mut out = Vec::new();
        layout_rects(&self.root, area, gap, &mut out);
        out
    }
}

impl Default for Layout {
    fn default() -> Self {
        Self::new()
    }
}

/// 드래그 위치로부터 새 비율을 계산한다. 양쪽이 최소 `min_px`를 유지하도록 제한한다.
pub fn drag_ratio(div: &Divider, pos: f32, gap: f32, min_px: f32) -> f32 {
    let (start, size) = match div.axis {
        Axis::Horizontal => (div.parent.x, div.parent.w),
        Axis::Vertical => (div.parent.y, div.parent.h),
    };
    let usable = (size - gap).max(1.0);
    let min_ratio = (min_px / usable).min(0.5);
    ((pos - start - gap / 2.0) / usable).clamp(min_ratio, 1.0 - min_ratio)
}

fn overlap_1d(a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

fn collect_leaves(node: &Node, out: &mut Vec<PaneId>) {
    match node {
        Node::Leaf(id) => out.push(*id),
        Node::Split(s) => {
            collect_leaves(&s.first, out);
            collect_leaves(&s.second, out);
        }
    }
}

fn first_leaf(node: &Node) -> PaneId {
    match node {
        Node::Leaf(id) => *id,
        Node::Split(s) => first_leaf(&s.first),
    }
}

fn split_node(node: &mut Node, target: PaneId, dir: Dir, new_id: PaneId) -> bool {
    match node {
        Node::Leaf(id) if *id == target => {
            let axis = match dir {
                Dir::Left | Dir::Right => Axis::Horizontal,
                Dir::Up | Dir::Down => Axis::Vertical,
            };
            let old = Node::Leaf(target);
            let new = Node::Leaf(new_id);
            let (first, second) = match dir {
                Dir::Right | Dir::Down => (old, new),
                Dir::Left | Dir::Up => (new, old),
            };
            *node = Node::Split(Box::new(Split {
                axis,
                ratio: 0.5,
                first,
                second,
            }));
            true
        }
        Node::Leaf(_) => false,
        Node::Split(s) => {
            split_node(&mut s.first, target, dir, new_id)
                || split_node(&mut s.second, target, dir, new_id)
        }
    }
}

/// `id` 리프를 제거하고, 형제가 이어받은 서브트리의 첫 리프 id를 돌려준다.
fn remove_leaf(node: &mut Node, id: PaneId) -> Option<PaneId> {
    let Node::Split(s) = node else { return None };
    let first_is = matches!(s.first, Node::Leaf(l) if l == id);
    let second_is = matches!(s.second, Node::Leaf(l) if l == id);
    if first_is || second_is {
        let sibling = if first_is {
            std::mem::replace(&mut s.second, Node::Leaf(u32::MAX))
        } else {
            std::mem::replace(&mut s.first, Node::Leaf(u32::MAX))
        };
        let focus = first_leaf(&sibling);
        *node = sibling;
        return Some(focus);
    }
    remove_leaf(&mut s.first, id).or_else(|| remove_leaf(&mut s.second, id))
}

fn child_areas(s: &Split, area: Rect, gap: f32) -> (Rect, Rect, Rect) {
    match s.axis {
        Axis::Horizontal => {
            let usable = (area.w - gap).max(0.0);
            let w1 = (usable * s.ratio).round();
            let a = Rect::new(area.x, area.y, w1, area.h);
            let d = Rect::new(area.x + w1, area.y, gap, area.h);
            let b = Rect::new(area.x + w1 + gap, area.y, (usable - w1).max(0.0), area.h);
            (a, d, b)
        }
        Axis::Vertical => {
            let usable = (area.h - gap).max(0.0);
            let h1 = (usable * s.ratio).round();
            let a = Rect::new(area.x, area.y, area.w, h1);
            let d = Rect::new(area.x, area.y + h1, area.w, gap);
            let b = Rect::new(area.x, area.y + h1 + gap, area.w, (usable - h1).max(0.0));
            (a, d, b)
        }
    }
}

fn layout_rects(node: &Node, area: Rect, gap: f32, out: &mut Vec<(PaneId, Rect)>) {
    match node {
        Node::Leaf(id) => out.push((*id, area)),
        Node::Split(s) => {
            let (a, _, b) = child_areas(s, area, gap);
            layout_rects(&s.first, a, gap, out);
            layout_rects(&s.second, b, gap, out);
        }
    }
}

fn collect_dividers(
    node: &Node,
    area: Rect,
    gap: f32,
    path: &mut Vec<bool>,
    out: &mut Vec<Divider>,
) {
    if let Node::Split(s) = node {
        let (a, d, b) = child_areas(s, area, gap);
        out.push(Divider {
            path: path.clone(),
            axis: s.axis,
            rect: d,
            parent: area,
        });
        path.push(false);
        collect_dividers(&s.first, a, gap, path, out);
        path.pop();
        path.push(true);
        collect_dividers(&s.second, b, gap, path, out);
        path.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1000.0,
        h: 600.0,
    };
    const GAP: f32 = 4.0;

    fn rect_of(l: &Layout, id: PaneId) -> Rect {
        l.rects(AREA, GAP)
            .into_iter()
            .find(|(i, _)| *i == id)
            .unwrap()
            .1
    }

    #[test]
    fn single_pane_fills_area() {
        let l = Layout::new();
        assert_eq!(l.rects(AREA, GAP), vec![(0, AREA)]);
        assert_eq!(l.len(), 1);
        assert!(l.dividers(AREA, GAP).is_empty());
    }

    #[test]
    fn split_right_puts_new_pane_on_right_and_focuses_it() {
        let mut l = Layout::new();
        let n = l.split(0, Dir::Right).unwrap();
        assert_eq!(l.focus(), n);
        assert!(rect_of(&l, 0).x < rect_of(&l, n).x);
        assert_eq!(rect_of(&l, 0).y, rect_of(&l, n).y);
    }

    #[test]
    fn split_left_puts_new_pane_on_left() {
        let mut l = Layout::new();
        let n = l.split(0, Dir::Left).unwrap();
        assert!(rect_of(&l, n).x < rect_of(&l, 0).x);
    }

    #[test]
    fn split_down_and_up() {
        let mut l = Layout::new();
        let d = l.split(0, Dir::Down).unwrap();
        assert!(rect_of(&l, 0).y < rect_of(&l, d).y);
        let u = l.split(0, Dir::Up).unwrap();
        assert!(rect_of(&l, u).y < rect_of(&l, 0).y);
        assert_eq!(l.len(), 3);
    }

    #[test]
    fn split_shares_space_with_gap() {
        let mut l = Layout::new();
        let n = l.split(0, Dir::Right).unwrap();
        let (a, b) = (rect_of(&l, 0), rect_of(&l, n));
        assert_eq!(a.w + GAP + b.w, AREA.w);
        assert_eq!(b.x, a.right() + GAP);
    }

    #[test]
    fn split_unknown_target_is_noop() {
        let mut l = Layout::new();
        assert_eq!(l.split(99, Dir::Right), None);
        assert_eq!(l.len(), 1);
    }

    #[test]
    fn close_gives_space_to_sibling() {
        let mut l = Layout::new();
        let n = l.split(0, Dir::Right).unwrap();
        assert_eq!(l.close(n), CloseOutcome::Closed(0));
        assert_eq!(l.focus(), 0);
        assert_eq!(rect_of(&l, 0), AREA);
    }

    #[test]
    fn close_last_reports_last() {
        let mut l = Layout::new();
        assert_eq!(l.close(0), CloseOutcome::Last);
        assert_eq!(l.close(7), CloseOutcome::Unknown);
    }

    #[test]
    fn close_non_focused_keeps_focus() {
        let mut l = Layout::new();
        let a = l.split(0, Dir::Right).unwrap();
        let b = l.split(a, Dir::Down).unwrap();
        assert_eq!(l.focus(), b);
        assert_eq!(l.close(0), CloseOutcome::Closed(b));
        assert_eq!(l.len(), 2);
    }

    #[test]
    fn close_nested_promotes_sibling_subtree() {
        let mut l = Layout::new();
        let a = l.split(0, Dir::Right).unwrap();
        let b = l.split(a, Dir::Down).unwrap();
        // a(위) b(아래) 오른쪽 열. a를 닫으면 b가 오른쪽 열 전체를 쓴다.
        l.set_focus(a);
        assert_eq!(l.close(a), CloseOutcome::Closed(b));
        let rb = rect_of(&l, b);
        assert_eq!(rb.h, AREA.h);
        assert_eq!(rb.right(), AREA.right());
    }

    #[test]
    fn resize_via_ratio() {
        let mut l = Layout::new();
        let n = l.split(0, Dir::Right).unwrap();
        assert!(l.set_ratio(&[], 0.25));
        let (a, b) = (rect_of(&l, 0), rect_of(&l, n));
        assert!((a.w - (AREA.w - GAP) * 0.25).abs() < 1.0);
        assert!(b.w > a.w);
        assert!(l.set_ratio(&[], 5.0));
        assert!(rect_of(&l, n).w > 0.0);
        assert!(!l.set_ratio(&[true], 0.5), "리프 경로는 거부");
    }

    #[test]
    fn divider_drag_ratio_is_clamped() {
        let mut l = Layout::new();
        l.split(0, Dir::Right).unwrap();
        let d = l.dividers(AREA, GAP).remove(0);
        assert_eq!(d.axis, Axis::Horizontal);
        let mid = drag_ratio(&d, 500.0, GAP, 80.0);
        assert!((mid - 0.5).abs() < 0.01);
        let low = drag_ratio(&d, -50.0, GAP, 80.0);
        assert!((low - 80.0 / 996.0).abs() < 1e-4);
        let high = drag_ratio(&d, 5000.0, GAP, 80.0);
        assert!((high - (1.0 - 80.0 / 996.0)).abs() < 1e-4);
    }

    #[test]
    fn nested_divider_paths_resolve() {
        let mut l = Layout::new();
        let a = l.split(0, Dir::Right).unwrap();
        l.split(a, Dir::Down).unwrap();
        let divs = l.dividers(AREA, GAP);
        assert_eq!(divs.len(), 2);
        let inner = divs.iter().find(|d| d.path == vec![true]).unwrap();
        assert_eq!(inner.axis, Axis::Vertical);
        assert!(l.set_ratio(&inner.path, 0.3));
    }

    #[test]
    fn focus_moves_geometrically_in_2x2() {
        let mut l = Layout::new();
        let tr = l.split(0, Dir::Right).unwrap(); // 0 | tr
        let br = l.split(tr, Dir::Down).unwrap(); // tr / br
        let bl = l.split(0, Dir::Down).unwrap(); // 0 / bl
        l.set_focus(0);
        assert!(l.focus_dir(Dir::Right, AREA, GAP));
        assert_eq!(l.focus(), tr);
        assert!(l.focus_dir(Dir::Down, AREA, GAP));
        assert_eq!(l.focus(), br);
        assert!(l.focus_dir(Dir::Left, AREA, GAP));
        assert_eq!(l.focus(), bl);
        assert!(l.focus_dir(Dir::Up, AREA, GAP));
        assert_eq!(l.focus(), 0);
        assert!(
            !l.focus_dir(Dir::Left, AREA, GAP),
            "가장자리에서는 이동 안 함"
        );
        assert!(!l.focus_dir(Dir::Up, AREA, GAP));
    }

    #[test]
    fn focus_prefers_largest_overlap() {
        let mut l = Layout::new();
        let r = l.split(0, Dir::Right).unwrap();
        let rb = l.split(r, Dir::Down).unwrap();
        // 오른쪽 열을 위쪽이 작게 되도록 조정: 분할 [true] 비율 0.2
        assert!(l.set_ratio(&[true], 0.2));
        l.set_focus(0);
        assert!(l.focus_dir(Dir::Right, AREA, GAP));
        assert_eq!(
            l.focus(),
            rb,
            "왼쪽 pane 중앙은 큰 아래 pane과 더 많이 겹친다"
        );
    }

    #[test]
    fn focus_cycle_wraps() {
        let mut l = Layout::new();
        let a = l.split(0, Dir::Right).unwrap();
        let b = l.split(a, Dir::Right).unwrap();
        assert_eq!(l.leaves(), vec![0, a, b]);
        assert!(l.focus_cycle(true));
        assert_eq!(l.focus(), 0);
        assert!(l.focus_cycle(false));
        assert_eq!(l.focus(), b);
        let mut single = Layout::new();
        assert!(!single.focus_cycle(true));
    }

    #[test]
    fn zoom_toggles_and_hides_others() {
        let mut l = Layout::new();
        assert!(!l.toggle_zoom(), "pane이 하나면 줌 불가");
        let n = l.split(0, Dir::Right).unwrap();
        assert!(l.toggle_zoom());
        assert_eq!(l.rects(AREA, GAP), vec![(n, AREA)]);
        assert!(l.dividers(AREA, GAP).is_empty());
        assert!(l.toggle_zoom());
        assert_eq!(l.rects(AREA, GAP).len(), 2);
    }

    #[test]
    fn zoom_cleared_by_split_focus_and_close() {
        let mut l = Layout::new();
        let n = l.split(0, Dir::Right).unwrap();
        l.toggle_zoom();
        assert!(l.focus_cycle(true));
        assert_eq!(l.zoomed(), None);
        l.set_focus(n);
        l.toggle_zoom();
        assert_eq!(l.close(n), CloseOutcome::Closed(0));
        assert_eq!(l.zoomed(), None);
        l.toggle_zoom();
        assert_eq!(l.zoomed(), None, "pane이 하나뿐이면 줌 안 됨");
    }

    #[test]
    fn rects_never_overlap_and_cover_area() {
        let mut l = Layout::new();
        let a = l.split(0, Dir::Right).unwrap();
        let b = l.split(a, Dir::Down).unwrap();
        l.split(0, Dir::Up).unwrap();
        l.split(b, Dir::Left).unwrap();
        let rects = l.rects(AREA, GAP);
        for (i, (_, r1)) in rects.iter().enumerate() {
            for (_, r2) in rects.iter().skip(i + 1) {
                let ox = overlap_1d(r1.x, r1.right(), r2.x, r2.right());
                let oy = overlap_1d(r1.y, r1.bottom(), r2.y, r2.bottom());
                assert!(ox <= 0.0 || oy <= 0.0, "겹침: {r1:?} {r2:?}");
            }
        }
        for (_, r) in &rects {
            assert!(
                r.x >= 0.0
                    && r.y >= 0.0
                    && r.right() <= AREA.right() + 0.5
                    && r.bottom() <= AREA.bottom() + 0.5
            );
        }
    }
}
