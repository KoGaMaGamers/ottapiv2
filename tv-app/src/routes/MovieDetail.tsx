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
import { getMovie } from "../api/catalog";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";
import { appShellZone, setAppShellZone } from "../stores/shell";

/**
 * Movie detail page.
 *
 *   ┌── Backdrop (fade to bg) ─────────────────────────┐
 *   │  Cover + title + year/runtime/rating + plot      │
 *   │  Cast + director                                  │
 *   │                                                   │
 *   │  [▶ Play]  [+ Watchlist]  [Back]                  │
 *   └───────────────────────────────────────────────────┘
 *
 * Single zone of focusable buttons. Up at the first row → TopNav.
 * Back goes to history.back() (Home, Movies listing, etc.).
 *
 * Real Play behavior wires in step 12 (player) — for now it routes
 * to a placeholder.
 */

const ACTIONS: { key: string; label: string }[] = [
  { key: "play", label: "▶ Play" },
  { key: "watchlist", label: "+ Watchlist" },
  { key: "back", label: "Back" },
];

function fmtRuntime(secs?: number | null): string | null {
  if (!secs || secs <= 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

export default function MovieDetail() {
  const params = useParams<{ id: string }>();

  const [movie] = createResource(
    () => Number(params.id),
    (id) => getMovie(id),
  );

  const [focusedIdx, setFocusedIdx] = createSignal(0);

  const { isScopeOwner, setActive } = useNavigationScope("movie-detail", {
    priority: 0,
    active: appShellZone() === "content",
  });
  createEffect(() => setActive(appShellZone() === "content"));

  function activate() {
    const action = ACTIONS[focusedIdx()];
    if (!action) return;
    switch (action.key) {
      case "play":
        // Step 12 wires the actual /play call + player. For now,
        // log + visual feedback only.
        // eslint-disable-next-line no-console
        console.info("[movie-detail] play would invoke /api/v1/play/movie/" + params.id);
        break;
      case "watchlist":
        // Step 15.
        // eslint-disable-next-line no-console
        console.info("[movie-detail] watchlist toggle (step 15)");
        break;
      case "back":
        history.back();
        break;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!isScopeOwner()) return;
    if (!isDirectionalKey(e.key) && !isSelectKey(e.key)) return;
    e.preventDefault();
    switch (e.key) {
      case "ArrowLeft":
        setFocusedIdx((i) => Math.max(i - 1, 0));
        break;
      case "ArrowRight":
        setFocusedIdx((i) => Math.min(i + 1, ACTIONS.length - 1));
        break;
      case "ArrowUp":
        setAppShellZone("nav");
        break;
      case "ArrowDown":
        // No second focusable row yet — could be related-movies later
        break;
      case "Enter":
      case " ":
        activate();
        break;
    }
  }

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // Convenience derived values
  const m = createMemo(() => movie());
  const runtimeText = createMemo(() => {
    const x = m();
    if (!x) return null;
    return fmtRuntime(x.duration_secs ?? null) ?? x.duration ?? null;
  });

  return (
    <Show
      when={m()}
      fallback={
        <div class="h-[60vh] flex items-center justify-center text-zinc-500 text-sm">
          <Show when={movie.loading} fallback={<span>Movie not found.</span>}>
            Loading movie…
          </Show>
        </div>
      }
    >
      {(getter) => {
        const x = getter();
        return (
          <div class="relative">
            {/* Backdrop with gradient fade */}
            <div class="absolute inset-x-0 top-0 h-[60vh] -z-10 overflow-hidden">
              <Show when={x.backdrop_path}>
                <img
                  src={x.backdrop_path!}
                  alt=""
                  class="w-full h-full object-cover opacity-50"
                />
              </Show>
              <div class="absolute inset-0 bg-gradient-to-t from-[#0b0b0b] via-[#0b0b0b]/70 to-transparent" />
              <div class="absolute inset-0 bg-gradient-to-r from-[#0b0b0b]/95 via-[#0b0b0b]/40 to-transparent" />
            </div>

            <div class="px-8 py-12 flex gap-8 items-start">
              {/* Poster */}
              <Show when={x.cover_big || x.stream_icon}>
                <img
                  src={x.cover_big || x.stream_icon!}
                  alt={x.name}
                  class="w-56 aspect-[2/3] object-cover rounded-lg ring-1 ring-zinc-800 shadow-xl"
                />
              </Show>

              {/* Title + meta + plot */}
              <div class="flex-1 min-w-0">
                <h1 class="text-4xl font-semibold mb-2">{x.name}</h1>
                <Show when={x.o_name && x.o_name !== x.name}>
                  <p class="text-zinc-500 mb-3 italic">{x.o_name}</p>
                </Show>

                <div class="flex gap-3 text-sm text-zinc-400 mb-4">
                  <Show when={x.year}>
                    <span>{x.year}</span>
                  </Show>
                  <Show when={runtimeText()}>
                    <span>{runtimeText()}</span>
                  </Show>
                  <Show when={x.tmdb_vote_average != null}>
                    <span class="text-yellow-400">★ {x.tmdb_vote_average!.toFixed(1)}</span>
                  </Show>
                  <Show when={x.age_rating}>
                    <span class="px-1.5 py-0.5 ring-1 ring-zinc-700 rounded text-[11px]">
                      {x.age_rating}
                    </span>
                  </Show>
                  <Show when={x.country}>
                    <span class="text-zinc-500">{x.country}</span>
                  </Show>
                </div>

                <Show when={x.genres.length > 0}>
                  <div class="flex gap-2 mb-5">
                    <For each={x.genres}>
                      {(g) => (
                        <span class="text-xs px-2 py-0.5 rounded-full bg-zinc-800/80 ring-1 ring-zinc-700">
                          {g}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={x.description}>
                  <p class="text-zinc-300 leading-relaxed mb-6 max-w-3xl">
                    {x.description}
                  </p>
                </Show>

                <Show when={x.director}>
                  <p class="text-sm text-zinc-400 mb-1">
                    <span class="text-zinc-500">Director: </span>
                    {x.director}
                  </p>
                </Show>
                <Show when={x.actors}>
                  <p class="text-sm text-zinc-400 mb-6">
                    <span class="text-zinc-500">Cast: </span>
                    {x.actors}
                  </p>
                </Show>

                {/* Action buttons */}
                <div class="flex gap-3">
                  <For each={ACTIONS}>
                    {(action, i) => {
                      const focused = () =>
                        isScopeOwner() && focusedIdx() === i();
                      const primary = action.key === "play";
                      return (
                        <button
                          onClick={() => {
                            setFocusedIdx(i());
                            activate();
                          }}
                          class={`rounded-md px-5 py-2 text-sm font-medium outline-none transition-all ${
                            primary
                              ? "bg-violet-600 hover:bg-violet-500 text-white"
                              : "bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 ring-1 ring-zinc-700"
                          } ${
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
          </div>
        );
      }}
    </Show>
  );
}
