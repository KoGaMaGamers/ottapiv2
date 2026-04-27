/**
 * SeriesDetail — full-page series detail (header banner + season tabs +
 * episode list).
 *
 * Faithful Solid port of the legacy SeriesDetailModal embedded in
 * `tv_app_v2/src/pages/SeriesPage.jsx` (LOC 776-1162), converted from
 * a slide-up modal to a dedicated route at `/series/:id` per the
 * user's preference. The internal layout (header banner, seasons bar,
 * episode list, EpisodeRow) is unchanged — only the wrapper changes
 * from `.sp-modal-backdrop > .sp-modal-panel` to
 * `.series-detail-page`.
 *
 * Keyboard model:
 *   ←/→            previous / next season (when focus is in episode list)
 *   ↑ at first ep   move focus to action buttons
 *   ↑/↓ in actions  no-op on row, ←/→ switches Play / Watchlist
 *   ↓ from actions  return focus to episode list
 *   Enter           play focused episode (or fire focused action)
 *   Esc / Back      navigate back
 *
 * Watchlist + playback-progress bars are wired but inert — both stores
 * are pending separate ports. Play handler logs to console until the
 * MediaPlayer + heartbeat layer ports.
 */

import {
  createSignal,
  createMemo,
  createEffect,
  createResource,
  on,
  onCleanup,
  Show,
  For,
  type JSX,
} from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { getSeries, getSeasonEpisodes } from "../api/catalog";
import type {
  EpisodeOut,
  SeasonOut,
  SeriesDetail as SeriesDetailDTO,
} from "../api/types";
import { useNavigationScope } from "../lib/navigation";
import { getGradient, getAccent } from "../lib/gradient";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SeriesDetail(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isScopeOwner } = useNavigationScope("page:series-detail", {
    active: true,
    priority: 60,
  });

  const seriesId = createMemo(() => Number(params.id));

  // Series detail (includes seasons[])
  const [series] = createResource<SeriesDetailDTO | null, number>(
    seriesId,
    (id) => getSeries(id).catch(() => null),
  );

  // Selected season number
  const [activeSeason, setActiveSeason] = createSignal<number | null>(null);

  // Episodes for the active season
  const [episodes] = createResource<
    EpisodeOut[],
    { id: number; season: number | null }
  >(
    () => ({ id: seriesId(), season: activeSeason() }),
    async ({ id, season }) => {
      if (season == null) return [] as EpisodeOut[];
      try {
        return await getSeasonEpisodes(id, season);
      } catch {
        return [] as EpisodeOut[];
      }
    },
  );

  // Set the initial active season once the detail loads (lowest season number)
  createEffect(
    on(series, (s) => {
      if (!s || !s.seasons || s.seasons.length === 0) return;
      const lowest = s.seasons.reduce(
        (a, b) => (a.season_number <= b.season_number ? a : b),
      );
      setActiveSeason((cur) => cur ?? lowest.season_number);
    }),
  );

  // Focus state
  const [focusZone, setFocusZone] = createSignal<"actions" | "episodes">(
    "episodes",
  );
  const [actionIdx, setActionIdx] = createSignal(0); // 0=play, 1=watchlist
  const [focusedEpIdx, setFocusedEpIdx] = createSignal(0);
  const [playError, setPlayError] = createSignal<string | null>(null);

  // Reset episode focus + scroll-top whenever the active season changes
  createEffect(
    on(activeSeason, () => {
      setFocusedEpIdx(0);
      queueMicrotask(() => {
        if (episodesRef) episodesRef.scrollTop = 0;
      });
    }, { defer: true }),
  );

  // Auto-dismiss play error
  createEffect(
    on(playError, (msg) => {
      if (!msg) return;
      const t = window.setTimeout(() => setPlayError(null), 5000);
      onCleanup(() => clearTimeout(t));
    }),
  );

  // Refs
  let episodesRef: HTMLDivElement | undefined;

  // Auto-scroll the focused episode into view
  createEffect(() => {
    if (!episodesRef) return;
    const i = focusedEpIdx();
    queueMicrotask(() => {
      const el = episodesRef?.querySelector(
        `[data-ep-idx="${i}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });

  // Stub play handler until MediaPlayer ports
  const handlePlayEpisode = (ep: EpisodeOut) => {
    console.log("[SeriesDetail] play episode", {
      seriesId: seriesId(),
      season: activeSeason(),
      episode: ep.episode_num,
      epId: ep.id,
    });
  };

  // Keyboard handler
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;

      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        navigate(-1);
        return;
      }

      const NAV = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"];
      if (!NAV.includes(e.key)) return;
      e.preventDefault();

      const seasonsList = series()?.seasons ?? [];
      const epList = episodes() ?? [];

      if (focusZone() === "actions") {
        if (e.key === "ArrowLeft") {
          setActionIdx((i) => Math.max(0, i - 1));
        } else if (e.key === "ArrowRight") {
          setActionIdx((i) => Math.min(1, i + 1));
        } else if (e.key === "ArrowDown") {
          setFocusZone("episodes");
        } else if (e.key === "Enter") {
          if (actionIdx() === 0) {
            const ep = epList[focusedEpIdx()] ?? epList[0];
            if (ep) handlePlayEpisode(ep);
          }
          // Watchlist no-op until store is ported
        }
        return;
      }

      // focusZone === 'episodes'
      if (e.key === "ArrowLeft") {
        const idx = seasonsList.findIndex(
          (s) => s.season_number === activeSeason(),
        );
        if (idx > 0) setActiveSeason(seasonsList[idx - 1].season_number);
      } else if (e.key === "ArrowRight") {
        const idx = seasonsList.findIndex(
          (s) => s.season_number === activeSeason(),
        );
        if (idx >= 0 && idx < seasonsList.length - 1) {
          setActiveSeason(seasonsList[idx + 1].season_number);
        }
      } else if (e.key === "ArrowUp") {
        if (focusedEpIdx() === 0) setFocusZone("actions");
        else setFocusedEpIdx((p) => Math.max(p - 1, 0));
      } else if (e.key === "ArrowDown") {
        setFocusedEpIdx((p) => Math.min(p + 1, epList.length - 1));
      } else if (e.key === "Enter") {
        const ep = epList[focusedEpIdx()];
        if (ep) handlePlayEpisode(ep);
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  // Render-derived
  const poster = () => series()?.cover ?? null;
  const backdrop = () => series()?.backdrop_path ?? null;

  return (
    <Show
      when={series()}
      fallback={
        <div class="series-detail-page">
          <div class="sp-browser-loading">
            <div class="hp-spinner" />
          </div>
        </div>
      }
    >
      {(s) => (
        <div class="series-detail-page">
          <div
            class="sp-modal-header"
            style={{ "--accent": getAccent(s().name) } as JSX.CSSProperties}
          >
            <div
              class="sp-modal-bg"
              style={
                !backdrop() && !poster()
                  ? { background: getGradient(s().name) }
                  : undefined
              }
            >
              <Show when={backdrop() || poster()}>
                <img
                  src={backdrop() ?? poster() ?? ""}
                  alt=""
                  class={`sp-modal-bg-img${backdrop() ? " sp-modal-bg-img--backdrop" : ""}`}
                  onError={(e) => {
                    const img = e.currentTarget as HTMLImageElement;
                    if (img.src !== poster() && poster()) {
                      img.src = poster()!;
                    } else {
                      img.style.display = "none";
                    }
                  }}
                />
              </Show>
            </div>
            <div class="sp-modal-header-overlay" />

            <div class="sp-modal-header-content">
              <Show when={poster()}>
                <div class="sp-modal-poster">
                  <img
                    src={poster()!}
                    alt={s().name}
                    class="sp-modal-poster-img"
                    onError={(e) => {
                      const parent = (e.currentTarget as HTMLImageElement)
                        .parentElement;
                      if (parent) parent.style.display = "none";
                    }}
                  />
                </div>
              </Show>

              <div class="sp-modal-info">
                <div class="hp-hero-badges" style={{ "margin-bottom": "12px" }}>
                  <span class="hp-badge series">📺 Series</span>
                  <Show when={s().release_date}>
                    <span class="hp-badge year">
                      {String(s().release_date).slice(0, 4)}
                    </span>
                  </Show>
                  <Show when={s().rating_5based != null}>
                    <span class="hp-badge rating">
                      ⭐ {s().rating_5based!.toFixed(1)}
                    </span>
                  </Show>
                  <Show when={s().episode_run_time}>
                    <span class="hp-badge runtime">
                      {s().episode_run_time} min/ep
                    </span>
                  </Show>
                  <Show when={s().language}>
                    <span class="hp-badge lang">{s().language}</span>
                  </Show>
                </div>

                <h1 class="sp-modal-title">{s().name}</h1>

                <Show when={(s().genres ?? []).length > 0}>
                  <div
                    class="hp-hero-genres"
                    style={{ margin: "8px 0 12px" }}
                  >
                    <For each={s().genres.slice(0, 5)}>
                      {(g) => <span class="hp-genre-tag">{g}</span>}
                    </For>
                  </div>
                </Show>

                <Show when={s().plot}>
                  <p class="sp-modal-plot">{s().plot}</p>
                </Show>

                <div
                  style={{
                    display: "flex",
                    gap: "12px",
                    "margin-top": "14px",
                    "flex-wrap": "wrap",
                  }}
                >
                  <Show
                    when={
                      (s().seasons?.length ?? 0) > 0 && activeSeason() != null
                    }
                  >
                    <button
                      class={`hp-btn primary ${
                        focusZone() === "actions" && actionIdx() === 0
                          ? "mp-modal-action-focused"
                          : ""
                      }`}
                      onClick={() => {
                        const ep = (episodes() ?? [])[0];
                        if (ep) handlePlayEpisode(ep);
                      }}
                      disabled={(episodes() ?? []).length === 0}
                    >
                      ▶ Play S
                      {String(activeSeason()).padStart(2, "0")}E01
                    </button>
                  </Show>
                  <button
                    class={`hp-btn secondary ${
                      focusZone() === "actions" && actionIdx() === 1
                        ? "mp-modal-action-focused"
                        : ""
                    }`}
                    onClick={() => {
                      /* watchlist deferred */
                    }}
                    title="Watchlist coming soon"
                  >
                    + Add to Watchlist
                  </button>
                  <Show when={s().youtube_trailer}>
                    <a
                      href={`https://www.youtube.com/watch?v=${s().youtube_trailer}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="hp-btn secondary sp-trailer-link"
                    >
                      🎬 Trailer
                    </a>
                  </Show>
                </div>

                <Show when={s().cast}>
                  <p class="sp-modal-cast">
                    <span class="sp-modal-cast-label">Cast:</span>{" "}
                    {s().cast!.split(",").slice(0, 5).join(", ")}
                  </p>
                </Show>
              </div>
            </div>

            <button
              class="sp-modal-close"
              onClick={() => navigate(-1)}
              title="Back (Esc)"
            >
              ✕
            </button>
          </div>

          {/* Seasons tab bar */}
          <div class="sp-seasons-bar">
            <Show
              when={(s().seasons ?? []).length > 0}
              fallback={
                <Show
                  when={!series.loading}
                  fallback={
                    <div class="sp-seasons-loading">
                      <div class="sp-mini-spinner" /> Loading seasons…
                    </div>
                  }
                >
                  <p class="sp-seasons-empty">No seasons available</p>
                </Show>
              }
            >
              <For each={s().seasons}>
                {(season: SeasonOut) => (
                  <button
                    class={`sp-season-tab${activeSeason() === season.season_number ? " active" : ""}`}
                    onClick={() => setActiveSeason(season.season_number)}
                    data-season={season.season_number}
                  >
                    {season.name ?? `Season ${season.season_number}`}
                    <Show when={season.episode_count != null}>
                      <span class="sp-ep-count">{season.episode_count}</span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>

          {/* Episodes list */}
          <div class="sp-episodes-list" ref={(el) => (episodesRef = el)}>
            <Show
              when={!episodes.loading}
              fallback={
                <div class="sp-episodes-state">
                  <div class="hp-spinner" />
                  <span>Loading episodes…</span>
                </div>
              }
            >
              <Show
                when={(episodes() ?? []).length > 0}
                fallback={
                  <div class="sp-episodes-state">
                    <span style={{ "font-size": "2rem" }}>📭</span>
                    <span>No episodes available for this season</span>
                  </div>
                }
              >
                <For each={episodes()}>
                  {(ep, i) => (
                    <EpisodeRow
                      episode={ep}
                      season={activeSeason()}
                      onPlay={() => handlePlayEpisode(ep)}
                      focused={focusedEpIdx() === i()}
                      dataIdx={i()}
                    />
                  )}
                </For>
              </Show>
            </Show>
          </div>

          <Show when={playError()}>
            <div class="sp-ep-error-toast">
              <span>⚠ {playError()}</span>
              <button onClick={() => setPlayError(null)}>✕</button>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

// ---------------------------------------------------------------------------
// EpisodeRow — single row in the episode list
// ---------------------------------------------------------------------------

interface EpisodeRowProps {
  episode: EpisodeOut;
  season: number | null;
  onPlay: () => void;
  focused: boolean;
  dataIdx: number;
}

function EpisodeRow(props: EpisodeRowProps): JSX.Element {
  const seasonNum = () =>
    String(props.season ?? props.episode.season_number ?? 1).padStart(2, "0");
  const episodeNum = () => String(props.episode.episode_num).padStart(2, "0");
  const label = () => `S${seasonNum()}E${episodeNum()}`;

  return (
    <div
      data-ep-idx={props.dataIdx}
      class={`sp-episode-item${props.focused ? " focused" : ""}`}
      onClick={() => props.onPlay()}
    >
      <div class="sp-episode-num">{label()}</div>

      <div class="sp-episode-info">
        <p class="sp-episode-title">
          {props.episode.title ?? `Episode ${props.episode.episode_num}`}
        </p>
        <Show when={props.episode.release_date}>
          <p class="sp-episode-date">{props.episode.release_date}</p>
        </Show>
        <Show when={props.episode.plot}>
          <p class="sp-episode-plot">{props.episode.plot}</p>
        </Show>
      </div>

      <Show when={props.episode.container_extension}>
        <span class="sp-episode-ext">
          {props.episode.container_extension!.toUpperCase()}
        </span>
      </Show>

      <button
        class="sp-episode-play-btn"
        onClick={(e) => {
          e.stopPropagation();
          props.onPlay();
        }}
        title={`Play ${label()}`}
      >
        ▶
      </button>
    </div>
  );
}
