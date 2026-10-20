import type { SVGProps } from "react";

const BODY =
  "M6 0h4v1h-4zM6 1h1v1h-1zM9 1h1v1h-1zM6 2h4v1h-4zM6 3h1v1h-1zM2 4h12v1h-12zM1 5h1v1h-1zM14 5h1v1h-1zM1 6h1v1h-1zM14 6h1v1h-1zM0 7h2v1h-2zM14 7h2v1h-2zM0 8h2v1h-2zM14 8h2v1h-2zM1 9h1v1h-1zM14 9h1v1h-1zM1 10h1v1h-1zM5 10h1v1h-1zM10 10h1v1h-1zM14 10h1v1h-1zM1 11h1v1h-1zM6 11h4v1h-4zM14 11h1v1h-1zM2 12h12v1h-12zM4 13h1v1h-1zM11 13h1v1h-1zM3 14h2v1h-2zM11 14h2v1h-2z";
const EYES =
  "M3 6h3v1h-3zM10 6h3v1h-3zM3 7h1v1h-1zM5 7h1v1h-1zM10 7h1v1h-1zM12 7h1v1h-1zM3 8h3v1h-3zM10 8h3v1h-3z";

/**
 * Oopi, the OOP desktop mascot, drawn on a 16x16 pixel grid: its eyes are the two O's and the
 * flag on its antenna is the P. Render it at 16px multiples so every pixel stays crisp.
 */
export function OoPMascot(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={BODY} fill="currentColor" />
      <path d={EYES} fill="currentColor" className="group-hover:oop-blink" />
    </svg>
  );
}
