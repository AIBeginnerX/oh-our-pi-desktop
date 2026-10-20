import type { SVGProps } from "react";

// Keep these glyph paths aligned with assets/oop/oop-icon.svg.
const FIRST_O =
  "M120 60a60 60 0 1 1-120 0 60 60 0 1 1 120 0ZM95 60a35 35 0 1 0-70 0 35 35 0 1 0 70 0Z";
const SECOND_O =
  "M250 60a60 60 0 1 1-120 0 60 60 0 1 1 120 0ZM225 60a35 35 0 1 0-70 0 35 35 0 1 0 70 0Z";
const P =
  "M263.350 2.400L314.171 2.400C341.3 2.400 360 17.51 360 41.481C360 65.792 341.962 81.291 314.171 81.291L288.350 81.291L288.350 113.017L263.350 113.017L263.350 101.02C256.809 111.02 244.111 124 232.566 124C221.022 124 222.279 123.121 212.279 121.121C235.292 108.601 240.09 104.45 253.774 87.128C267.458 69.807 281.237 59.586 312.01 59.586C325.701 59.586 333.460 54.234 333.460 41.22C333.460 30.562 325.195 23.357 312.01 23.357L288.350 23.357L288.350 54.219C279.809 57.119 271.809 61.145 263.350 67.745L263.350 2.400Z";

export function OoPWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      aria-hidden
      viewBox="0 0 360 124"
      fill="currentColor"
      fillRule="evenodd"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={FIRST_O} />
      <path d={SECOND_O} />
      <path d={P} />
    </svg>
  );
}
