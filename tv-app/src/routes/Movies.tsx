import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  listMovieCategories,
  listMovieGenres,
  listMovies,
} from "../api/catalog";
import type {
  FlatCategory,
  GenreCountOut,
  MovieListItem,
  MovieSort,
} from "../api/types";
import PosterCard from "../components/PosterCard";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import SortSelector from "../components/SortSelector";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";
import { sidebarOpen, setSidebarOpen } from "../lib/sidebarPrefs";
import {
  MOVIE_SORT_OPTIONS,
  movieSort,
  setMovieSort,
} from "../lib/sortPrefs";
import { authUser } from "../stores/auth";
import { appShellZone, setAppShellZone } from "../stores/shell";

/**
 * Movies — Amazon-style catalog browse.
 *
 *   ┌── Sidebar ──┬── Sort: [Most Recent] [Top Rated] ── ──────┐
 *   │ All movies  │  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐                │
 *   │ Action 3059 │  │  │ │  │ │  │ │  │ │  │                │
 *   │ Comedy 4051 │  └──┘ └──┘ └──┘ └──┘ └──┘                │
 *   │ Drama  ...  │  ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐                │
 *   │             │  │  │ │  │ │  │ │  │ │  │  ← infinite    │
 *   │             │  └──┘ └──┘ └──┘ └──┘ └──┘    scroll      │
 *   └─────────────┴────────────────────────────────────────────┘
 *
 * One vertical scrolling container per page; the sidebar genre/category
 * picker swaps the *content* of that container. Infinite scroll appends
 * the next page when the cursor approaches the last loaded row.
 *
 * D-pad zones:
 *   sidebar / sort / grid
 *
 * Grid nav:
 *   ←/→  move within row (← at col 0 opens sidebar)
 *   ↑/↓  move between rows (↑ at row 0 lands on "sort"; ↓ past last
 *        loaded row triggers next page)
 */

const PAGE_SIZE = 50;
const COLS = 5;
/** When the cursor is within this many items of the end, prefetch next page. */
const PREFETCH_AHEAD = 10;

function posterUrl(m: MovieListItem): string | null {
  return m.cover_big || m.stream_icon || null;
}

export default function MoviesPage() {
  const navigate = useNavigate();
  const isCurated = () => authUser()?.view_mode === "curated";

  const [genres] = createResource(
    () => isCurated(),
    (curated) => (curated ? listMovieGenres() : Promise.resolve([])),
  );
  const [categories] = createResource(
    () => !isCurated(),
    (fallback) => (fallback ? listMovieCategories() : Promise.resolve([])),
  );

  // ---------------------------------------------------------------------------
  // Sidebar source — genres for curated providers, categories otherwise
  // ---------------------------------------------------------------------------

  interface FilterDescriptor {
    id: number | null; // null = "All"
    label: string;
    count?: number;
    filterKey: "genre_id" | "category_id" | null;
  }

  const filters = createMemo<FilterDescriptor[]>(() => {
    if (isCurated()) {
      const gs: GenreCountOut[] = genres() ?? [];
      return [
        { id: null, label: "All movies", filterKey: null },
        ...gs.map((g) => ({
          id: g.id,
          label: g.name,
          count: g.count,
          filterKey: "genre_id" as const,
        })),
      ];
    }
    const cs: FlatCategory[] = categories() ?? [];
    return [
      { id: null, label: "All movies", filterKey: null },
      ...cs.map((c) => ({
        id: c.category_id,
        label: c.name,
        filterKey: "category_id" as const,
      })),
    ];
  });

  const sidebarItems = createMemo<SidebarItem[]>(() =>
    filters().map((f) => ({
      id: f.id ?? "__all__",
      label: f.label,
      count: f.count,
    })),
  );

  // ---------------------------------------------------------------------------
  // Selected filter (sidebar selection that's been "committed" via Enter or →)
  // ---------------------------------------------------------------------------

  const [selectedFilterIdx, setSelectedFilterIdx] = createSignal(0);
  const selectedFilter = createMemo<FilterDescriptor | null>(
    () => filters()[selectedFilterIdx()] ?? null,
  );

  // ---------------------------------------------------------------------------
  // Paginated grid state
  //
  // We accumulate pages into `items`. When the filter or sort changes the
  // accumulator resets and page 1 is fetched.
  // ---------------------------------------------------------------------------

  const [items, setItems] = createSignal<MovieListItem[]>([]);
  const [pageNum, setPageNum] = createSignal(0); // 0 = none loaded
  const [hasNext, setHasNext] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  /** Tracks the (sort, filterKey, filterId) combination of the currently-loaded
   *  pages so async responses can be discarded if the user changed filters
   *  while a fetch was in flight. */
  let loadEpoch = 0;

  async function loadPage(next: number) {
    if (loading()) return;
    const epoch = ++loadEpoch;
    const f = selectedFilter();
    const sort = movieSort();
    setLoading(true);
    try {
      const args: {
        sort: MovieSort;
        per_page: number;
        page: number;
        genre_id?: number;
        category_id?: number;
      } = { sort, per_page: PAGE_SIZE, page: next };
      if (f?.filterKey === "genre_id" && f.id != null) args.genre_id = f.id;
      else if (f?.filterKey === "category_id" && f.id != null)
        args.category_id = f.id;
      const page = await listMovies(args);
      if (epoch !== loadEpoch) return; // user moved on; drop response
      setItems((prev) => (next === 1 ? page.items : [...prev, ...page.items]));
      setPageNum(next);
      setHasNext(page.has_next);
    } finally {
      if (epoch === loadEpoch) setLoading(false);
    }
  }

  /** Reset + load page 1 whenever the filter or sort changes. */
  createEffect(
    on(
      () => [selectedFilter()?.id ?? null, movieSort()] as const,
      () => {
        setItems([]);
        setPageNum(0);
        setHasNext(false);
        setCursor(0);
        loadPage(1);
      },
    ),
  );

  // ---------------------------------------------------------------------------
  // Navigation state
  // ---------------------------------------------------------------------------

  type Zone = "sidebar" | "sort" | "grid";
  const [zone, setZone] = createSignal<Zone>("grid");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [sortIdx, setSortIdx] = createSignal(0);
  /** Cursor in the grid, as an absolute item index. */
  const [cursor, setCursor] = createSignal(0);

  const { isScopeOwner, setActive } = useNavigationScope("movies", {
    priority: 0,
    active: appShellZone() === "content",
  });
  createEffect(() => setActive(appShellZone() === "content"));

  // Keep the sort row's focused-pill in sync with the persisted sort signal
  createEffect(() => {
    const cur = movieSort();
    const idx = MOVIE_SORT_OPTIONS.findIndex((o) => o.value === cur);
    if (idx >= 0) setSortIdx(idx);
  });

  /** Trigger prefetch when cursor approaches the end of loaded items. */
  createEffect(() => {
    const c = cursor();
    const total = items().length;
    if (
      hasNext() &&
      !loading() &&
      total > 0 &&
      c >= total - PREFETCH_AHEAD
    ) {
      loadPage(pageNum() + 1);
    }
  });

  // ---------------------------------------------------------------------------
  // Sidebar interaction
  // ---------------------------------------------------------------------------

  function commitSidebar(idx: number) {
    setSelectedFilterIdx(idx);
    setSidebarIdx(idx);
    setZone("grid");
  }

  // ---------------------------------------------------------------------------
  // Keyboard handling
  // ---------------------------------------------------------------------------

  function moveVertical(delta: 1 | -1) {
    const cur = zone();
    if (cur === "sidebar") {
      const next = sidebarIdx() + delta;
      if (next < 0) {
        setAppShellZone("nav");
        return;
      }
      if (next >= filters().length) return;
      setSidebarIdx(next);
      // Live preview: ↑/↓ in sidebar swaps the grid content immediately
      setSelectedFilterIdx(next);
      return;
    }
    if (cur === "sort") {
      if (delta < 0) {
        setAppShellZone("nav");
        return;
      }
      setZone("grid");
      return;
    }
    // grid
    const c = cursor();
    if (delta < 0) {
      if (c < COLS) {
        setZone("sort");
        return;
      }
      setCursor(c - COLS);
      return;
    }
    const total = items().length;
    if (total === 0) return;
    const target = c + COLS;
    setCursor(Math.min(target, total - 1));
  }

  function moveHorizontal(delta: 1 | -1) {
    const cur = zone();
    if (cur === "sidebar") {
      if (delta < 0) {
        setSidebarOpen(false);
        setZone("grid");
        return;
      }
      // → on a sidebar item commits and drops focus into the grid
      commitSidebar(sidebarIdx());
      return;
    }
    if (cur === "sort") {
      const max = MOVIE_SORT_OPTIONS.length - 1;
      if (delta < 0 && sortIdx() === 0) {
        setSidebarOpen(true);
        setZone("sidebar");
        return;
      }
      setSortIdx((i) => Math.min(Math.max(i + delta, 0), max));
      return;
    }
    // grid
    const c = cursor();
    const total = items().length;
    if (total === 0) {
      if (delta < 0) {
        setSidebarOpen(true);
        setZone("sidebar");
      }
      return;
    }
    const col = c % COLS;
    if (delta < 0) {
      if (col === 0) {
        setSidebarOpen(true);
        setZone("sidebar");
        return;
      }
      setCursor(c - 1);
      return;
    }
    // delta > 0
    if (col === COLS - 1 || c === total - 1) return;
    setCursor(c + 1);
  }

  function activate() {
    const cur = zone();
    if (cur === "sidebar") {
      commitSidebar(sidebarIdx());
      return;
    }
    if (cur === "sort") {
      setMovieSort(MOVIE_SORT_OPTIONS[sortIdx()].value);
      return;
    }
    const item = items()[cursor()];
    if (item) navigate(`/movies/${item.id}`);
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="flex h-[calc(100vh-49px)]">
      <Show when={sidebarOpen()}>
        <Sidebar
          title={isCurated() ? "Genres" : "Categories"}
          items={sidebarItems()}
          activeId={() => filters()[selectedFilterIdx()]?.id ?? "__all__"}
          focusedIdx={sidebarIdx}
          isFocused={() => zone() === "sidebar"}
          onSelect={(_, i) => commitSidebar(i)}
        />
      </Show>

      <div class="flex-1 overflow-y-auto relative">
        <Show when={!sidebarOpen()}>
          <div class="absolute top-3 left-3 z-10 text-[11px] text-zinc-600 select-none pointer-events-none">
            ← filters
          </div>
        </Show>

        <SortSelector
          value={movieSort}
          options={MOVIE_SORT_OPTIONS}
          onChange={(v) => setMovieSort(v)}
          isFocused={() => zone() === "sort"}
          focusedIdx={sortIdx}
        />

        <Show
          when={items().length > 0}
          fallback={
            <div class="h-[40vh] flex items-center justify-center text-zinc-600 text-sm">
              <Show
                when={loading() && items().length === 0}
                fallback={<span>Nothing matches this filter.</span>}
              >
                Loading…
              </Show>
            </div>
          }
        >
          <div class="px-8 pb-12">
            <h2 class="text-lg font-medium mb-3">
              {selectedFilter()?.label ?? "All movies"}
              <Show when={selectedFilter()?.count != null}>
                <span class="ml-2 text-xs text-zinc-500">
                  · {selectedFilter()!.count!.toLocaleString()}
                </span>
              </Show>
            </h2>
            <div
              class="grid gap-3"
              style={{ "grid-template-columns": `repeat(${COLS}, minmax(0, 1fr))` }}
            >
              <For each={items()}>
                {(item, i) => (
                  <PosterCard
                    title={item.name}
                    imageUrl={posterUrl(item)}
                    focused={() =>
                      isScopeOwner() && zone() === "grid" && cursor() === i()
                    }
                    onClick={() => {
                      setZone("grid");
                      setCursor(i());
                      navigate(`/movies/${item.id}`);
                    }}
                    meta={
                      <>
                        {item.year && <span>{item.year}</span>}
                        {item.tmdb_vote_average != null && (
                          <span class="ml-2">
                            ★ {item.tmdb_vote_average.toFixed(1)}
                          </span>
                        )}
                      </>
                    }
                  />
                )}
              </For>
            </div>
            <Show when={loading() && items().length > 0}>
              <p class="mt-6 text-center text-xs text-zinc-600">Loading more…</p>
            </Show>
            <Show when={!hasNext() && items().length > 0 && pageNum() > 0}>
              <p class="mt-6 text-center text-xs text-zinc-700">
                End of list · {items().length} items
              </p>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
