/**
 * Movies — vertical genre lazy-load grid + collapsible sidebar + modal.
 *
 * Faithful Solid port of `tv_app_v2/src/pages/MoviesPage.jsx` (907 LOC).
 * Same shell: HeroCarousel showing the focused-grid card (or a featured
 * fallback), `.sp-series-sidebar` collapsed when zone≠'sidebar', vertical
 * grid of MovieMediaCards with IntersectionObserver-driven infinite
 * scroll, modal detail on Enter.
 *
 * Three-zone keyboard model (`zone`: 'hero' | 'sidebar' | 'grid'):
 *   hero ↓ → sidebar; hero ↑/Esc → topnav; hero Enter → play featured/focused
 *   sidebar ↑ at idx 0 → topnav; sidebar →/Enter → grid; sidebar Esc → topnav
 *   grid ←/→/↑/↓ — geometry-based grid neighbors via getBoundingClientRect;
 *     ← at first column (or no left neighbor) → sidebar
 *     Enter → open modal; Esc/Back → sidebar
 *
 * API mapping vs the legacy:
 *   - `fetchStreamGenres({type:'vod'})`        → `listMovieGenres()`
 *   - `fetchVOD({categoryIds, genre, limit, offset})`
 *                                              → `listMovies({category_id (csv), genre_id, sort:'added_desc', page, per_page})`
 *   - Genres in our backend are filtered by `genre_id`, not by name. We
 *     resolve name→id from the loaded genre list.
 *   - Prefs (`getContentPrefs().movies`) are passed as a comma-separated
 *     `category_id` (backend supports multi-value since the recent
 *     extension). Null → no filter; [] → empty result.
 *
 * Deferred (separate iterations):
 *   - Hero preview clip — our auth model doesn't expose a direct stream
 *     URL without a slot allocation; needs a backend "preview" endpoint.
 *   - Watchlist — no store ported yet; modal shows only Play.
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
import { listMovieGenres, listMovies } from "../api/catalog";
import type {
  GenreCountOut,
  MovieListItem,
  MovieSort,
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
import MovieMediaCard from "../components/MovieMediaCard";
import SkeletonCard from "../components/SkeletonCard";
import MovieDetailModal from "../components/MovieDetailModal";
import { type CardItem } from "../components/cardItem";
import {
  movieSort,
  setMovieSort,
  MOVIE_SORT_OPTIONS,
} from "../lib/sortPrefs";
import SortSelector from "../components/SortSelector";
import { openPlayer } from "../stores/player";
import { previewMovie } from "../api/play";
import type { PreviewClip } from "../components/HeroCarousel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LATEST_ID = "__latest__";
const OTHERS_ID = "__others__";
const MOVIES_PAGE_SIZE = 60;

interface SidebarGenre {
  id: string | number;
  name: string;
  movie_count: number | null;
}

const LATEST_ENTRY: SidebarGenre = {
  id: LATEST_ID,
  name: "🕐 Latest",
  movie_count: null,
};
const OTHERS_ENTRY: SidebarGenre = {
  id: OTHERS_ID,
  name: "Others",
  movie_count: null,
};

type Zone = "hero" | "sidebar" | "grid" | "sort";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function movieAddedTs(m: MovieListItem): number {
  const raw = m.added;
  if (!raw) return 0;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber > 2_000_000_000 ? asNumber : asNumber * 1000;
  }
  const d = Date.parse(String(raw).replace(" ", "T"));
  return Number.isNaN(d) ? 0 : d;
}

function movieToCard(m: MovieListItem): CardItem {
  return {
    id: m.id,
    title: m.name,
    name: m.name,
    backdrop: m.backdrop_path,
    poster: m.cover_big ?? m.stream_icon,
    year: m.year,
    rating: m.rating_5based,
    language: m.language,
    runtime: m.duration_secs ? Math.round(m.duration_secs / 60) : null,
    genres: m.genres,
    type: "movie",
  };
}

function movieToHero(
  m: MovieListItem,
  onPlay: () => void,
  onMore: () => void,
  loading: boolean,
): HeroItem {
  const badges: HeroBadge[] = [{ label: "🎬 Movie", variant: "movie" }];
  if (m.year) badges.push({ label: String(m.year), variant: "year" });
  if (m.rating_5based != null) {
    badges.push({
      label: `⭐ ${m.rating_5based.toFixed(1)}`,
      variant: "rating",
    });
  }
  if (m.duration_secs) {
    const mins = Math.round(m.duration_secs / 60);
    badges.push({
      label: `${Math.floor(mins / 60)}h ${mins % 60}m`,
      variant: "runtime",
    });
  }
  if (m.language) {
    badges.push({ label: m.language.toUpperCase(), variant: "lang" });
  }
  return {
    id: m.id,
    title: m.name,
    poster: m.cover_big ?? m.stream_icon,
    backdrop: m.backdrop_path,
    gradient: getGradient(m.name),
    accent: getAccent(m.name),
    badges,
    genres: m.genres,
    plot: null,
    primaryAction: {
      label: "▶ Watch Now",
      onClick: onPlay,
      loading,
    },
    secondaryAction: {
      label: "📋 Details",
      onClick: onMore,
    },
  };
}

/**
 * Resolve content-prefs movie categories into the comma-separated form
 * the backend accepts. Returns:
 *   null   → no restriction (don't pass category_id)
 *   ""     → user explicitly deselected everything (caller should bail)
 *   "1,2,3" → filter to these categories
 */
function resolveCategoryIdsParam(): string | null | "" {
  const pref = getContentPrefs().movies;
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

export default function Movies(): JSX.Element {
  const { isScopeOwner } = useNavigationScope("page:movies", {
    active: true,
    priority: 30,
  });

  // Genres ----------------------------------------------------------------
  const [genres] = createResource<GenreCountOut[]>(() =>
    listMovieGenres().catch(() => [] as GenreCountOut[]),
  );

  const sidebarGenres = createMemo<SidebarGenre[]>(() => {
    const list = genres() ?? [];
    return list
      .map((g) => ({
        id: g.id,
        name: g.name,
        movie_count: g.count ?? null,
      }));
  });

  const sidebarItems = createMemo<SidebarGenre[]>(() => [
    LATEST_ENTRY,
    ...sidebarGenres(),
    OTHERS_ENTRY,
  ]);

  const sidebarUiItems = createMemo<SidebarItem[]>(() =>
    sidebarItems().map((g) => ({
      id: g.id,
      label: g.name,
      count: g.movie_count,
    })),
  );

  // Focus / zone state ----------------------------------------------------
  const [zone, setZone] = createSignal<Zone>("hero");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [gridIdx, setGridIdx] = createSignal(0);
  const [sortIdx, setSortIdx] = createSignal(0);
  const [selectedGenre, setSelectedGenre] = createSignal<SidebarGenre>(
    LATEST_ENTRY,
  );

  // Grid data state -------------------------------------------------------
  const [genreMovies, setGenreMovies] = createSignal<MovieListItem[]>([]);
  const [genreLoading, setGenreLoading] = createSignal(false);
  const [genreLoadingMore, setGenreLoadingMore] = createSignal(false);
  const [genreHasMore, setGenreHasMore] = createSignal(true);
  const [genrePage, setGenrePage] = createSignal(1);
  const [genreError, setGenreError] = createSignal<string | null>(null);

  // Featured fallback (first non-empty load with poster art)
  const [featuredMovies, setFeaturedMovies] = createSignal<MovieListItem[]>(
    [],
  );
  let featuredSet = false;

  // Modal -----------------------------------------------------------------
  const [selectedMovie, setSelectedMovie] = createSignal<MovieListItem | null>(
    null,
  );

  // Refs (for geometry-based grid nav) — signals so the
  // IntersectionObserver effect re-runs when the elements mount.
  // With plain `let`s, the effect ran once with both undefined and
  // never re-ran, so infinite scroll never attached.
  const [gridRef, setGridRef] = createSignal<HTMLDivElement | null>(null);
  const [gridLoadMoreRef, setGridLoadMoreRef] =
    createSignal<HTMLDivElement | null>(null);
  let loadDebounce: number | null = null;

  // ── Load movies for a given genre (replaces page or appends) ──────────
  const loadForGenre = async (
    genre: SidebarGenre,
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
      setGenreMovies([]);
      setGridIdx(0);
      setGenrePage(1);
      setGenreHasMore(true);
    }

    try {
      const cat = resolveCategoryIdsParam();
      if (cat === "") {
        // User deselected all categories — respect it.
        setGenreMovies([]);
        setGenreHasMore(false);
        return;
      }

      // Resolve genre filter:
      //   LATEST  → no genre_id, sort by user pref
      //   OTHERS  → no genre_id, client-side filter for empty genres[]
      //   normal  → genre_id from sidebar entry
      const isLatest = genre.id === LATEST_ID;
      const isOthers = genre.id === OTHERS_ID;
      const genreId =
        isLatest || isOthers ? undefined : (Number(genre.id) || undefined);

      const sortValue: MovieSort = isLatest
        ? movieSort()
        : "added_desc";

      const resp = await listMovies({
        category_id: cat ?? undefined,
        genre_id: genreId,
        sort: sortValue,
        page: targetPage,
        per_page: MOVIES_PAGE_SIZE,
      });

      let data = resp.items;
      if (isOthers) {
        data = data.filter(
          (m) => !Array.isArray(m.genres) || m.genres.length === 0,
        );
      }
      data = [...data].sort(
        (a, b) => movieAddedTs(b) - movieAddedTs(a),
      );

      if (isAppend) {
        setGenreMovies((prev) => {
          const seen = new Set(prev.map((x) => String(x.id)));
          const next = [...prev];
          for (const item of data) {
            if (seen.has(String(item.id))) continue;
            seen.add(String(item.id));
            next.push(item);
          }
          next.sort((a, b) => movieAddedTs(b) - movieAddedTs(a));
          return next;
        });
      } else {
        setGenreMovies(data);
      }

      if (isOthers) {
        setGenreHasMore(false);
      } else {
        setGenrePage(targetPage);
        setGenreHasMore(resp.has_next);
      }

      if (!isAppend && !featuredSet) {
        const withArt = data.filter((m) => m.cover_big || m.stream_icon);
        if (withArt.length > 0) {
          featuredSet = true;
          setFeaturedMovies(withArt.slice(0, 8));
        }
      }
    } catch (e) {
      setGenreError(
        e instanceof Error ? e.message : "Failed to load movies",
      );
      if (isAppend) setGenreHasMore(false);
    } finally {
      if (isAppend) setGenreLoadingMore(false);
      else setGenreLoading(false);
    }
  };

  // Initial load — Latest.
  createEffect(() => {
    loadForGenre(LATEST_ENTRY);
  });

  // Reload Latest when sort changes (only for the Latest entry).
  createEffect(
    on(movieSort, (s) => {
      if (selectedGenre().id === LATEST_ID) {
        // s is read for tracking
        void s;
        loadForGenre(LATEST_ENTRY);
      }
    }, { defer: true }),
  );

  // ── Sidebar selection (debounced) ────────────────────────────────────
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

  // ── IntersectionObserver for infinite scroll ─────────────────────────
  // Tracks gridRef + gridLoadMoreRef signals so the observer attaches as
  // soon as both elements mount. The previous version used plain `let`s
  // and the effect bailed on first run (refs still undefined), then
  // never re-ran, so infinite scroll silently no-op'd.
  createEffect(() => {
    const root = gridRef();
    const target = gridLoadMoreRef();
    if (!root || !target) return;
    if (!genreHasMore()) return;
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

  // Auto-scroll the focused card into view in the grid.
  createEffect(() => {
    if (zone() !== "grid") return;
    const i = gridIdx();
    queueMicrotask(() => {
      const child = gridRef()?.children[i] as HTMLElement | undefined;
      child?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
    });
  });

  // ── Geometry-based grid neighbors ────────────────────────────────────
  // Geometry-based grid neighbors. Uses offsetTop / offsetLeft / offsetWidth
  // (static layout box) instead of getBoundingClientRect — the focused card
  // has `transform: scale(1.075)` which shifts the rendered rect's top, and
  // a tall enough scale offset can exceed the row tolerance and split the
  // focused card from its visual row. offsetTop is unaffected by transforms,
  // so the row band stays correct regardless of focus scale.
  const moveByGeometry = (
    direction: "up" | "down" | "left" | "right",
  ): number | null => {
    const grid = gridRef();
    if (!grid) return null;
    const cards = Array.from(grid.children).filter(
      (el) => !(el as HTMLElement).classList.contains("sp-grid-load-sentinel"),
    ) as HTMLElement[];
    if (!cards.length) return null;
    const current = cards[gridIdx()];
    if (!current) return null;
    const rowTolerance = 8;
    const mapped = cards.map((el, idx) => ({
      idx,
      top: el.offsetTop,
      left: el.offsetLeft,
      width: el.offsetWidth,
    }));
    const cur = mapped[gridIdx()];
    if (!cur) return null;
    const currentCenterX = cur.left + cur.width / 2;

    if (direction === "up" || direction === "down") {
      const vertical = mapped.filter((m) =>
        direction === "down"
          ? m.top > cur.top + rowTolerance
          : m.top < cur.top - rowTolerance,
      );
      if (!vertical.length) return null;
      const targetTop =
        direction === "down"
          ? Math.min(...vertical.map((m) => m.top))
          : Math.max(...vertical.map((m) => m.top));
      const targetRow = vertical.filter(
        (m) => Math.abs(m.top - targetTop) <= rowTolerance,
      );
      if (!targetRow.length) return null;
      targetRow.sort((a, b) => {
        const aCx = a.left + a.width / 2;
        const bCx = b.left + b.width / 2;
        return Math.abs(aCx - currentCenterX) - Math.abs(bCx - currentCenterX);
      });
      return targetRow[0]?.idx ?? null;
    }

    const sameRow = mapped.filter(
      (m) => Math.abs(m.top - cur.top) <= rowTolerance,
    );
    if (!sameRow.length) return null;
    if (direction === "left") {
      const lefts = sameRow
        .filter((m) => m.left + m.width / 2 < currentCenterX - 1)
        .sort(
          (a, b) => b.left + b.width / 2 - (a.left + a.width / 2),
        );
      return lefts[0]?.idx ?? null;
    }
    const rights = sameRow
      .filter((m) => m.left + m.width / 2 > currentCenterX + 1)
      .sort((a, b) => a.left + a.width / 2 - (b.left + b.width / 2));
    return rights[0]?.idx ?? null;
  };

  const moviePlayNow = (m: MovieListItem) => {
    openPlayer({ kind: "movie", movie: m });
  };

  // ── Hero items ───────────────────────────────────────────────────────
  const focusedGridMovie = createMemo<MovieListItem | null>(() => {
    if (zone() !== "grid" || selectedMovie()) return null;
    return genreMovies()[gridIdx()] ?? null;
  });

  const heroItems = createMemo<HeroItem[]>(() => {
    const fg = focusedGridMovie();
    const source = fg ? [fg] : (featuredMovies()[0] ? [featuredMovies()[0]] : []);
    return source.map((m) =>
      movieToHero(
        m,
        () => moviePlayNow(m),
        () => setSelectedMovie(m),
        false,
      ),
    );
  });

  // ── Hero preview clip ──────────────────────────────────────────────
  // After the focused card is held for 3s (legacy debounce so quick
  // browsing doesn't kick off requests), fetch a direct stream URL
  // (no slot allocation — see /api/v1/play/preview/movie) and feed
  // it to HeroCarousel as a 60-second clip starting somewhere between
  // 5–10 minutes in. The previewSwitchReq epoch inside HeroCarousel
  // discards stale switches when focus moves before the clip lands.
  const [heroPreviewClip, setHeroPreviewClip] =
    createSignal<PreviewClip | null>(null);
  let previewDelay: number | null = null;
  let previewReqId = 0;
  createEffect(() => {
    const fg = focusedGridMovie();
    if (previewDelay != null) clearTimeout(previewDelay);
    previewReqId += 1;
    setHeroPreviewClip(null);
    if (!fg || selectedMovie()) return;
    const reqId = previewReqId;
    previewDelay = window.setTimeout(async () => {
      if (previewReqId !== reqId) return;
      try {
        const { url } = await previewMovie(fg.id);
        if (previewReqId !== reqId) return;
        setHeroPreviewClip({
          clipId: `${fg.id}-${Date.now()}`,
          url,
          startAtSec: 300 + Math.floor(Math.random() * 300),
          playForSec: 60,
        });
      } catch {
        /* preview failed — silent */
      }
    }, 3000);
  });
  onCleanup(() => {
    if (previewDelay != null) clearTimeout(previewDelay);
  });

  // ── Keyboard handler ─────────────────────────────────────────────────
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;
      if (selectedMovie()) return; // modal owns input

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
          // Latest selected? Land on the sort row first.
          if (
            selectedGenre().id === LATEST_ID &&
            featuredMovies().length > 0
          ) {
            setZone("sort");
            setSortIdx(0);
          } else {
            setZone("sidebar");
            setSidebarIdx(0);
          }
        } else if (e.key === "ArrowUp" || e.key === "Escape" || e.key === "Backspace") {
          setAppShellZone("nav");
        } else if (e.key === "Enter") {
          const m = focusedGridMovie() ?? featuredMovies()[0];
          if (m) moviePlayNow(m);
        }
        return;
      }

      if (zone() === "sort") {
        const total = MOVIE_SORT_OPTIONS.length;
        if (e.key === "ArrowLeft") {
          if (sortIdx() > 0) setSortIdx((i) => i - 1);
          else setZone("sidebar");
        } else if (e.key === "ArrowRight") {
          setSortIdx((i) => Math.min(total - 1, i + 1));
        } else if (e.key === "ArrowDown") {
          if (genreMovies().length > 0) {
            setZone("grid");
            setGridIdx(0);
          } else {
            setZone("sidebar");
          }
        } else if (e.key === "ArrowUp") {
          setZone("hero");
        } else if (e.key === "Enter" || e.key === " ") {
          const opt = MOVIE_SORT_OPTIONS[sortIdx()];
          if (opt) setMovieSort(opt.value);
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
          if (genreMovies().length > 0) {
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
          // No row above — pop back to sort row (Latest only) or sidebar.
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
        const m = genreMovies()[gridIdx()];
        if (m) setSelectedMovie(m);
      } else if (e.key === "Escape" || e.key === "Backspace") {
        setZone("sidebar");
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  return (
    <div class="series-page sp-browser movies-page">
      <Show when={heroItems().length > 0}>
        <HeroCarousel
          className="sp-browser-hero mp-browser-hero"
          activeIndex={0}
          animKey={0}
          items={heroItems()}
          previewClip={heroPreviewClip()}
          previewEnabled={!selectedMovie()}
          focused={zone() === "hero"}
        />
      </Show>

      <div
        class={`sp-body${zone() !== "sidebar" ? " sp-body--sidebar-collapsed" : ""}`}
      >
        <Sidebar
          title=""
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
                ? "🕐 Latest Movies"
                : selectedGenre()?.name ?? ""}
            </h2>
            <Show when={!genreLoading() && genreMovies().length > 0}>
              <span class="sp-genre-panel-count">
                {genreMovies().length} movies
              </span>
            </Show>
          </div>

          <Show when={selectedGenre()?.id === LATEST_ID}>
            <SortSelector
              value={movieSort}
              options={MOVIE_SORT_OPTIONS}
              onChange={setMovieSort}
              isFocused={() => zone() === "sort"}
              focusedIdx={sortIdx}
            />
          </Show>

          <Show
            when={!genreLoading()}
            fallback={
              <div class="sp-genre-grid sp-genre-grid--movies">
                <Index each={Array(14).fill(null)}>
                  {() => <SkeletonCard />}
                </Index>
              </div>
            }
          >
            <Show
              when={genreMovies().length > 0}
              fallback={
                <div class="sp-empty-state">
                  <span class="sp-empty-icon">🎬</span>
                  <p>{genreError() || "No movies in this genre"}</p>
                </div>
              }
            >
              <div
                class="sp-genre-grid sp-genre-grid--movies"
                ref={(el) => setGridRef(el)}
              >
                <For each={genreMovies()}>
                  {(m, i) => (
                    <MovieMediaCard
                      item={movieToCard(m)}
                      focused={
                        zone() === "grid" &&
                        gridIdx() === i() &&
                        !selectedMovie()
                      }
                      onClick={() => setSelectedMovie(m)}
                    />
                  )}
                </For>
                <Show when={genreHasMore() || genreLoadingMore()}>
                  <div
                    class="sp-grid-load-sentinel"
                    ref={(el) => setGridLoadMoreRef(el)}
                  >
                    {genreLoadingMore() ? "Loading more…" : ""}
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={selectedMovie()}>
        <MovieDetailModal
          movie={selectedMovie()!}
          onClose={() => setSelectedMovie(null)}
          onPlay={() => {
            const m = selectedMovie();
            if (!m) return;
            setSelectedMovie(null);
            moviePlayNow(m);
          }}
        />
      </Show>
    </div>
  );
}
