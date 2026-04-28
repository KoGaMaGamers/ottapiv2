/**
 * Inline stroke icons used in row headers and similar small accents.
 *
 * Lucide-style 24×24 currentColor strokes — keep the set tight; if it
 * grows past ~10 icons, swap to a real icon package. All icons accept
 * `size` (defaults to 1em so they track the surrounding text size) and
 * `class` for layout/colour overrides.
 */

import type { JSX } from "solid-js";

export interface IconProps {
  size?: number | string;
  class?: string;
}

function svg(
  props: IconProps,
  children: JSX.Element,
): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={props.size ?? "1em"}
      height={props.size ?? "1em"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Film reel — pairs well with "Movies". */
export function FilmIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="8" x2="21" y2="8" />
      <line x1="3" y1="16" x2="21" y2="16" />
      <line x1="8" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="16" y2="21" />
    </>,
  );
}

/** TV — pairs well with "Series". */
export function TvIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <>
      <rect x="2" y="6" width="20" height="14" rx="2" />
      <polyline points="7 2 12 6 17 2" />
    </>,
  );
}

/** Star — "Top Rated". */
export function StarIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
  );
}

/** Tower — Live channels. */
export function BroadcastIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
      <path d="M7.76 16.25a6 6 0 0 1 0-8.49" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
    </>,
  );
}
