/**
 * Adult section — a single PIN-gated page hosting adult live TV and adult VOD.
 *
 * Layout mirrors the rest of the app (sidebar + content) but with ONE sidebar
 * that combines TV + VOD: its entries are the provider's adult categories,
 * shown verbatim (today: "For Adults" = TV, "Adult 4K", "Adult FHD"). The
 * main panel renders a channel list for a live entry or a movie grid for a VOD
 * entry.
 *
 * Access requires the parental PIN (once per app session). The Adult top-menu
 * item is only visible when a PIN is set + the user opted in (see TopNav), but
 * we still gate here and redirect home if someone deep-links without a PIN.
 */

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import PinOverlay from "../components/PinOverlay";
import { appShellZone, setAppShellZone } from "../stores/shell";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";
import { openPlayer } from "../stores/player";
import {
  listLive,
  listLiveCategories,
  listMovieCategories,
  listMovies,
} from "../api/catalog";
import type { LiveStreamItem, MovieListItem } from "../api/types";

const PIN_KEY = "ott_parental_pin";
const UNLOCK_KEY = "ott_adult_unlocked"; // sessionStorage — per app session
const GRID_COLS = 6;
const PAGE_SIZE = 60;

type Zone = "sidebar" | "content";

interface AdultEntry {
  /** Stable sidebar id, e.g. "live:12" / "movie:7". */
  key: string;
  kind: "live" | "movie";
  categoryId: number;
  label: string;
}

export default function Adult(): JSX.Element {
  const navigate = useNavigate();
  const { isScopeOwner } = useNavigationScope("page:adult", {
    active: true,
    priority: 30,
  });

  // ── PIN gate ────────────────────────────────────────────────────────────
  const hasPin = !!localStorage.getItem(PIN_KEY);
  const [unlocked, setUnlocked] = createSignal(
    hasPin && sessionStorage.getItem(UNLOCK_KEY) === "1",
  );

  onMount(() => {
    // Defensive: the menu item is hidden without a PIN, but a deep link
    // shouldn't reach adult content.
    if (!hasPin) navigate("/home", { replace: true });
  });

  const onPinSuccess = () => {
    try {
      sessionStorage.setItem(UNLOCK_KEY, "1");
    } catch {
      /* ignore */
    }
    setUnlocked(true);
  };

  // ── Adult categories → sidebar entries ──────────────────────────────────
  const [entries] = createResource<AdultEntry[], boolean>(
    () => unlocked(), // only fetch once unlocked
    async (gate: boolean) => {
      if (!gate) return [];
      const [live, movies] = await Promise.all([
        listLiveCategories(true).catch(() => []),
        listMovieCategories(true).catch(() => []),
      ]);
      const liveEntries: AdultEntry[] = live
        // Only leaf live categories (those with an upstream id carry channels).
        .filter((c) => c.category_id != null)
        .map((c) => ({
          key: `live:${c.id}`,
          kind: "live" as const,
          categoryId: c.id,
          label: c.name,
        }));
      const movieEntries: AdultEntry[] = movies
        .map((c) => ({
          key: `movie:${c.id}`,
          kind: "movie" as const,
          categoryId: c.id,
          label: c.name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return [...liveEntries, ...movieEntries];
    },
  );

  const sidebarItems = createMemo<SidebarItem[]>(() =>
    (entries() ?? []).map((e) => ({ id: e.key, label: e.label })),
  );

  // ── Selection + zone state ──────────────────────────────────────────────
  const [zone, setZone] = createSignal<Zone>("sidebar");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [contentIdx, setContentIdx] = createSignal(0);

  const selected = createMemo<AdultEntry | null>(
    () => (entries() ?? [])[sidebarIdx()] ?? null,
  );

  // Auto-select the first entry once categories land.
  createEffect(
    on(entries, (list) => {
      if (list && list.length > 0 && sidebarIdx() >= list.length) {
        setSidebarIdx(0);
      }
    }),
  );

  // ── Content: movies (paginated grid) or channels (flat list) ────────────
  const [movies, setMovies] = createSignal<MovieListItem[]>([]);
  const [moviePage, setMoviePage] = createSignal(1);
  const [movieHasNext, setMovieHasNext] = createSignal(false);
  const [channels, setChannels] = createSignal<LiveStreamItem[]>([]);
  const [loading, setLoading] = createSignal(false);

  const loadEntry = async (entry: AdultEntry | null) => {
    setContentIdx(0);
    setMovies([]);
    setChannels([]);
    setMovieHasNext(false);
    setMoviePage(1);
    if (!entry) return;
    setLoading(true);
    try {
      if (entry.kind === "movie") {
        const resp = await listMovies({
          adult_only: true,
          category_id: entry.categoryId,
          sort: "added_desc",
          page: 1,
          per_page: PAGE_SIZE,
        });
        setMovies(resp.items);
        setMovieHasNext(resp.has_next);
      } else {
        const resp = await listLive({
          adult_only: true,
          category_id: entry.categoryId,
          per_page: 500,
        });
        setChannels(resp.items);
      }
    } catch {
      /* leave empty — the panel shows an empty state */
    } finally {
      setLoading(false);
    }
  };

  // Reload whenever the selected entry changes.
  createEffect(on(selected, (entry) => void loadEntry(entry)));

  const loadMoreMovies = async () => {
    const entry = selected();
    if (!entry || entry.kind !== "movie" || !movieHasNext() || loading()) return;
    setLoading(true);
    try {
      const next = moviePage() + 1;
      const resp = await listMovies({
        adult_only: true,
        category_id: entry.categoryId,
        sort: "added_desc",
        page: next,
        per_page: PAGE_SIZE,
      });
      setMovies((prev) => [...prev, ...resp.items]);
      setMoviePage(next);
      setMovieHasNext(resp.has_next);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  // ── Activation ──────────────────────────────────────────────────────────
  const playMovie = (m: MovieListItem) => openPlayer({ kind: "movie", movie: m });
  const playChannel = (index: number) => {
    const list = channels();
    const ch = list[index];
    if (ch) openPlayer({ kind: "live", channel: ch, channels: list, index });
  };

  const activateContent = () => {
    const entry = selected();
    if (!entry) return;
    if (entry.kind === "movie") {
      const m = movies()[contentIdx()];
      if (m) playMovie(m);
    } else {
      playChannel(contentIdx());
    }
  };

  const contentCount = () =>
    selected()?.kind === "movie" ? movies().length : channels().length;
  const cols = () => (selected()?.kind === "movie" ? GRID_COLS : 1);

  // ── Keyboard navigation ─────────────────────────────────────────────────
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;
      // While the PIN overlay is open it captures input itself.
      if (!unlocked()) return;
      if (!isDirectionalKey(e.key) && !isSelectKey(e.key)) return;
      e.preventDefault();

      if (zone() === "sidebar") {
        const n = (entries() ?? []).length;
        switch (e.key) {
          case "ArrowUp":
            if (sidebarIdx() === 0) setAppShellZone("nav");
            else setSidebarIdx((i) => Math.max(0, i - 1));
            break;
          case "ArrowDown":
            setSidebarIdx((i) => Math.min(n - 1, i + 1));
            break;
          case "ArrowRight":
          case "Enter":
          case " ":
            if (contentCount() > 0) setZone("content");
            break;
        }
        return;
      }

      // content zone
      const count = contentCount();
      const c = cols();
      const idx = contentIdx();
      switch (e.key) {
        case "ArrowLeft":
          if (idx % c === 0) setZone("sidebar");
          else setContentIdx(idx - 1);
          break;
        case "ArrowRight":
          if (idx % c !== c - 1 && idx + 1 < count) setContentIdx(idx + 1);
          break;
        case "ArrowUp":
          if (idx < c) setAppShellZone("nav");
          else setContentIdx(idx - c);
          break;
        case "ArrowDown": {
          const next = idx + c;
          if (next < count) {
            setContentIdx(next);
          }
          // Near the end of a movie grid — pull the next page.
          if (next >= count - c) void loadMoreMovies();
          break;
        }
        case "Enter":
        case " ":
          activateContent();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  // Infinite-scroll sentinel for the movie grid (mouse users). The sentinel is
  // conditionally rendered, so attach the observer via its ref callback.
  const io = new IntersectionObserver((es) => {
    if (es.some((x) => x.isIntersecting)) void loadMoreMovies();
  });
  onCleanup(() => io.disconnect());
  const attachSentinel = (el: HTMLDivElement) => io.observe(el);

  const posterOf = (m: MovieListItem) =>
    m.cover_big || m.backdrop_path || m.stream_icon || "";

  return (
    <div class="series-page sp-browser live-page">
      <Show
        when={unlocked()}
        fallback={
          <PinOverlay
            open={!unlocked()}
            onSuccess={onPinSuccess}
            onCancel={() => navigate("/home", { replace: true })}
            title="Adult Content"
            subtitle="Enter your PIN to continue"
          />
        }
      >
        <div class="sp-body lp-body" style={{ display: "flex", gap: "1rem" }}>
          <Sidebar
            title="Adult"
            items={sidebarItems()}
            activeId={() => selected()?.key ?? null}
            focusedIdx={sidebarIdx}
            isFocused={() => appShellZone() === "content" && zone() === "sidebar"}
            emptyLabel="No adult categories"
            onSelect={(_item, i) => {
              setSidebarIdx(i);
              setZone("sidebar");
            }}
          />

          <div style={{ flex: "1", "min-width": "0", "overflow-y": "auto" }}>
            <Show
              when={!loading() || contentCount() > 0}
              fallback={<p class="sidebar-empty">Loading…</p>}
            >
              {/* Movie grid */}
              <Show when={selected()?.kind === "movie"}>
                <div
                  style={{
                    display: "grid",
                    "grid-template-columns": `repeat(${GRID_COLS}, minmax(0, 1fr))`,
                    gap: "0.75rem",
                    padding: "0.5rem",
                  }}
                >
                  <For each={movies()}>
                    {(m, i) => (
                      <button
                        type="button"
                        onClick={() => {
                          setContentIdx(i());
                          setZone("content");
                          playMovie(m);
                        }}
                        class={`rounded-md overflow-hidden bg-zinc-900 outline-none text-left ${
                          appShellZone() === "content" &&
                          zone() === "content" &&
                          contentIdx() === i()
                            ? "ring-2 ring-violet-400"
                            : ""
                        }`}
                      >
                        <div class="aspect-[2/3] w-full bg-zinc-800">
                          <Show when={posterOf(m)}>
                            <img
                              src={posterOf(m)}
                              alt={m.name}
                              loading="lazy"
                              class="h-full w-full object-cover"
                              draggable={false}
                            />
                          </Show>
                        </div>
                        <div class="p-1.5 text-xs text-zinc-300 truncate">
                          {m.name}
                        </div>
                      </button>
                    )}
                  </For>
                </div>
                <div ref={attachSentinel} style={{ height: "1px" }} />
                <Show when={movies().length === 0 && !loading()}>
                  <p class="sidebar-empty">No titles in this category.</p>
                </Show>
              </Show>

              {/* Channel list */}
              <Show when={selected()?.kind === "live"}>
                <div style={{ display: "flex", "flex-direction": "column", gap: "0.25rem", padding: "0.5rem" }}>
                  <For each={channels()}>
                    {(ch, i) => (
                      <button
                        type="button"
                        onClick={() => {
                          setContentIdx(i());
                          setZone("content");
                          playChannel(i());
                        }}
                        class={`flex items-center gap-3 rounded-md px-3 py-2 text-left outline-none ${
                          appShellZone() === "content" &&
                          zone() === "content" &&
                          contentIdx() === i()
                            ? "ring-2 ring-violet-400 bg-violet-600/20"
                            : "bg-zinc-900/60 hover:bg-zinc-800"
                        }`}
                      >
                        <div class="h-8 w-12 flex-shrink-0 bg-zinc-800 rounded">
                          <Show when={ch.stream_icon}>
                            <img
                              src={ch.stream_icon!}
                              alt=""
                              loading="lazy"
                              class="h-full w-full object-contain"
                              draggable={false}
                            />
                          </Show>
                        </div>
                        <span class="text-sm text-zinc-200 truncate">{ch.name}</span>
                      </button>
                    )}
                  </For>
                  <Show when={channels().length === 0 && !loading()}>
                    <p class="sidebar-empty">No channels in this category.</p>
                  </Show>
                </div>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
