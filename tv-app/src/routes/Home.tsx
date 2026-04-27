import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import HeroCarousel, { type HeroItem } from "../components/HeroCarousel";
import PosterCard from "../components/PosterCard";
import Rail from "../components/Rail";
import { listMovies, listSeries } from "../api/catalog";
import type { MovieListItem, SeriesListItem } from "../api/types";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";
import { appShellZone, setAppShellZone } from "../stores/shell";

/**
 * Home — first screen after login.
 *
 *   ┌─ HeroCarousel: top-5 popular movies ──────────────────────┐
 *   ├─ Rail "Latest Movies" (newest by `added_desc`) ───────────┤
 *   └─ Rail "Latest Series" (newest by `last_modified_desc`) ───┘
 *
 * One navigation scope. Internal state tracks the focused zone +
 * per-zone selected index (so column position is remembered when
 * switching rails).
 *
 *   D-pad up/down  → switch zone (hero ↔ movies ↔ series)
 *   D-pad left/right → move within current zone
 *   Enter          → open detail (or play, when on a hero CTA — TBD)
 */

type Zone = "hero" | "movies" | "series";
const ZONES: Zone[] = ["hero", "movies", "series"];

const HERO_COUNT = 5;
const RAIL_PAGE_SIZE = 30;

// TMDB image sizing — TMDB image URLs we already have are full-resolution.
// Pages can request a smaller variant via /t/p/w… but the upstream URLs are
// returned by Xtream's get_vod_info; we just consume them.
function backdropUrl(item: MovieListItem | SeriesListItem): string | null {
  const m = item as MovieListItem;
  if (m.backdrop_path) return m.backdrop_path;
  if ((m as MovieListItem).cover_big) return (m as MovieListItem).cover_big!;
  return null;
}

function posterUrl(item: MovieListItem | SeriesListItem): string | null {
  const m = item as MovieListItem;
  if (m.cover_big) return m.cover_big;
  if ((m as MovieListItem).stream_icon) return (m as MovieListItem).stream_icon!;
  if ((item as SeriesListItem).cover) return (item as SeriesListItem).cover!;
  return null;
}

export default function Home() {
  const navigate = useNavigate();

  const [popular] = createResource(() =>
    listMovies({ sort: "popularity_desc", per_page: HERO_COUNT }),
  );
  const [latestMovies] = createResource(() =>
    listMovies({ sort: "added_desc", per_page: RAIL_PAGE_SIZE }),
  );
  const [latestSeries] = createResource(() =>
    listSeries({ sort: "last_modified_desc", per_page: RAIL_PAGE_SIZE }),
  );

  // -------------------------------------------------------------------------
  // Navigation state
  // -------------------------------------------------------------------------

  const [zone, setZone] = createSignal<Zone>("hero");
  const [heroIdx, setHeroIdx] = createSignal(0);
  const [moviesIdx, setMoviesIdx] = createSignal(0);
  const [seriesIdx, setSeriesIdx] = createSignal(0);

  const { isScopeOwner, setActive } = useNavigationScope("home", {
    priority: 0,
    active: appShellZone() === "content",
  });
  createEffect(() => setActive(appShellZone() === "content"));

  // -------------------------------------------------------------------------
  // Derived hero items (top popular movies)
  // -------------------------------------------------------------------------

  const heroItems = createMemo<HeroItem[]>(() => {
    const page = popular();
    if (!page) return [];
    return page.items.slice(0, HERO_COUNT).map((m) => {
      const meta = (
        <>
          {m.year && <span>{m.year}</span>}
          {m.tmdb_vote_average != null && (
            <span class="ml-2">★ {m.tmdb_vote_average.toFixed(1)}</span>
          )}
        </>
      );
      return {
        id: m.id,
        title: m.name,
        backdrop: backdropUrl(m),
        poster: posterUrl(m),
        plot: null, // detail-only field; not in list response
        meta,
        tags: m.genres.slice(0, 3),
      };
    });
  });

  // -------------------------------------------------------------------------
  // Keyboard handling
  // -------------------------------------------------------------------------

  function moveZone(delta: 1 | -1) {
    const cur = zone();
    const idx = ZONES.indexOf(cur);
    const next = idx + delta;
    if (next < 0) {
      // Escape upward into the TopNav
      setAppShellZone("nav");
      return;
    }
    if (next >= ZONES.length) return; // clamp at bottom
    setZone(ZONES[next]);
  }

  function moveWithinZone(delta: 1 | -1) {
    const cur = zone();
    if (cur === "hero") {
      const total = heroItems().length;
      if (total === 0) return;
      setHeroIdx((i) => (i + delta + total) % total); // wrap on hero (matches Netflix)
    } else if (cur === "movies") {
      const total = latestMovies()?.items.length ?? 0;
      if (total === 0) return;
      setMoviesIdx((i) => Math.min(Math.max(i + delta, 0), total - 1));
    } else if (cur === "series") {
      const total = latestSeries()?.items.length ?? 0;
      if (total === 0) return;
      setSeriesIdx((i) => Math.min(Math.max(i + delta, 0), total - 1));
    }
  }

  function activate() {
    const cur = zone();
    if (cur === "hero") {
      const item = heroItems()[heroIdx()];
      if (item) navigate(`/movies/${item.id}`);
    } else if (cur === "movies") {
      const item = latestMovies()?.items[moviesIdx()];
      if (item) navigate(`/movies/${item.id}`);
    } else if (cur === "series") {
      const item = latestSeries()?.items[seriesIdx()];
      if (item) navigate(`/series/${item.id}`);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (!isScopeOwner()) return;
    if (!isDirectionalKey(e.key) && !isSelectKey(e.key)) return;
    e.preventDefault();
    switch (e.key) {
      case "ArrowUp":
        moveZone(-1);
        break;
      case "ArrowDown":
        moveZone(1);
        break;
      case "ArrowLeft":
        moveWithinZone(-1);
        break;
      case "ArrowRight":
        moveWithinZone(1);
        break;
      case "Enter":
      case " ":
        activate();
        break;
    }
  }

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div class="min-h-screen pb-12">
      <Show
        when={heroItems().length > 0}
        fallback={
          <div class="h-[55vh] min-h-[380px] flex items-center justify-center text-zinc-600 text-sm">
            <Show when={popular.loading} fallback={<span>No featured items.</span>}>
              Loading featured…
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
              onClick: () => activate(),
            },
          ]}
        />
      </Show>

      <div class="mt-8">
        <Rail
          title="Latest Movies"
          items={latestMovies()?.items ?? []}
          selectedIndex={moviesIdx}
          isFocused={() => zone() === "movies"}
          renderItem={(item, focused) => (
            <PosterCard
              title={item.name}
              imageUrl={posterUrl(item)}
              focused={() => focused}
              onClick={() => {
                setZone("movies");
                setMoviesIdx(latestMovies()!.items.indexOf(item));
                navigate(`/movies/${item.id}`);
              }}
              meta={
                <>
                  {item.year && <span>{item.year}</span>}
                  {item.tmdb_vote_average != null && (
                    <span class="ml-2">★ {item.tmdb_vote_average.toFixed(1)}</span>
                  )}
                </>
              }
            />
          )}
        />

        <Rail
          title="Latest Series"
          items={latestSeries()?.items ?? []}
          selectedIndex={seriesIdx}
          isFocused={() => zone() === "series"}
          renderItem={(item, focused) => (
            <PosterCard
              title={item.name}
              imageUrl={posterUrl(item)}
              focused={() => focused}
              onClick={() => {
                setZone("series");
                setSeriesIdx(latestSeries()!.items.indexOf(item));
                navigate(`/series/${item.id}`);
              }}
              meta={
                <>
                  {item.tmdb_vote_average != null && (
                    <span>★ {item.tmdb_vote_average.toFixed(1)}</span>
                  )}
                </>
              }
            />
          )}
        />
      </div>
    </div>
  );
}
