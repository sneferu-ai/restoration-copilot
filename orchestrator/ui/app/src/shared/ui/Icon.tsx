// One icon set, one stroke weight (Lucide 1.5px-equivalent). No emoji as
// functional icons (DESIGN.md §9). All icons are inline SVG, 24x24 viewBox,
// stroke="currentColor" so they inherit token color.

import { SVGProps } from "react";

const base = (props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> => ({
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
  ...props,
});

export function Icon({ d, ...props }: { d: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      <path d={d} />
    </svg>
  );
}

// Multi-path icons (a few compound shapes).
export function IconCompound({ paths, ...props }: { paths: string[] } & SVGProps<SVGSVGElement>) {
  return (
    <svg {...base(props)}>
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export const ICONS = {
  plus: "M12 5v14 M5 12h14",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3",
  filter: "M3 4h18l-7 8v6l-4 2v-8z",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5",
  close: "M18 6L6 18 M6 6l12 12",
  chevronRight: "M9 6l6 6-6 6",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronDown: "M6 9l6 6 6-6",
  download: "M12 3v12 M7 10l5 5 5-5 M5 21h14",
  upload: "M12 21V9 M7 14l5-5 5 5 M5 3h14",
  flag: "M4 21V4 M4 4h13l-2 4 2 4H4",
  alert: "M12 9v4 M12 17h.01 M10.3 3.9l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z",
  check: "M20 6L9 17l-5-5",
  wrench: "M14.7 6.3a4 4 0 0 0-5.7 5.7L3 18v3h3l6-6a4 4 0 0 0 5.7-5.7l-2.4 2.4-2.3-.6-.6-2.3z",
  key: "M21 2l-2 2 M17 6l3-3 M9 9a6 6 0 1 0 4.2 4.2l5.8-5.8-2-2-5.8 5.8z",
  cog: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  bolt: "M13 2L3 14h7l-1 8 10-12h-7z",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  package: "M16.5 9.4l-9-5.2 M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7l8.7 5 8.7-5 M12 22V12",
  clipboard: "M9 2h6a1 1 0 0 1 1 1v2H8V3a1 1 0 0 1 1-1z M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2",
  layers: "M12 2l9 5-9 5-9-5 9-5z M3 12l9 5 9-5 M3 17l9 5 9-5",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
  pin: "M12 17v5 M5 9l7-7 7 7-3 3-4-4-4 4z",
  pause: "M9 5v14 M15 5v14",
  play: "M6 4l14 8-14 8z",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
} as const;
