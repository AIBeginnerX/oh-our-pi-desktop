import type { SVGProps } from "react";

export function OoPWordmark({
  weight = 12,
  ...props
}: SVGProps<SVGSVGElement> & { readonly weight?: number }) {
  return (
    <svg
      {...props}
      role="img"
      aria-label="OOP"
      viewBox="0 0 296 110"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={weight}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="60" cy="55" r="38" />
        <circle cx="164" cy="55" r="38" />
        <path d="M232 93V17h20a23 23 0 0 1 0 46h-20" />
      </g>
    </svg>
  );
}
