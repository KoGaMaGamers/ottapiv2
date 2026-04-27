/**
 * Series — vertical genre lazy-load grid + collapsible sidebar.
 *
 * Faithful Solid port of `tv_app_v2/src/pages/SeriesPage.jsx` (top half,
 * LOC 1-770). Mirrors `routes/Movies.tsx` since they share the
 * sp-browser shell. The key divergence: clicking a series card or
 * pressing Enter in the grid navigates to `/series/:id` rather than
 * opening a modal — the user prefers Series detail as a dedicated page.
 *
 * API mapping vs the legacy:
 *   - `fetchStreamGenres({type:'series'})` → `listSeriesGenres()`
 *   - `fetchSeries({genre, limit, offset})`
 *                                          → `listSeries({genre_id, sort, page, per_page})`
 *   - prefs.series → comma-separated `category_id` (multi-value supported
 *     by the recent backend extension)
 *
 * Deferred (separate iterations):
 *   - Hero preview clip — same auth-model gap as MoviesPage.
 *   - Watchlist + playback progress — no stores ported yet.
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
  Index,
  type JSX,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { listSeriesGenres, listSeries } from "../api/catalog";
import type {
  GenreCountOut,
  SeriesListItem,
  SeriesSort,
} from "../api/types";
import { useNavigationScope } from "../lib/navigation";
import { setAppShellZone } from "../stores/shell";
import { getContentPrefs } from "../lib/contentPrefs";
import { getGradient, getAccent } from "../lib/gradient";
import HeroCarousel, {
  type HeroBadge,
  type HeroItem,
} from "../components/HeroCarousel";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import SeriesMediaCard from "../components/SeriesMediaCard";
import SkeletonCard from "../components/SkeletonCard";
import { type CardItem } from "../components/cardItem";
import {
  seriesSort,
  setSeriesSort,
  SERIES_SORT_OPTIONS,
} from "../lib/sortPrefs";
import SortSelector from "../components/SortSelector";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LATEST_ID = "__latest__";
const OTHERS_ID = "__others__";
const SERIES_PAGE_SIZE = 60;

interface SidebarSeriesGenre {
  id: string | number;
  name: string;
  series_count: number | null;
}

const LATEST_ENTRY: SidebarSeriesGenre = {
  id: LATEST_ID,
  name: "🕐 Latest",
  series_count: null,
};
const OTHERS_ENTRY: SidebarSeriesGenre = {
  id: OTHERS_ID,
  name: "Others",
  series_count: null,
};

type Zone = "hero" | "sort" | "sidebar" | "grid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seriesAddedTs(s: SeriesListItem): number {
  // SeriesListItem doesn't carry `added`; use last_modified as a proxy.
  const raw = s.last_modified;
  if (!raw) return 0;
  const d = Date.parse(String(raw).replace(" ", "T"));
  return Number.isNaN(d) ? 0 : d;
}

function seriesToCard(s: SeriesListItem): CardItem {
  const yearStr = s.release_date
    ? Number(String(s.release_date).slice(0, 4))
    : null;
  return {
    id: s.id,
    title: s.name,
    name: s.name,
    poster: s.cover,
    backdrop: s.backdrop_path,
    year: yearStr ?? null,
    rating: s.rating_5based,
    language: s.language,
    genres: s.genres,
    type: "series",
  };
}

function seriesToHero(
  s: SeriesListItem,
  onPlay: () => void,
  onMore: () => void,
): HeroItem {
  const badges: HeroBadge[] = [{ label: "📺 Series", variant: "series" }];
  const yearStr = s.release_date ? String(s.release_date).slice(0, 4) : null;
  if (yearStr) badges.push({ label: yearStr, variant: "year" });
  if (s.rating_5based != null) {
    badges.push({
      label: `⭐ ${s.rating_5based.toFixed(1)}`,
      variant: "rating",
    });
  }
  if (s.language) {
    badges.push({ label: s.language.toUpperCase(), variant: "lang" });
  }
  return {
    id: s.id,
    title: s.name,
    poster: s.cover,
    backdrop: s.backdrop_path,
    gradient: getGradient(s.name),
    accent: getAccent(s.name),
    badges,
    genres: s.genres,
    plot: null,
    primaryAction: { label: "▶ Watch Now", onClick: onPlay },
    secondaryAction: { label: "📋 Details", onClick: onMore },
  };
}

function resolveCategoryIdsParam(): string | null | "" {
  const pref = getContentPrefs().series;
  if (pref === null) return null;
  if (!Array.isArray(pref) || pref.length === 0) return "";
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of pref) {
    const t = String(raw ?? "").trim();
    if (!/^\d+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    cleaned.push(t);
  }
  return cleaned.length ? cleaned.join(",") : "";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Series(): JSX.Element {
  const navigate = useNavigate();
  const { isScopeOwner } = useNavigationScope("page:series", {
    active: true,
    priority: 30,
  });

  const [genres] = createResource<GenreCountOut[]>(() =>
    listSeriesGenres().catch(() => [] as GenreCountOut[]),
  );

  const sidebarGenres = createMemo<SidebarSeriesGenre[]>(() =>
    (genres() ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      series_count: g.count ?? null,
    })),
  );

  const sidebarItems = createMemo<SidebarSeriesGenre[]>(() => [
    LATEST_ENTRY,
    ...sidebarGenres(),
    OTHERS_ENTRY,
  ]);

  const sidebarUiItems = createMemo<SidebarItem[]>(() =>
    sidebarItems().map((g) => ({
      id: g.id,
      label: g.name,
      count: g.series_count,
    })),
  );

  // Focus / zone state
  const [zone, setZone] = createSignal<Zone>("hero");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [gridIdx, setGridIdx] = createSignal(0);
  const [sortIdx, setSortIdx] = createSignal(0);
  const [selectedGenre, setSelectedGenre] = createSignal<SidebarSeriesGenre>(
    LATEST_ENTRY,
  );

  // Grid data state
  const [genreSeries, setGenreSeries] = createSignal<SeriesListItem[]>([]);
  const [genreLoading, setGenreLoading] = createSignal(false);
  const [genreLoadingMore, setGenreLoadingMore] = createSignal(false);
  const [genreHasMore, setGenreHasMore] = createSignal(true);
  const [genrePage, setGenrePage] = createSignal(1);
  const [genreError, setGenreError] = createSignal<string | null>(null);

  const [featuredSeries, setFeaturedSeries] = createSignal<SeriesListItem[]>(
    [],
  );
  let featuredSet = false;

  let gridRef: HTMLDivElement | undefined;
  let gridLoadMoreRef: HTMLDivElement | undefined;
  let loadDebounce: number | null = null;

  const loadForGenre = async (
    genre: SidebarSeriesGenre,
    opts: { append?: boolean; page?: number } = {},
  ) => {
    if (!genre) return;
    setGenreError(null);
    const isAppend = opts.append === true;
    const targetPage = opts.page ?? 1;

    if (isAppend) {
      setGenreLoadingMore(true);
    } else {
      setGenreLoading(true);
      setGenreSeries([]);
      setGridIdx(0);
      setGenrePage(1);
      setGenreHasMore(true);
    }

    try {
      const cat = resolveCategoryIdsParam();
      if (cat === "") {
        setGenreSeries([]);
        setGenreHasMore(false);
        return;
      }

      const isLatest = genre.id === LATEST_ID;
      const isOthers = genre.id === OTHERS_ID;
      const genreId =
        isLatest || isOthers ? undefined : (Number(genre.id) || undefined);

      const sortValue: SeriesSort = isLatest
        ? seriesSort()
        : "last_modified_desc";

      const resp = await listSeries({
        category_id: cat ?? undefined,
        genre_id: genreId,
        sort: sortValue,
        page: targetPage,
        per_page: SERIES_PAGE_SIZE,
      });

      let data = resp.items;
      if (isOthers) {
        data = data.filter(
          (s) => !Array.isArray(s.genres) || s.genres.length === 0,
        );
      }
      data = [...data].sort((a, b) => seriesAddedTs(b) - seriesAddedTs(a));

      if (isAppend) {
        setGenreSeries((prev) => {
          const seen = new Set(prev.map((x) => String(x.id)));
          const next = [...prev];
          for (const item of data) {
            if (seen.has(String(item.id))) continue;
            seen.add(String(item.id));
            next.push(item);
          }
          next.sort((a, b) => seriesAddedTs(b) - seriesAddedTs(a));
          return next;
        });
      } else {
        setGenreSeries(data);
      }

      if (isOthers) {
        setGenreHasMore(false);
      } else {
        setGenrePage(targetPage);
        setGenreHasMore(resp.has_next);
      }

      if (!isAppend && !featuredSet) {
        const withArt = data.filter((s) => s.cover);
        if (withArt.length > 0) {
          featuredSet = true;
          setFeaturedSeries(withArt.slice(0, 8));
        }
      }
    } catch (e) {
      setGenreError(
        e instanceof Error ? e.message : "Failed to load series",
      );
      if (isAppend) setGenreHasMore(false);
    } finally {
      if (isAppend) setGenreLoadingMore(false);
      else setGenreLoading(false);
    }
  };

  // Initial load
  createEffect(() => {
    loadForGenre(LATEST_ENTRY);
  });

  // Re-fetch Latest when sort changes
  createEffect(
    on(seriesSort, (s) => {
      if (selectedGenre().id === LATEST_ID) {
        void s;
        loadForGenre(LATEST_ENTRY);
      }
    }, { defer: true }),
  );

  const navigateSidebar = (newIdx: number) => {
    const items = sidebarItems();
    if (newIdx < 0) {
      setZone("hero");
      return;
    }
    if (newIdx >= items.length) return;
    setSidebarIdx(newIdx);
    if (loadDebounce != null) clearTimeout(loadDebounce);
    loadDebounce = window.setTimeout(() => {
      const g = items[newIdx];
      setSelectedGenre(g);
      loadForGenre(g);
    }, 200);
  };

  // Infinite scroll
  createEffect(() => {
    const root = gridRef;
    const target = gridLoadMoreRef;
    if (!root || !target) return;
    if (zone() !== "grid" || !genreHasMore()) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          if (genreLoading() || genreLoadingMore() || !genreHasMore()) return;
          loadForGenre(selectedGenre(), {
            append: true,
            page: genrePage() + 1,
          });
        }
      },
      {
        root,
        rootMargin: "0px 0px 320px 0px",
        threshold: 0,
      },
    );
    observer.observe(target);
    onCleanup(() => observer.disconnect());
  });

  // Auto-scroll the focused card into view
  createEffect(() => {
    if (zone() !== "grid") return;
    const i = gridIdx();
    queueMicrotask(() => {
      const child = gridRef?.children[i] as HTMLElement | undefined;
      child?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
    });
  });

  // Geometry-based grid neighbors
  const moveByGeometry = (
    direction: "up" | "down" | "left" | "right",
  ): number | null => {
    const grid = gridRef;
    if (!grid) return null;
    const cards = Array.from(grid.children).filter(
      (el) => !(el as HTMLElement).classList.contains("sp-grid-load-sentinel"),
    ) as HTMLElement[];
    if (!cards.length) return null;
    const current = cards[gridIdx()];
    if (!current) return null;
    const currentRect = current.getBoundingClientRect();
    const currentCenterX = currentRect.left + currentRect.width / 2;
    const rowTolerance = 8;
    const mapped = cards.map((el, idx) => ({
      idx,
      rect: el.getBoundingClientRect(),
    }));

    if (direction === "up" || direction === "down") {
      const vertical = mapped.filter((m) =>
        direction === "down"
          ? m.rect.top > currentRect.top + rowTolerance
          : m.rect.top < currentRect.top - rowTolerance,
      );
      if (!vertical.length) return null;
      const targetTop =
        direction === "down"
          ? Math.min(...vertical.map((m) => m.rect.top))
          : Math.max(...vertical.map((m) => m.rect.top));
      const targetRow = vertical.filter(
        (m) => Math.abs(m.rect.top - targetTop) <= rowTolerance,
      );
      if (!targetRow.length) return null;
      targetRow.sort((a, b) => {
        const aCx = a.rect.left + a.rect.width / 2;
        const bCx = b.rect.left + b.rect.width / 2;
        return Math.abs(aCx - currentCenterX) - Math.abs(bCx - currentCenterX);
      });
      return targetRow[0]?.idx ?? null;
    }

    const sameRow = mapped.filter(
      (m) => Math.abs(m.rect.top - currentRect.top) <= rowTolerance,
    );
    if (!sameRow.length) return null;
    if (direction === "left") {
      const lefts = sameRow
        .filter((m) => m.rect.left + m.rect.width / 2 < currentCenterX - 1)
        .sort(
          (a, b) =>
            b.rect.left + b.rect.width / 2 - (a.rect.left + a.rect.width / 2),
        );
      return lefts[0]?.idx ?? null;
    }
    const rights = sameRow
      .filter((m) => m.rect.left + m.rect.width / 2 > currentCenterX + 1)
      .sort(
        (a, b) =>
          a.rect.left + a.rect.width / 2 - (b.rect.left + b.rect.width / 2),
      );
    return rights[0]?.idx ?? null;
  };

  // Hero items
  const focusedGridSeries = createMemo<SeriesListItem | null>(() => {
    if (zone() !== "grid") return null;
    return genreSeries()[gridIdx()] ?? null;
  });

  const heroItems = createMemo<HeroItem[]>(() => {
    const fg = focusedGridSeries();
    const source = fg
      ? [fg]
      : (featuredSeries()[0] ? [featuredSeries()[0]] : []);
    return source.map((s) =>
      seriesToHero(
        s,
        () => navigate(`/series/${s.id}`),
        () => navigate(`/series/${s.id}`),
      ),
    );
  });

  // Keyboard handler
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;
      const NAV = [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Enter",
        "Escape",
        "Backspace",
      ];
      if (!NAV.includes(e.key)) return;
      e.preventDefault();

      if (zone() === "hero") {
        if (e.key === "ArrowDown") {
          if (
            selectedGenre().id === LATEST_ID &&
            featuredSeries().length > 0
          ) {
            setZone("sort");
            setSortIdx(0);
          } else {
            setZone("sidebar");
            setSidebarIdx(0);
          }
        } else if (
          e.key === "ArrowUp" ||
          e.key === "Escape" ||
          e.key === "Backspace"
        ) {
          setAppShellZone("nav");
        } else if (e.key === "Enter") {
          const s = focusedGridSeries() ?? featuredSeries()[0];
          if (s) navigate(`/series/${s.id}`);
        }
        return;
      }

      if (zone() === "sort") {
        const total = SERIES_SORT_OPTIONS.length;
        if (e.key === "ArrowLeft") {
          if (sortIdx() > 0) setSortIdx((i) => i - 1);
          else setZone("sidebar");
        } else if (e.key === "ArrowRight") {
          setSortIdx((i) => Math.min(total - 1, i + 1));
        } else if (e.key === "ArrowDown") {
          if (genreSeries().length > 0) {
            setZone("grid");
            setGridIdx(0);
          } else {
            setZone("sidebar");
          }
        } else if (e.key === "ArrowUp") {
          setZone("hero");
        } else if (e.key === "Enter" || e.key === " ") {
          const opt = SERIES_SORT_OPTIONS[sortIdx()];
          if (opt) setSeriesSort(opt.value);
        } else if (e.key === "Escape" || e.key === "Backspace") {
          setZone("hero");
        }
        return;
      }

      if (zone() === "sidebar") {
        if (e.key === "ArrowUp") {
          if (sidebarIdx() === 0) setAppShellZone("nav");
          else navigateSidebar(sidebarIdx() - 1);
        } else if (e.key === "ArrowDown") {
          navigateSidebar(sidebarIdx() + 1);
        } else if (e.key === "ArrowRight" || e.key === "Enter") {
          if (genreSeries().length > 0) {
            setZone("grid");
            setGridIdx(0);
          }
        } else if (e.key === "Escape" || e.key === "Backspace") {
          setAppShellZone("nav");
        }
        return;
      }

      // Grid zone
      if (e.key === "ArrowRight") {
        const next = moveByGeometry("right");
        if (next != null) setGridIdx(next);
      } else if (e.key === "ArrowLeft") {
        const next = moveByGeometry("left");
        if (next == null) setZone("sidebar");
        else setGridIdx(next);
      } else if (e.key === "ArrowDown") {
        const next = moveByGeometry("down");
        if (next != null) setGridIdx(next);
      } else if (e.key === "ArrowUp") {
        const next = moveByGeometry("up");
        if (next == null) {
          if (selectedGenre().id === LATEST_ID) {
            setZone("sort");
            setSortIdx(0);
          } else {
            setZone("sidebar");
          }
        } else {
          setGridIdx(next);
        }
      } else if (e.key === "Enter") {
        const s = genreSeries()[gridIdx()];
        if (s) navigate(`/series/${s.id}`);
      } else if (e.key === "Escape" || e.key === "Backspace") {
        setZone("sidebar");
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  return (
    <div class="series-page sp-browser">
      <Show when={heroItems().length > 0}>
        <HeroCarousel
          className="sp-browser-hero"
          activeIndex={0}
          animKey={0}
          items={heroItems()}
          previewClip={null}
          previewEnabled={false}
          focused={zone() === "hero"}
        />
      </Show>

      <div
        class={`sp-body${zone() !== "sidebar" ? " sp-body--sidebar-collapsed" : ""}`}
      >
        <Sidebar
          title="🎬 Series"
          class="sp-series-sidebar"
          collapsed={() => zone() !== "sidebar"}
          items={sidebarUiItems()}
          activeId={() => selectedGenre()?.id ?? null}
          focusedIdx={sidebarIdx}
          isFocused={() => zone() === "sidebar"}
          onSelect={(_item, i) => {
            setSidebarIdx(i);
            const g = sidebarItems()[i];
            setSelectedGenre(g);
            loadForGenre(g);
          }}
        />

        <div
          class={`sp-genre-panel${zone() === "grid" ? " sp-genre-panel--active" : ""}`}
        >
          <div class="sp-genre-panel-hdr">
            <h2 class="sp-genre-panel-title">
              {selectedGenre()?.id === LATEST_ID
                ? "🕐 Latest Series"
                : selectedGenre()?.name ?? ""}
            </h2>
            <Show when={!genreLoading() && genreSeries().length > 0}>
              <span class="sp-genre-panel-count">
                {genreSeries().length} series
              </span>
            </Show>
          </div>

          <Show when={selectedGenre()?.id === LATEST_ID}>
            <SortSelector
              value={seriesSort}
              options={SERIES_SORT_OPTIONS}
              onChange={setSeriesSort}
              isFocused={() => zone() === "sort"}
              focusedIdx={sortIdx}
            />
          </Show>

          <Show
            when={!genreLoading()}
            fallback={
              <div class="sp-genre-grid">
                <Index each={Array(14).fill(null)}>
                  {() => <SkeletonCard />}
                </Index>
              </div>
            }
          >
            <Show
              when={genreSeries().length > 0}
              fallback={
                <div class="sp-empty-state">
                  <span class="sp-empty-icon">📺</span>
                  <p>{genreError() || "No series in this genre"}</p>
                </div>
              }
            >
              <div class="sp-genre-grid" ref={(el) => (gridRef = el)}>
                <For each={genreSeries()}>
                  {(s, i) => (
                    <SeriesMediaCard
                      item={seriesToCard(s)}
                      focused={zone() === "grid" && gridIdx() === i()}
                      onClick={() => navigate(`/series/${s.id}`)}
                    />
                  )}
                </For>
                <Show when={genreHasMore() || genreLoadingMore()}>
                  <div
                    class="sp-grid-load-sentinel"
                    ref={(el) => (gridLoadMoreRef = el)}
                  >
                    {genreLoadingMore() ? "Loading more…" : ""}
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
