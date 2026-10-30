export type Point = readonly [x: number, y: number];

/** Smooth cubic path through `points`; `move` is the first command, "L" to continue a path. */
export function smoothPath(points: ReadonlyArray<Point>, move: "M" | "L" = "M"): string {
  return points
    .map(([px, py], index) => {
      if (index === 0) return `${move} ${px} ${py}`;
      const [ox, oy] = points[index - 1]!;
      const dx = (px - ox) / 3;
      return `C ${ox + dx} ${oy}, ${px - dx} ${py}, ${px} ${py}`;
    })
    .join(" ");
}

/** Step-after path: each value holds until the next x, then jumps. */
export function stepPath(points: ReadonlyArray<Point>): string {
  return points
    .map(([px, py], index) => {
      if (index === 0) return `M ${px} ${py}`;
      return `H ${px} V ${py}`;
    })
    .join(" ");
}

/**
 * Moves label positions apart so neighbours are at least `gap` apart, keeping their order and
 * staying inside [min, max] when they fit. Returns positions in the input order.
 */
export function spreadLabels(
  positions: ReadonlyArray<number>,
  gap: number,
  min: number,
  max: number,
): number[] {
  const order = positions.map((_, index) => index).sort((a, b) => positions[a]! - positions[b]!);
  const placed = order.map((index) => positions[index]!);
  for (let i = 0; i < placed.length; i += 1) {
    placed[i] = Math.max(placed[i]!, i === 0 ? min : placed[i - 1]! + gap);
  }
  const overflow = (placed.at(-1) ?? 0) - max;
  if (overflow > 0) {
    for (let i = placed.length - 1; i >= 0; i -= 1) {
      placed[i] = Math.min(placed[i]!, i === placed.length - 1 ? max : placed[i + 1]! - gap);
    }
    // Too many labels for the range: let the top ones run past `min` rather than overlap.
  }
  const result = Array.from({ length: positions.length }, () => 0);
  order.forEach((index, rank) => {
    result[index] = placed[rank]!;
  });
  return result;
}
