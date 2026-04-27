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
import {
  listGenres,
  listSerieCategories,
  listSeries,
} from "../api/catalog";
import type { SeriesListItem, SeriesSort } from "../api/types";
import HeroCarousel, { type HeroItem } from "../components/HeroCarousel";
import PosterCard from "../components/PosterCard";
import Rail from "../components/Rail";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";
import { sidebarOpen, setSidebarOpen } from "../lib/sidebarPrefs";
import { authUser } from "../stores/auth";
import { appShellZone, setAppShellZone } from "../stores/shell";

/**
 * Series listing — same shape as MoviesPage. Curated providers see
 * TMDB genres in the sidebar; fallback providers see series categories.
 * Sidebar is collapsible and the open/closed state is shared with
 * Movies via lib/sidebarPrefs.
 */

const RAIL_PAGE_SIZE = 30;
const HERO_COUNT = 5;

type Zone = "sidebar" | "hero" | "rail-popular" | "rail-newest" | "rail-rated";
const ZONES_RIGHT: Zone[] = ["hero", "rail-popular", "rail-newest", "rail-rated"];

function posterUrl(s: SeriesListItem): string | null {
  return s.cover || null;
}
function backdropUrl(s: SeriesListItem): string | null {
  return s.backdrop_path || s.cover || null;
}

export default function SeriesPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const isCurated = () => authUser()?.view_mode === "curated";

  const [genres] = createResource(
    () => isCurated(),
    (curated) => (curated ? listGenres() : Promise.resolve([])),
  );
  const [categories] = createResource(
    () => !isCurated(),
    (fallback) => (fallback ? listSerieCategories() : Promise.resolve([])),
  );

  const filterId = createMemo<number | undefined>(() => {
    const raw = params.filter;
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  });

  function makeFilterArgs(sort: SeriesSort) {
    const id = filterId();
    if (id === undefined) return { sort };
    return isCurated() ? { sort, genre_id: id } : { sort, category_id: id };
  }

  const [popular] = createResource(
    () => makeFilterArgs("popularity_desc"),
    (k) => listSeries({ ...k, per_page: RAIL_PAGE_SIZE }),
  );
  const [newest] = createResource(
    () => makeFilterArgs("last_modified_desc"),
    (k) => listSeries({ ...k, per_page: RAIL_PAGE_SIZE }),
  );
  const [topRated] = createResource(
    () => makeFilterArgs("rating_desc"),
    (k) => listSeries({ ...k, per_page: RAIL_PAGE_SIZE }),
  );

  const [zone, setZone] = createSignal<Zone>("hero");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [heroIdx, setHeroIdx] = createSignal(0);
  const [popIdx, setPopIdx] = createSignal(0);
  const [newIdx, setNewIdx] = createSignal(0);
  const [ratIdx, setRatIdx] = createSignal(0);

  const { isScopeOwner, setActive } = useNavigationScope("series", {
    priority: 0,
    active: appShellZone() === "content",
  });
  createEffect(() => setActive(appShellZone() === "content"));

  const sidebarItems = createMemo<SidebarItem[]>(() => {
    if (isCurated()) {
      const gs = genres() ?? [];
      return [
        { id: "__all__", label: "All series" },
        ...gs.map((g) => ({ id: g.id, label: g.name })),
      ];
    }
    const cats = categories() ?? [];
    return [
      { id: "__all__", label: "All series" },
      ...cats.map((c) => ({ id: c.category_id, label: c.name })),
    ];
  });

  createEffect(() => {
    const items = sidebarItems();
    const id = filterId();
    const idx = id === undefined ? 0 : items.findIndex((it) => it.id === id);
    if (idx >= 0) setSidebarIdx(idx);
  });

  function pickSidebar(idx: number) {
    const item = sidebarItems()[idx];
    if (!item) return;
    setSidebarIdx(idx);
    if (item.id === "__all__") setParams({ filter: undefined });
    else setParams({ filter: String(item.id) });
    setHeroIdx(0);
    setPopIdx(0);
    setNewIdx(0);
    setRatIdx(0);
  }

  const heroItems = createMemo<HeroItem[]>(() => {
    const items = popular()?.items.slice(0, HERO_COUNT) ?? [];
    return items.map((s) => ({
      id: s.id,
      title: s.name,
      backdrop: backdropUrl(s),
      poster: posterUrl(s),
      meta: (
        <Show when={s.tmdb_vote_average != null}>
          <span>★ {s.tmdb_vote_average!.toFixed(1)}</span>
        </Show>
      ),
      tags: s.genres.slice(0, 3),
    }));
  });

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
      if (delta < 0) {
        setSidebarOpen(false);
        setZone("hero");
        return;
      }
      setZone("hero");
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
    const [getter, setter, items] = (() => {
      switch (cur) {
        case "rail-popular":
          return [popIdx, setPopIdx, popular()?.items ?? []] as const;
        case "rail-newest":
          return [newIdx, setNewIdx, newest()?.items ?? []] as const;
        case "rail-rated":
          return [ratIdx, setRatIdx, topRated()?.items ?? []] as const;
        default:
          return [() => 0, () => {}, [] as SeriesListItem[]] as const;
      }
    })();
    if (delta < 0 && (items.length === 0 || getter() === 0)) {
      setSidebarOpen(true);
      setZone("sidebar");
      return;
    }
    (setter as (n: number) => void)(
      Math.min(Math.max(getter() + delta, 0), items.length - 1),
    );
  }

  function activate() {
    const cur = zone();
    if (cur === "sidebar") return;
    if (cur === "hero") {
      const item = heroItems()[heroIdx()];
      if (item) navigate(`/series/${item.id}`);
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
    if (item) navigate(`/series/${item.id}`);
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
          activeId={() => (filterId() === undefined ? "__all__" : filterId()!)}
          focusedIdx={sidebarIdx}
          isFocused={() => zone() === "sidebar"}
          onSelect={(_, i) => pickSidebar(i)}
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
              <Show when={popular.loading} fallback={<span>No series in this category.</span>}>
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
            actions={[{ label: "Open", primary: true, onClick: activate }]}
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
                onClick={() => navigate(`/series/${item.id}`)}
                meta={
                  <Show when={item.tmdb_vote_average != null}>
                    <span>★ {item.tmdb_vote_average!.toFixed(1)}</span>
                  </Show>
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
                onClick={() => navigate(`/series/${item.id}`)}
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
                onClick={() => navigate(`/series/${item.id}`)}
              />
            )}
          />
        </div>
      </div>
    </div>
  );
}
