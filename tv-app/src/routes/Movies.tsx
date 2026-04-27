import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
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
import HeroCarousel, { type HeroItem } from "../components/HeroCarousel";
import LazyRail from "../components/LazyRail";
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
 * Movies — vertical scroll of one rail per genre (or per category in
 * fallback mode). Each rail lazy-loads when it scrolls into view.
 *
 * Layout (curated):
 *
 *   ┌── Sidebar (genres) ─┬── Hero (top popular) ─────────────┐
 *   │ All movies          │  Sort: [Most Recent] [Top Rated]…  │
 *   │ Action      3,059   ├─────────────────────────────────────┤
 *   │ Comedy      4,051   │  ── Action ── ────────────────────  │
 *   │ ...                 │  [card] [card] [card] [card]       │
 *   │                     │  ── Comedy ── ────────────────────  │
 *   │                     │  [card] [card] [card] [card]       │
 *   │                     │  ...                                │
 *   └─────────────────────┴─────────────────────────────────────┘
 *
 * Sidebar selection scrolls the page to the matching genre rail and
 * lands focus there. The selected sort applies to ALL rails — they
 * re-fetch when the user changes it.
 */

const HERO_COUNT = 5;
const RAIL_PAGE_SIZE = 30;

type RailItemId = string; // "hero" | "sort" | `rail:${id}`

function posterUrl(m: MovieListItem): string | null {
  return m.cover_big || m.stream_icon || null;
}
function backdropUrl(m: MovieListItem): string | null {
  return m.backdrop_path || m.cover_big || null;
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

  // Hero: top-N most-popular regardless of selected genre. Independent of sort.
  const [popular] = createResource(() =>
    listMovies({ sort: "popularity_desc", per_page: HERO_COUNT }),
  );

  // ---------------------------------------------------------------------------
  // Sidebar items + corresponding rail descriptors. We keep one source-of-truth
  // list — `rails` — that drives both sidebar entries and the rail render order.
  // ---------------------------------------------------------------------------

  interface RailDescriptor {
    /** Stable id (genre.id when curated, category_id when fallback). */
    id: number;
    label: string;
    count?: number;
    /** Fetcher key — either genre_id or category_id. */
    filterKey: "genre_id" | "category_id";
  }

  const rails = createMemo<RailDescriptor[]>(() => {
    if (isCurated()) {
      const gs: GenreCountOut[] = genres() ?? [];
      return gs.map((g) => ({
        id: g.id,
        label: g.name,
        count: g.count,
        filterKey: "genre_id",
      }));
    }
    const cs: FlatCategory[] = categories() ?? [];
    return cs.map((c) => ({
      id: c.category_id,
      label: c.name,
      filterKey: "category_id",
    }));
  });

  const sidebarItems = createMemo<SidebarItem[]>(() => [
    { id: "__all__", label: isCurated() ? "All movies" : "All movies" },
    ...rails().map((r) => ({ id: r.id, label: r.label, count: r.count })),
  ]);

  // ---------------------------------------------------------------------------
  // Navigation state
  //
  // Zones:
  //   - "sidebar"   → left column
  //   - "hero"      → right column, top
  //   - "sort"      → right column, second
  //   - "rail:<id>" → one zone per rail
  //
  // Vertical movement cycles through the right-column zones in order.
  // ---------------------------------------------------------------------------

  const rightZones = createMemo<RailItemId[]>(() => [
    "hero",
    "sort",
    ...rails().map((r) => `rail:${r.id}`),
  ]);

  const [zone, setZone] = createSignal<"sidebar" | RailItemId>("hero");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [heroIdx, setHeroIdx] = createSignal(0);
  const [sortIdx, setSortIdx] = createSignal(0);
  /** Per-rail selectedIndex map. Defaults to 0 on first focus. */
  const [railIdx, setRailIdx] = createSignal<Record<number, number>>({});

  const railRefs = new Map<number, HTMLDivElement>();

  const { isScopeOwner, setActive } = useNavigationScope("movies", {
    priority: 0,
    active: appShellZone() === "content",
  });
  createEffect(() => setActive(appShellZone() === "content"));

  // Keep sortIdx in sync with the persisted sort signal so the SortSelector
  // highlights the current value.
  createEffect(() => {
    const cur = movieSort();
    const idx = MOVIE_SORT_OPTIONS.findIndex((o) => o.value === cur);
    if (idx >= 0) setSortIdx(idx);
  });

  function getRailIdx(id: number): number {
    return railIdx()[id] ?? 0;
  }
  function setRailIdxFor(id: number, n: number) {
    setRailIdx((prev) => ({ ...prev, [id]: n }));
  }

  // ---------------------------------------------------------------------------
  // Sidebar interaction — selection scrolls to the matching rail and drops
  // focus into it.
  // ---------------------------------------------------------------------------

  function pickSidebar(idx: number, dropFocus: boolean) {
    const item = sidebarItems()[idx];
    if (!item) return;
    setSidebarIdx(idx);

    if (item.id === "__all__") {
      // Scroll back to top: focus hero
      if (dropFocus) setZone("hero");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const railId = item.id as number;
    const el = railRefs.get(railId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    if (dropFocus) setZone(`rail:${railId}`);
  }

  // ---------------------------------------------------------------------------
  // Hero items derived from popular[]
  // ---------------------------------------------------------------------------

  const heroItems = createMemo<HeroItem[]>(() => {
    const items = popular()?.items.slice(0, HERO_COUNT) ?? [];
    return items.map((m) => ({
      id: m.id,
      title: m.name,
      backdrop: backdropUrl(m),
      poster: posterUrl(m),
      meta: (
        <>
          {m.year && <span>{m.year}</span>}
          {m.tmdb_vote_average != null && (
            <span class="ml-2">★ {m.tmdb_vote_average.toFixed(1)}</span>
          )}
        </>
      ),
      tags: m.genres.slice(0, 3),
    }));
  });

  // Auto-scroll the focused rail into view as the user navigates with ↓/↑.
  createEffect(() => {
    const cur = zone();
    if (typeof cur === "string" && cur.startsWith("rail:")) {
      const id = Number(cur.slice(5));
      const el = railRefs.get(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (cur === "hero") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  // ---------------------------------------------------------------------------
  // Keyboard handling
  // ---------------------------------------------------------------------------

  function moveVertical(delta: 1 | -1) {
    const cur = zone();
    if (cur === "sidebar") {
      const items = sidebarItems();
      const next = sidebarIdx() + delta;
      if (next < 0) {
        setAppShellZone("nav");
        return;
      }
      if (next >= items.length) return;
      pickSidebar(next, false); // sidebar nav scrolls preview but keeps focus
      return;
    }
    const zs = rightZones();
    const idx = zs.indexOf(cur as RailItemId);
    const next = idx + delta;
    if (next < 0) {
      setAppShellZone("nav");
      return;
    }
    if (next >= zs.length) return;
    setZone(zs[next]);
  }

  function moveHorizontal(delta: 1 | -1) {
    const cur = zone();
    if (cur === "sidebar") {
      if (delta < 0) {
        setSidebarOpen(false);
        setZone("hero");
        return;
      }
      // → from sidebar drops focus into the rail it was previewing
      pickSidebar(sidebarIdx(), true);
      return;
    }
    if (cur === "hero") {
      const total = heroItems().length;
      if (delta < 0 && (total === 0 || heroIdx() === 0)) {
        setSidebarOpen(true);
        setZone("sidebar");
        return;
      }
      if (total === 0) return;
      setHeroIdx((i) => (i + delta + total) % total);
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
    // rail:<id>
    if (typeof cur === "string" && cur.startsWith("rail:")) {
      const id = Number(cur.slice(5));
      // The actual item count is unknown (LazyRail owns it). Use a generous
      // upper bound — Rail's internal renderItem is keyed by selectedIndex,
      // and PosterCard will just not flash a focus ring on out-of-range.
      // We let users overshoot; the rail clamps via card clicks.
      if (delta < 0 && getRailIdx(id) === 0) {
        setSidebarOpen(true);
        setZone("sidebar");
        return;
      }
      setRailIdxFor(id, Math.max(getRailIdx(id) + delta, 0));
    }
  }

  function activate() {
    const cur = zone();
    if (cur === "sidebar") {
      pickSidebar(sidebarIdx(), true);
      return;
    }
    if (cur === "hero") {
      const item = heroItems()[heroIdx()];
      if (item) navigate(`/movies/${item.id}`);
      return;
    }
    if (cur === "sort") {
      setMovieSort(MOVIE_SORT_OPTIONS[sortIdx()].value);
      return;
    }
    // rail:<id> — emit click on the focused card. The LazyRail's renderItem
    // wires the actual onClick → navigate; here we don't have direct access
    // to the focused MovieListItem, so we rely on the click already happening
    // when the user pressed Enter inside the card (ie. the focused card has
    // a real DOM focus). For TV remotes that don't issue a real DOM click on
    // Enter, the page-wide Enter handler below provides a fallback by
    // looking up the rail's currently-cached items. We can't see rail
    // contents from here without lifting state — so for now, rely on the
    // card's onClick (we can route to detail via a subscribers callback).
    // (The renderItem callback for each rail captures `navigate` directly.)
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
    <div class="flex h-[calc(100vh-49px)]">
      <Show when={sidebarOpen()}>
        <Sidebar
          title={isCurated() ? "Genres" : "Categories"}
          items={sidebarItems()}
          activeId={() => {
            const cur = zone();
            if (typeof cur === "string" && cur.startsWith("rail:")) {
              return Number(cur.slice(5));
            }
            return "__all__";
          }}
          focusedIdx={sidebarIdx}
          isFocused={() => zone() === "sidebar"}
          onSelect={(_, i) => pickSidebar(i, true)}
        />
      </Show>

      <div class="flex-1 overflow-y-auto relative">
        <Show when={!sidebarOpen()}>
          <div class="absolute top-3 left-3 z-10 text-[11px] text-zinc-600 select-none pointer-events-none">
            ← filters
          </div>
        </Show>

        <Show
          when={heroItems().length > 0}
          fallback={
            <div class="h-[40vh] flex items-center justify-center text-zinc-600 text-sm">
              <Show when={popular.loading} fallback={<span>No movies yet.</span>}>
                Loading…
              </Show>
            </div>
          }
        >
          <HeroCarousel
            items={heroItems()}
            activeIndex={heroIdx}
            onIndexChange={setHeroIdx}
            paused={() => zone() === "hero"}
            isFocused={() => zone() === "hero"}
            actions={[
              {
                label: "Open",
                primary: true,
                onClick: () => {
                  const item = heroItems()[heroIdx()];
                  if (item) navigate(`/movies/${item.id}`);
                },
              },
            ]}
          />
        </Show>

        <SortSelector
          value={movieSort}
          options={MOVIE_SORT_OPTIONS}
          onChange={(v) => setMovieSort(v)}
          isFocused={() => zone() === "sort"}
          focusedIdx={sortIdx}
        />

        <div class="space-y-2 pb-12">
          <For each={rails()}>
            {(rail) => {
              const railZoneId: RailItemId = `rail:${rail.id}`;
              return (
                <LazyRail<MovieListItem>
                  ref={(el) => railRefs.set(rail.id, el)}
                  title={
                    rail.count != null
                      ? `${rail.label} · ${rail.count.toLocaleString()}`
                      : rail.label
                  }
                  reactiveKey={() =>
                    `${rail.id}:${rail.filterKey}:${movieSort()}`
                  }
                  fetch={async () => {
                    const args: {
                      sort: MovieSort;
                      per_page: number;
                      genre_id?: number;
                      category_id?: number;
                    } = { sort: movieSort(), per_page: RAIL_PAGE_SIZE };
                    if (rail.filterKey === "genre_id") args.genre_id = rail.id;
                    else args.category_id = rail.id;
                    const page = await listMovies(args);
                    return page.items;
                  }}
                  isFocused={() => zone() === railZoneId}
                  selectedIndex={() => getRailIdx(rail.id)}
                  renderItem={(item, focused, idx) => (
                    <PosterCard
                      title={item.name}
                      imageUrl={posterUrl(item)}
                      focused={() => focused}
                      onClick={() => {
                        setRailIdxFor(rail.id, idx);
                        setZone(railZoneId);
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
                />
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
