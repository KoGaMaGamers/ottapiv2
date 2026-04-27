import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { listMovieCategories, listMovies } from "../api/catalog";
import type { FlatCategory, MovieListItem, MovieSort } from "../api/types";
import HeroCarousel, { type HeroItem } from "../components/HeroCarousel";
import PosterCard from "../components/PosterCard";
import Rail from "../components/Rail";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";
import { appShellZone, setAppShellZone } from "../stores/shell";

/**
 * Movies listing.
 *
 *   ┌──── Sidebar ────┬──── Hero (top popular in category) ────┐
 *   │ All             │                                        │
 *   │ EN — LATEST     ├──── Rail: Most Popular ────────────────┤
 *   │ FR — LATEST     │                                        │
 *   │ EN — NETFLIX    │  Rail: Newest                          │
 *   │ ...             │                                        │
 *   │                 │  Rail: Top Rated                       │
 *   └─────────────────┴────────────────────────────────────────┘
 *
 * One scope, four zones (sidebar / hero / rail-popular / rail-newest /
 * rail-rated). Moving up from the sidebar's first item OR the hero's
 * top edge bumps focus into the TopNav.
 *
 * Selected category persists in the URL (?category=ID) so reload and
 * back-nav remember it.
 */

const RAIL_PAGE_SIZE = 30;
const HERO_COUNT = 5;

type Zone = "sidebar" | "hero" | "rail-popular" | "rail-newest" | "rail-rated";
const ZONES_RIGHT: Zone[] = ["hero", "rail-popular", "rail-newest", "rail-rated"];

function posterUrl(m: MovieListItem): string | null {
  return m.cover_big || m.stream_icon || null;
}

function backdropUrl(m: MovieListItem): string | null {
  return m.backdrop_path || m.cover_big || null;
}

export default function MoviesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [categories] = createResource<FlatCategory[]>(() =>
    listMovieCategories(),
  );

  const selectedCategoryId = createMemo<number | undefined>(() => {
    const raw = params.category;
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  });

  // Three rail-source resources, all keyed on the selected category id.
  const [popular] = createResource(
    () => ({ category_id: selectedCategoryId(), sort: "popularity_desc" as MovieSort }),
    (k) => listMovies({ ...k, per_page: RAIL_PAGE_SIZE }),
  );
  const [newest] = createResource(
    () => ({ category_id: selectedCategoryId(), sort: "added_desc" as MovieSort }),
    (k) => listMovies({ ...k, per_page: RAIL_PAGE_SIZE }),
  );
  const [topRated] = createResource(
    () => ({ category_id: selectedCategoryId(), sort: "rating_desc" as MovieSort }),
    (k) => listMovies({ ...k, per_page: RAIL_PAGE_SIZE }),
  );

  // -------------------------------------------------------------------------
  // Navigation state
  // -------------------------------------------------------------------------

  const [zone, setZone] = createSignal<Zone>("sidebar");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [heroIdx, setHeroIdx] = createSignal(0);
  const [popIdx, setPopIdx] = createSignal(0);
  const [newIdx, setNewIdx] = createSignal(0);
  const [ratIdx, setRatIdx] = createSignal(0);

  const { isScopeOwner, setActive } = useNavigationScope("movies", {
    priority: 0,
    active: appShellZone() === "content",
  });
  createEffect(() => setActive(appShellZone() === "content"));

  const sidebarItems = createMemo<SidebarItem[]>(() => {
    const cats = categories() ?? [];
    return [
      { id: "__all__", label: "All movies" },
      ...cats.map((c) => ({
        id: c.category_id,
        label: c.name,
      })),
    ];
  });

  // Sync sidebar selection ↔ URL (?category=ID)
  createEffect(() => {
    const items = sidebarItems();
    const id = selectedCategoryId();
    const idx =
      id === undefined
        ? 0
        : items.findIndex((it) => it.id === id);
    if (idx >= 0) setSidebarIdx(idx);
  });

  function pickSidebar(idx: number) {
    const item = sidebarItems()[idx];
    if (!item) return;
    setSidebarIdx(idx);
    if (item.id === "__all__") {
      setParams({ category: undefined });
    } else {
      setParams({ category: String(item.id) });
    }
    // Reset rail positions on category switch
    setHeroIdx(0);
    setPopIdx(0);
    setNewIdx(0);
    setRatIdx(0);
  }

  // -------------------------------------------------------------------------
  // Derived hero from popular[]
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Keyboard handling
  // -------------------------------------------------------------------------

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
      pickSidebar(next);
      return;
    }
    // Right column: cycle through right zones
    const idx = ZONES_RIGHT.indexOf(cur);
    const next = idx + delta;
    if (next < 0) {
      setAppShellZone("nav");
      return;
    }
    if (next >= ZONES_RIGHT.length) return;
    setZone(ZONES_RIGHT[next]);
  }

  function moveHorizontal(delta: 1 | -1) {
    const cur = zone();
    if (cur === "sidebar") {
      // Right arrow: jump into right column at hero
      if (delta > 0) setZone("hero");
      return;
    }
    // hero / rails — left arrow at index 0 jumps back to sidebar
    if (cur === "hero") {
      const total = heroItems().length;
      if (total === 0) {
        if (delta < 0) setZone("sidebar");
        return;
      }
      if (delta < 0 && heroIdx() === 0) {
        setZone("sidebar");
        return;
      }
      setHeroIdx((i) => (i + delta + total) % total); // hero wraps
    } else {
      const [getter, setter, items] = (() => {
        switch (cur) {
          case "rail-popular":
            return [popIdx, setPopIdx, popular()?.items ?? []] as const;
          case "rail-newest":
            return [newIdx, setNewIdx, newest()?.items ?? []] as const;
          case "rail-rated":
            return [ratIdx, setRatIdx, topRated()?.items ?? []] as const;
          default:
            return [() => 0, () => {}, [] as MovieListItem[]] as const;
        }
      })();
      if (items.length === 0) {
        if (delta < 0) setZone("sidebar");
        return;
      }
      if (delta < 0 && getter() === 0) {
        setZone("sidebar");
        return;
      }
      (setter as (n: number) => void)(
        Math.min(Math.max(getter() + delta, 0), items.length - 1),
      );
    }
  }

  function activate() {
    const cur = zone();
    if (cur === "sidebar") return; // sidebar selection happens on focus change
    if (cur === "hero") {
      const item = heroItems()[heroIdx()];
      if (item) navigate(`/movies/${item.id}`);
      return;
    }
    const item = (() => {
      switch (cur) {
        case "rail-popular":
          return popular()?.items[popIdx()];
        case "rail-newest":
          return newest()?.items[newIdx()];
        case "rail-rated":
          return topRated()?.items[ratIdx()];
      }
      return undefined;
    })();
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

  return (
    <div class="flex h-[calc(100vh-49px)]">
      <Sidebar
        title="Categories"
        items={sidebarItems()}
        activeId={() =>
          selectedCategoryId() === undefined
            ? "__all__"
            : selectedCategoryId()!
        }
        focusedIdx={sidebarIdx}
        isFocused={() => zone() === "sidebar"}
        onSelect={(_, i) => pickSidebar(i)}
      />

      <div class="flex-1 overflow-y-auto">
        <Show
          when={heroItems().length > 0}
          fallback={
            <div class="h-[40vh] flex items-center justify-center text-zinc-600 text-sm">
              <Show when={popular.loading} fallback={<span>No movies in this category.</span>}>
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
              { label: "Open", primary: true, onClick: activate },
            ]}
          />
        </Show>

        <div class="mt-6">
          <Rail
            title="Most Popular"
            items={popular()?.items ?? []}
            selectedIndex={popIdx}
            isFocused={() => zone() === "rail-popular"}
            renderItem={(item, focused) => (
              <PosterCard
                title={item.name}
                imageUrl={posterUrl(item)}
                focused={() => focused}
                onClick={() => navigate(`/movies/${item.id}`)}
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
          <Rail
            title="Newest"
            items={newest()?.items ?? []}
            selectedIndex={newIdx}
            isFocused={() => zone() === "rail-newest"}
            renderItem={(item, focused) => (
              <PosterCard
                title={item.name}
                imageUrl={posterUrl(item)}
                focused={() => focused}
                onClick={() => navigate(`/movies/${item.id}`)}
              />
            )}
          />
          <Rail
            title="Top Rated"
            items={topRated()?.items ?? []}
            selectedIndex={ratIdx}
            isFocused={() => zone() === "rail-rated"}
            renderItem={(item, focused) => (
              <PosterCard
                title={item.name}
                imageUrl={posterUrl(item)}
                focused={() => focused}
                onClick={() => navigate(`/movies/${item.id}`)}
              />
            )}
          />
        </div>
      </div>
    </div>
  );
}
