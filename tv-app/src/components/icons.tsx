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

/** Clock circular arrow — Continue Watching. */
export function ResumeIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 9 8 9" />
      <polyline points="11 8 11 13 15 14" />
    </>,
  );
}

/** Sparkle — recommendations / "You should like…". */
export function SparkleIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="M5.6 5.6l2.8 2.8" />
      <path d="M15.6 15.6l2.8 2.8" />
      <path d="M5.6 18.4l2.8-2.8" />
      <path d="M15.6 8.4l2.8-2.8" />
    </>,
  );
}

/** Bookmark — My Watchlist. */
export function BookmarkIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  );
}

/** Magnifier — Search. */
export function SearchIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
  );
}

/** User silhouette — Profile. */
export function UserIcon(props: IconProps): JSX.Element {
  return svg(
    props,
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>,
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
