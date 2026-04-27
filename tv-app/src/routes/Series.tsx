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
  listSerieCategories,
  listSeries,
  listSeriesGenres,
} from "../api/catalog";
import type {
  FlatCategory,
  GenreCountOut,
  SeriesListItem,
  SeriesSort,
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
  SERIES_SORT_OPTIONS,
  seriesSort,
  setSeriesSort,
} from "../lib/sortPrefs";
import { authUser } from "../stores/auth";
import { appShellZone, setAppShellZone } from "../stores/shell";

const HERO_COUNT = 5;
const RAIL_PAGE_SIZE = 30;

type RailItemId = string;

function posterUrl(s: SeriesListItem): string | null {
  return s.cover || null;
}
function backdropUrl(s: SeriesListItem): string | null {
  return s.backdrop_path || s.cover || null;
}

export default function SeriesPage() {
  const navigate = useNavigate();
  const isCurated = () => authUser()?.view_mode === "curated";

  const [genres] = createResource(
    () => isCurated(),
    (curated) => (curated ? listSeriesGenres() : Promise.resolve([])),
  );
  const [categories] = createResource(
    () => !isCurated(),
    (fallback) => (fallback ? listSerieCategories() : Promise.resolve([])),
  );
  const [popular] = createResource(() =>
    listSeries({ sort: "popularity_desc", per_page: HERO_COUNT }),
  );

  interface RailDescriptor {
    id: number;
    label: string;
    count?: number;
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
    { id: "__all__", label: "All series" },
    ...rails().map((r) => ({ id: r.id, label: r.label, count: r.count })),
  ]);

  const rightZones = createMemo<RailItemId[]>(() => [
    "hero",
    "sort",
    ...rails().map((r) => `rail:${r.id}`),
  ]);

  const [zone, setZone] = createSignal<"sidebar" | RailItemId>("hero");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [heroIdx, setHeroIdx] = createSignal(0);
  const [sortIdx, setSortIdx] = createSignal(0);
  const [railIdx, setRailIdx] = createSignal<Record<number, number>>({});

  const railRefs = new Map<number, HTMLDivElement>();

  const { isScopeOwner, setActive } = useNavigationScope("series", {
    priority: 0,
    active: appShellZone() === "content",
  });
  createEffect(() => setActive(appShellZone() === "content"));

  createEffect(() => {
    const cur = seriesSort();
    const idx = SERIES_SORT_OPTIONS.findIndex((o) => o.value === cur);
    if (idx >= 0) setSortIdx(idx);
  });

  function getRailIdx(id: number): number {
    return railIdx()[id] ?? 0;
  }
  function setRailIdxFor(id: number, n: number) {
    setRailIdx((prev) => ({ ...prev, [id]: n }));
  }

  function pickSidebar(idx: number, dropFocus: boolean) {
    const item = sidebarItems()[idx];
    if (!item) return;
    setSidebarIdx(idx);

    if (item.id === "__all__") {
      if (dropFocus) setZone("hero");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const railId = item.id as number;
    const el = railRefs.get(railId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    if (dropFocus) setZone(`rail:${railId}`);
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
      pickSidebar(next, false);
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
      const max = SERIES_SORT_OPTIONS.length - 1;
      if (delta < 0 && sortIdx() === 0) {
        setSidebarOpen(true);
        setZone("sidebar");
        return;
      }
      setSortIdx((i) => Math.min(Math.max(i + delta, 0), max));
      return;
    }
    if (typeof cur === "string" && cur.startsWith("rail:")) {
      const id = Number(cur.slice(5));
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
      if (item) navigate(`/series/${item.id}`);
      return;
    }
    if (cur === "sort") {
      setSeriesSort(SERIES_SORT_OPTIONS[sortIdx()].value);
      return;
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
              <Show when={popular.loading} fallback={<span>No series yet.</span>}>
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
                  if (item) navigate(`/series/${item.id}`);
                },
              },
            ]}
          />
        </Show>

        <SortSelector
          value={seriesSort}
          options={SERIES_SORT_OPTIONS}
          onChange={(v) => setSeriesSort(v)}
          isFocused={() => zone() === "sort"}
          focusedIdx={sortIdx}
        />

        <div class="space-y-2 pb-12">
          <For each={rails()}>
            {(rail) => {
              const railZoneId: RailItemId = `rail:${rail.id}`;
              return (
                <LazyRail<SeriesListItem>
                  ref={(el) => railRefs.set(rail.id, el)}
                  title={
                    rail.count != null
                      ? `${rail.label} · ${rail.count.toLocaleString()}`
                      : rail.label
                  }
                  reactiveKey={() =>
                    `${rail.id}:${rail.filterKey}:${seriesSort()}`
                  }
                  fetch={async () => {
                    const args: {
                      sort: SeriesSort;
                      per_page: number;
                      genre_id?: number;
                      category_id?: number;
                    } = { sort: seriesSort(), per_page: RAIL_PAGE_SIZE };
                    if (rail.filterKey === "genre_id") args.genre_id = rail.id;
                    else args.category_id = rail.id;
                    const page = await listSeries(args);
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
                        navigate(`/series/${item.id}`);
                      }}
                      meta={
                        <Show when={item.tmdb_vote_average != null}>
                          <span>★ {item.tmdb_vote_average!.toFixed(1)}</span>
                        </Show>
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
