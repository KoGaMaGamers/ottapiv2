/**
 * SkeletonCard — shimmer placeholder shown while a content grid loads.
 *
 * Faithful Solid port of `tv_app_v2/src/components/SkeletonCard.jsx`.
 * Matches the portrait 2:3 card shape; styles live in `styles/movies.css`
 * (`.sp-skeleton-card` / `.sp-skeleton-poster` / `.sp-skeleton-line`).
 */

import type { JSX } from "solid-js";

export default function SkeletonCard(): JSX.Element {
  return (
    <div class="sp-skeleton-card">
      <div class="sp-skeleton-poster" />
      <div class="sp-skeleton-line short" />
      <div class="sp-skeleton-line" />
    </div>
  );
}
