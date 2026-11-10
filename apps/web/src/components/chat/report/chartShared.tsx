/** Palette colour for report figures (flowchart ranks): cycles the report colours. */
export const reportColor = (index: number) => `var(--report-${(index % 8) + 1})`;
