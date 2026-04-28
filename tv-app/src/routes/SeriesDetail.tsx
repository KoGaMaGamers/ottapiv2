/**
 * Series detail page — restored from the pre-revert design.
 *
 *   ┌── Backdrop fade ──────────────────────────────────────┐
 *   │  Cover + title + year/runtime/rating + plot           │
 *   │  Cast + director                                      │
 *   │  [+ Watchlist]  [Back]                                │
 *   ├──── Seasons (chip row) ───────────────────────────────┤
 *   │  [Specials] [Season 1] [Season 2] ...                 │
 *   ├──── Episodes (horizontal cards) ──────────────────────┤
 *   │  ┌──────┐ ┌──────┐ ┌──────┐                           │
 *   │  │ S1E1 │ │ S1E2 │ │ S1E3 │                           │
 *   │  └──────┘ └──────┘ └──────┘                           │
 *   └───────────────────────────────────────────────────────┘
 *
 * Three D-pad zones: actions → seasons → episodes (top→bottom). Up at
 * actions hands focus to TopNav via appShellZone. Selecting a season
 * chip with ←/→ auto-loads its episodes — no Enter required (matches
 * Netflix-style instant feedback). Enter on an episode card stubs Play
 * (logs to console) until MediaPlayer + heartbeat ports.
 */

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { getSeasonEpisodes, getSeries } from "../api/catalog";
import type { EpisodeOut, SeasonOut } from "../api/types";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";
import { appShellZone, setAppShellZone } from "../stores/shell";
import { openPlayer } from "../stores/player";

type Zone = "actions" | "seasons" | "episodes";
const ZONES: Zone[] = ["actions", "seasons", "episodes"];

const ACTIONS: { key: string; label: string }[] = [
  { key: "watchlist", label: "+ Watchlist" },
  { key: "back", label: "Back" },
];

function fmtDuration(secs?: number | null): string | null {
  if (!secs || secs <= 0) return null;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function epLabel(ep: EpisodeOut): string {
  const s = `S${String(ep.season_number).padStart(2, "0")}`;
  const e = `E${String(ep.episode_num).padStart(2, "0")}`;
  return `${s}${e}`;
}

export interface SeriesDetailProps {
  /**
   * When provided, the component renders the given series id directly
   * (used when Series.tsx mounts SeriesDetail as a popup overlay
   * without navigating the route — keeps the listing's grid focus
   * intact). When omitted, the id is read from the /series/:id route
   * params (the dedicated-page entry path used by Search and direct
   * URLs).
   */
  id?: number;
  /**
   * Called when the user closes the detail (Esc / Back / scrim click).
   * When omitted, falls back to history.back() — the original
   * dedicated-page behaviour.
   */
  onClose?: () => void;
}

export default function SeriesDetail(props: SeriesDetailProps = {}) {
  const params = useParams<{ id: string }>();
  const close = () => {
    if (props.onClose) props.onClose();
    else history.back();
  };

  const [series] = createResource(
    () => props.id ?? Number(params.id),
    (id) => getSeries(id),
  );

  // Active season is a season_number (not an index) since legacy may have
  // season 0 = Specials. Default to first available season once data lands.
  const [activeSeason, setActiveSeason] = createSignal<number | null>(null);

  createEffect(() => {
    const s = series();
    if (s && activeSeason() === null && s.seasons.length > 0) {
      const sorted = [...s.seasons].sort(
        (a, b) => a.season_number - b.season_number,
      );
      setActiveSeason(sorted[0].season_number);
    }
  });

  const seasons = createMemo<SeasonOut[]>(() => {
    const s = series();
    if (!s) return [];
    return [...s.seasons].sort((a, b) => a.season_number - b.season_number);
  });

  const [episodes] = createResource(
    () => {
      const sn = activeSeason();
      const sid = props.id ?? Number(params.id);
      if (sn === null) return null;
      return { sid, sn };
    },
    (k) =>
      k ? getSeasonEpisodes(k.sid, k.sn) : Promise.resolve([] as EpisodeOut[]),
  );

  // ---------------------------------------------------------------------------
  // Navigation state
  // ---------------------------------------------------------------------------

  const [zone, setZone] = createSignal<Zone>("actions");
  const [actionIdx, setActionIdx] = createSignal(0);
  const [episodeIdx, setEpisodeIdx] = createSignal(0);

  // Reset episode index when the season changes.
  createEffect(() => {
    activeSeason();
    setEpisodeIdx(0);
  });

  const seasonIdx = createMemo<number>(() => {
    const sn = activeSeason();
    if (sn === null) return 0;
    return Math.max(seasons().findIndex((s) => s.season_number === sn), 0);
  });

  const { isScopeOwner, setActive } = useNavigationScope("series-detail", {
    priority: 30,
    active: appShellZone() === "content",
  });
  createEffect(() => setActive(appShellZone() === "content"));

  function moveVertical(delta: 1 | -1) {
    const idx = ZONES.indexOf(zone());
    const next = idx + delta;
    if (next < 0) {
      setAppShellZone("nav");
      return;
    }
    if (next >= ZONES.length) return;
    setZone(ZONES[next]);
  }

  function moveHorizontal(delta: 1 | -1) {
    const cur = zone();
    if (cur === "actions") {
      setActionIdx((i) =>
        Math.min(Math.max(i + delta, 0), ACTIONS.length - 1),
      );
      return;
    }
    if (cur === "seasons") {
      const ss = seasons();
      if (ss.length === 0) return;
      const nextIdx = Math.min(
        Math.max(seasonIdx() + delta, 0),
        ss.length - 1,
      );
      setActiveSeason(ss[nextIdx].season_number);
      return;
    }
    // episodes
    const eps = episodes() ?? [];
    if (eps.length === 0) return;
    setEpisodeIdx((i) => Math.min(Math.max(i + delta, 0), eps.length - 1));
  }

  function activate() {
    const cur = zone();
    if (cur === "actions") {
      const a = ACTIONS[actionIdx()];
      if (!a) return;
      switch (a.key) {
        case "watchlist":
          // eslint-disable-next-line no-console
          console.info("[series-detail] watchlist toggle (deferred)");
          break;
        case "back":
          close();
          break;
      }
      return;
    }
    if (cur === "seasons") return; // selection is auto on ←/→
    // episodes
    const eps = episodes() ?? [];
    const ep = eps[episodeIdx()];
    const s = series();
    if (ep && s) {
      openPlayer({
        kind: "episode",
        series: s,
        episode: ep,
        seasonEpisodes: eps,
      });
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!isScopeOwner()) return;
    if (!isDirectionalKey(e.key) && !isSelectKey(e.key)) return;
    e.preventDefault();
    switch (e.key) {
      case "ArrowUp":
        moveVertical(-1);
        break;
      case "ArrowDown":
        moveVertical(1);
        break;
      case "ArrowLeft":
        moveHorizontal(-1);
        break;
      case "ArrowRight":
        moveHorizontal(1);
        break;
      case "Enter":
      case " ":
        activate();
        break;
    }
  }

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <Show
      when={series()}
      fallback={
        <div class="h-[60vh] flex items-center justify-center text-zinc-500 text-sm">
          <Show when={series.loading} fallback={<span>Series not found.</span>}>
            Loading series…
          </Show>
        </div>
      }
    >
      {(getter) => {
        const s = getter();
        return (
          <div class="relative">
            {/* Backdrop with gradient fade */}
            <div class="absolute inset-x-0 top-0 h-[55vh] -z-10 overflow-hidden">
              <Show when={s.backdrop_path}>
                <img
                  src={s.backdrop_path!}
                  alt=""
                  class="w-full h-full object-cover opacity-50"
                />
              </Show>
              <div class="absolute inset-0 bg-gradient-to-t from-[#0b0b0b] via-[#0b0b0b]/70 to-transparent" />
              <div class="absolute inset-0 bg-gradient-to-r from-[#0b0b0b]/95 via-[#0b0b0b]/40 to-transparent" />
            </div>

            <div class="px-8 py-12 flex gap-8 items-start">
              <Show when={s.cover}>
                <img
                  src={s.cover!}
                  alt={s.name}
                  class="w-56 aspect-[2/3] object-cover rounded-lg ring-1 ring-zinc-800 shadow-xl"
                />
              </Show>

              <div class="flex-1 min-w-0">
                <h1 class="text-4xl font-semibold mb-2">{s.name}</h1>
                <Show when={s.o_name && s.o_name !== s.name}>
                  <p class="text-zinc-500 mb-3 italic">{s.o_name}</p>
                </Show>

                <div class="flex gap-3 text-sm text-zinc-400 mb-4">
                  <Show when={s.release_date}>
                    <span>{s.release_date!.slice(0, 4)}</span>
                  </Show>
                  <Show when={s.episode_run_time}>
                    <span>{s.episode_run_time} min/ep</span>
                  </Show>
                  <Show when={s.tmdb_vote_average != null}>
                    <span class="text-yellow-400">
                      ★ {s.tmdb_vote_average!.toFixed(1)}
                    </span>
                  </Show>
                </div>

                <Show when={s.genres.length > 0}>
                  <div class="flex gap-2 mb-5">
                    <For each={s.genres}>
                      {(g) => (
                        <span class="text-xs px-2 py-0.5 rounded-full bg-zinc-800/80 ring-1 ring-zinc-700">
                          {g}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={s.plot}>
                  <p class="text-zinc-300 leading-relaxed mb-6 max-w-3xl">
                    {s.plot}
                  </p>
                </Show>

                <Show when={s.director}>
                  <p class="text-sm text-zinc-400 mb-1">
                    <span class="text-zinc-500">Director: </span>
                    {s.director}
                  </p>
                </Show>
                <Show when={s.cast}>
                  <p class="text-sm text-zinc-400 mb-6">
                    <span class="text-zinc-500">Cast: </span>
                    {s.cast}
                  </p>
                </Show>

                {/* Action buttons */}
                <div class="flex gap-3">
                  <For each={ACTIONS}>
                    {(action, i) => {
                      const focused = () =>
                        isScopeOwner() &&
                        zone() === "actions" &&
                        actionIdx() === i();
                      return (
                        <button
                          onClick={() => {
                            setZone("actions");
                            setActionIdx(i());
                            activate();
                          }}
                          class={`rounded-md px-5 py-2 text-sm font-medium outline-none transition-all bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 ring-1 ring-zinc-700 ${
                            focused() ? "ring-2 ring-violet-300 scale-105" : ""
                          }`}
                        >
                          {action.label}
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
            </div>

            {/* Seasons */}
            <Show when={seasons().length > 0}>
              <section class="px-8 mb-3">
                <h2
                  class={`text-sm font-medium mb-2 ${
                    zone() === "seasons" ? "text-white" : "text-zinc-400"
                  }`}
                >
                  Seasons
                </h2>
                <div class="flex gap-2 flex-wrap">
                  <For each={seasons()}>
                    {(season, i) => {
                      const isActive = () =>
                        activeSeason() === season.season_number;
                      const isFocused = () =>
                        isScopeOwner() &&
                        zone() === "seasons" &&
                        seasonIdx() === i();
                      return (
                        <button
                          onClick={() => {
                            setZone("seasons");
                            setActiveSeason(season.season_number);
                          }}
                          class={`px-3 py-1.5 rounded-md text-sm transition-colors ring-1 outline-none ${
                            isActive()
                              ? "bg-violet-600/30 text-violet-200 ring-violet-500"
                              : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:text-zinc-200"
                          } ${isFocused() ? "ring-2 ring-violet-300" : ""}`}
                        >
                          {season.season_number === 0
                            ? "Specials"
                            : `Season ${season.season_number}`}
                          <Show when={season.episode_count}>
                            <span class="ml-2 text-xs text-zinc-500">
                              {season.episode_count}
                            </span>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </section>
            </Show>

            {/* Episodes */}
            <section class="px-8 pb-12">
              <h2
                class={`text-sm font-medium mb-3 ${
                  zone() === "episodes" ? "text-white" : "text-zinc-400"
                }`}
              >
                Episodes
              </h2>
              <Show
                when={episodes() && episodes()!.length > 0}
                fallback={
                  <p class="text-sm text-zinc-600">
                    <Show
                      when={episodes.loading}
                      fallback={<span>No episodes for this season.</span>}
                    >
                      Loading episodes…
                    </Show>
                  </p>
                }
              >
                <div class="flex gap-3 overflow-x-auto scroll-smooth">
                  <For each={episodes()!}>
                    {(ep, i) => {
                      const isFocused = () =>
                        isScopeOwner() &&
                        zone() === "episodes" &&
                        episodeIdx() === i();
                      let ref: HTMLDivElement | undefined;
                      createEffect(() => {
                        if (isFocused() && ref) {
                          ref.scrollIntoView({
                            behavior: "smooth",
                            block: "nearest",
                            inline: "center",
                          });
                        }
                      });
                      return (
                        <div
                          ref={(el) => (ref = el)}
                          onClick={() => {
                            setZone("episodes");
                            setEpisodeIdx(i());
                            activate();
                          }}
                          class={`flex-shrink-0 w-72 rounded-lg overflow-hidden ring-2 transition-all cursor-pointer ${
                            isFocused()
                              ? "ring-violet-400 scale-[1.02] shadow-lg shadow-violet-900/30"
                              : "ring-zinc-800"
                          }`}
                        >
                          <div class="aspect-video bg-zinc-900 relative">
                            <Show
                              when={ep.movie_image}
                              fallback={
                                <div class="absolute inset-0 flex items-center justify-center text-zinc-700 text-xl">
                                  {epLabel(ep)}
                                </div>
                              }
                            >
                              <img
                                src={ep.movie_image!}
                                alt={ep.title ?? epLabel(ep)}
                                loading="lazy"
                                class="absolute inset-0 w-full h-full object-cover"
                              />
                              <div class="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent text-xs text-zinc-200">
                                {epLabel(ep)}
                                <Show when={fmtDuration(ep.duration_secs)}>
                                  <span class="ml-2 text-zinc-400">
                                    · {fmtDuration(ep.duration_secs)}
                                  </span>
                                </Show>
                              </div>
                            </Show>
                          </div>
                          <div class="p-2">
                            <p
                              class={`text-sm font-medium truncate ${
                                isFocused() ? "text-white" : "text-zinc-300"
                              }`}
                            >
                              {ep.title ?? epLabel(ep)}
                            </p>
                            <Show when={ep.plot}>
                              <p class="text-xs text-zinc-500 mt-1 line-clamp-2">
                                {ep.plot}
                              </p>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </section>
          </div>
        );
      }}
    </Show>
  );
}
