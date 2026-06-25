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
 *   ←/→     switch action focus (Play / Watchlist)
 *   Enter   activate focused action
 *   Esc/Back close
 */

import {
  createSignal,
  createResource,
  createEffect,
  createMemo,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import type { MovieListItem, MovieDetail } from "../api/types";
import { getMovie } from "../api/catalog";
import { useNavigationScope } from "../lib/navigation";
import { isBackKey } from "../lib/navigationKeys";
import { getGradient } from "../lib/gradient";
import {
  isInWatchlist,
  toggleWatchlistItem,
  watchlistState,
} from "../lib/watchlistStore";

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
  // Priority 100 (modal tier) so we outprio higher-priority pages
  // such as Search (90) — the modal must own keyboard input while
  // mounted, regardless of which page launched it.
  const { isScopeOwner } = useNavigationScope("overlay:movie-detail", {
    active: true,
    priority: 100,
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

  // Watchlist payload — prefer the enriched detail (better metadata)
  // and fall back to the list-row data so the button works while
  // the detail call is still in flight.
  const watchlistItem = () => {
    const d = detail();
    const m = props.movie;
    return {
      type: "movie" as const,
      id: m.id,
      tmdb_id: d?.tmdb_id ?? m.tmdb_id ?? null,
      title: d?.name ?? m.name,
      name: d?.name ?? m.name,
      logo: d?.cover_big ?? m.cover_big ?? m.stream_icon ?? null,
      backdrop: d?.backdrop_path ?? m.backdrop_path ?? null,
      plot: d?.description ?? null,
      rating: d?.rating_5based ?? m.rating_5based ?? null,
      language: d?.language ?? m.language ?? null,
      year: d?.year ?? m.year ?? null,
      genres: d?.genres ?? m.genres ?? [],
      container_extension: d?.container_extension ?? null,
      is_adult: d?.is_adult ?? m.is_adult,
    };
  };

  // Adult content is excluded from regular features — no watchlist affordance.
  const isAdult = createMemo<boolean>(
    () => (detail()?.is_adult ?? props.movie.is_adult) === true,
  );

  const inWatchlist = createMemo<boolean>(() => {
    watchlistState();
    return isInWatchlist(watchlistItem());
  });

  function onToggleWatchlist() {
    toggleWatchlistItem(watchlistItem());
  }

  // Keyboard handler — scoped to this modal.
  //
  // The handler swallows ALL navigation keys (preventDefault +
  // stopImmediatePropagation) so the underlying Movies / Search page
  // handler — even if it survived the scope-owner check — can't act.
  // This is defence in depth: scope-stack arbitration *should* keep
  // the page from doing anything, but stopping the event here also
  // stops things like default scroll, focus-cycle, or any third-party
  // listener that might react to arrow keys.
  createEffect(() => {
    const NAV = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Enter",
      " ",
    ];
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;
      if (!NAV.includes(e.key) && !isBackKey(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (isBackKey(e.key)) {
        props.onClose();
      } else if (e.key === "ArrowLeft") {
        setActionIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowRight") {
        setActionIdx((i) => Math.min(isAdult() ? 0 : 1, i + 1));
      } else if (e.key === "Enter" || e.key === " ") {
        if (actionIdx() === 0) props.onPlay();
        else if (actionIdx() === 1) onToggleWatchlist();
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
            <Show when={!isAdult()}>
              <button
                class={`hp-btn secondary ${actionIdx() === 1 ? "mp-modal-action-focused" : ""}`}
                onClick={onToggleWatchlist}
                title={inWatchlist() ? "Remove from watchlist" : "Add to watchlist"}
              >
                {inWatchlist() ? "✓ In Watchlist" : "+ Add to Watchlist"}
              </button>
            </Show>
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
