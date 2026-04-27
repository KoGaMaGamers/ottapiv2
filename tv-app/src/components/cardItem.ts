/**
 * Shared card-item shape consumed by MovieMediaCard, SeriesMediaCard,
 * and LiveMediaCard. Mirrors the loose property probing the legacy
 * React cards do (`item.title || item.name`, `item.poster || item.logo
 * || item.stream_icon`, etc.). Pages adapt their typed catalog DTOs
 * (MovieListItem / SeriesListItem / LiveStreamItem) into this shape
 * before passing them in.
 *
 * Lifted from `tv_app_v2/src/components/{MovieMediaCard,SeriesMediaCard,
 * LiveMediaCard}.jsx` so the field probes stay byte-identical.
 */
export interface CardItem {
  id?: string | number;
  title?: string;
  name?: string;

  // Image source candidates. Cards probe in a fixed order:
  //   movie:  backdrop > poster > logo
  //   series: poster > logo
  //   live:   poster > channel_logo > logo > stream_icon
  poster?: string | null;
  backdrop?: string | null;
  logo?: string | null;
  channel_logo?: string | null;
  stream_icon?: string | null;

  language?: string | null;
  year?: string | number | null;
  rating?: number | null;
  runtime?: string | number | null;
  duration?: string | number | null;
  time?: string | number | null;
  genres?: ReadonlyArray<string | { name?: string | null }>;

  type?: "movie" | "series" | "live" | string;

  // MovieMediaCard probes for resume progress in this priority order:
  //   1. __progressPct  (already a 0..100 number)
  //   2. __resumeSec / __durationSec  (private hint fields)
  //   3. positionSec   / durationSec   (public fields)
  __progressPct?: number;
  __resumeSec?: number;
  __durationSec?: number;
  positionSec?: number;
  durationSec?: number;
}

/** Normalise the genres-array probe — strings or `{name}` objects. */
export function toGenreLabels(
  genres: CardItem["genres"],
  limit: number,
): string[] {
  if (!Array.isArray(genres)) return [];
  return genres
    .map((g) => (typeof g === "string" ? g : g?.name ?? null))
    .filter((g): g is string => !!g)
    .slice(0, limit);
}

/**
 * Parse a runtime hint into a "Nm" label. Accepts seconds as a finite
 * number, "HH:MM:SS", "MM:SS", or any other string (returned as-is).
 */
export function parseRuntimeLabel(
  value: CardItem["runtime"],
): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${Math.max(1, Math.round(value))}m`;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const parts = raw.split(":").map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    const mins = parts[0] * 60 + parts[1];
    return `${Math.max(1, mins)}m`;
  }
  if (parts.length === 2 && parts.every(Number.isFinite)) {
    return `${Math.max(1, parts[0])}m`;
  }
  return raw;
}

/** Compute the resume-progress percent (0..100) for a movie card. */
export function computeProgressPct(item: CardItem | undefined): number {
  if (!item) return 0;
  const direct = Number(item.__progressPct);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.min(100, Math.max(0, direct));
  }
  const pos = Number(item.__resumeSec ?? item.positionSec ?? 0);
  const dur = Number(item.__durationSec ?? item.durationSec ?? 0);
  if (Number.isFinite(pos) && Number.isFinite(dur) && pos > 0 && dur > 0) {
    return Math.min(100, Math.max(0, Math.round((pos / dur) * 100)));
  }
  return 0;
}
