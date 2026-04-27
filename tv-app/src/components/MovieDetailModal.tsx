/**
 * MovieDetailModal — full-bleed movie detail overlay.
 *
 * Faithful Solid port of the `MovieDetailModal` exported from
 * `tv_app_v2/src/pages/MoviesPage.jsx`. Adapted to use our backend's
 * already-enriched `MovieDetail` (plot/actors/director/youtube_trailer
 * are populated server-side from TMDB) — drops the legacy direct-to-
 * TMDB fetch and the embedded API key pattern.
 *
 * Keyboard model:
 *   ←/→     switch action focus (Play / [future] Watchlist)
 *   Enter   activate focused action
 *   Esc/Back close
 *
 * Watchlist button is a placeholder — clicking does nothing — until the
 * watchlist store is ported. The button itself is shown so the layout
 * matches the legacy.
 */

import {
  createSignal,
  createResource,
  createEffect,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import type { MovieListItem, MovieDetail } from "../api/types";
import { getMovie } from "../api/catalog";
import { useNavigationScope } from "../lib/navigation";
import { getGradient } from "../lib/gradient";

export interface MovieDetailModalProps {
  movie: MovieListItem;
  onClose: () => void;
  onPlay: () => void;
}

/**
 * Extract a YouTube video id from either a bare id ("abc123") or a full
 * URL (youtu.be/X, youtube.com/watch?v=X, youtube.com/embed/X). Returns
 * null when the input doesn't look like a YouTube reference.
 */
function extractYoutubeId(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (!raw.includes("http")) return raw;
  try {
    const u = new URL(raw);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace("/", "") || null;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || null;
    }
  } catch {
    /* malformed URL — fall through */
  }
  return raw;
}

export default function MovieDetailModal(
  props: MovieDetailModalProps,
): JSX.Element {
  const { isScopeOwner } = useNavigationScope("overlay:movie-detail", {
    active: true,
    priority: 60,
  });

  // 0 = Play, 1 = Watchlist (placeholder until watchlist store ports)
  const [actionIdx, setActionIdx] = createSignal(0);

  // Backend-enriched detail. Falls back to the list-row data if the
  // detail call fails — the modal still renders the title / poster /
  // backdrop we already have.
  const [detail] = createResource<MovieDetail | null, number>(
    () => props.movie.id,
    (id) => getMovie(id).catch(() => null),
  );

  const title = () => detail()?.name ?? props.movie.name;
  const poster = () =>
    detail()?.cover_big ?? props.movie.cover_big ?? props.movie.stream_icon;
  const backdrop = () =>
    detail()?.backdrop_path ?? props.movie.backdrop_path;
  const heroBg = () => backdrop() ?? poster();
  const plot = () => detail()?.description ?? null;
  const cast = () => detail()?.actors ?? null;
  const year = () => detail()?.year ?? props.movie.year;
  const youtubeId = () => extractYoutubeId(detail()?.youtube_trailer);

  // Keyboard handler — scoped to this modal.
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        props.onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setActionIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setActionIdx((i) => Math.min(1, i + 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (actionIdx() === 0) props.onPlay();
        // Watchlist: no-op until store is ported.
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  return (
    <div class="sp-modal-backdrop" onClick={props.onClose}>
      <div
        class="sp-modal-panel mp-modal-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="mp-modal-bg">
          <Show
            when={heroBg()}
            fallback={
              <div
                class="mp-modal-bg-fallback"
                style={{ background: getGradient(props.movie.name) }}
              />
            }
          >
            <img
              src={heroBg()!}
              alt=""
              class="mp-modal-bg-img"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </Show>
        </div>
        <div class="mp-modal-overlay" />

        <div class="mp-modal-content">
          <h1 class="mp-modal-title">{title()}</h1>
          <div class="mp-modal-meta">
            <Show when={year()}>
              <span>{year()}</span>
            </Show>
          </div>

          <div class="mp-modal-actions">
            <button
              class={`hp-btn primary ${actionIdx() === 0 ? "mp-modal-action-focused" : ""}`}
              onClick={props.onPlay}
            >
              ▶ Play Movie
            </button>
            <button
              class={`hp-btn secondary ${actionIdx() === 1 ? "mp-modal-action-focused" : ""}`}
              onClick={() => {
                /* Watchlist deferred until store ports */
              }}
              title="Watchlist coming soon"
            >
              + Add to Watchlist
            </button>
          </div>

          <Show when={plot()}>
            <p class="mp-modal-plot">{plot()}</p>
          </Show>
          <Show when={cast()}>
            <p class="mp-modal-cast">
              <span class="sp-modal-cast-label">Cast:</span>{" "}
              {cast()!.split(",").slice(0, 8).join(", ")}
            </p>
          </Show>

          <Show when={youtubeId()}>
            <div class="mp-trailer-wrap">
              <iframe
                title={`${title()} trailer`}
                src={`https://www.youtube.com/embed/${youtubeId()}?autoplay=1&mute=0&rel=0&playsinline=1`}
                class="mp-trailer-frame"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowfullscreen
              />
            </div>
          </Show>
        </div>

        <button
          class="sp-modal-close"
          onClick={props.onClose}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
