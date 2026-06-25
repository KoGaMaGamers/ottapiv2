/**
 * Home — Prime-Video-style home page: hero carousel + content rows.
 *
 * Faithful Solid port of `tv_app_v2/src/pages/HomePage.jsx`. Same
 * keyboard model (focusedRow=-1 means hero is focused, 0..N-1 are
 * content rows; Up at row 0 escapes to the nav scope, Escape at
 * row≥0 returns to the hero), same hero auto-advance cadence
 * (7000ms), same gradient/accent palette, same hero-pool interleave
 * (good-rated movies + popular series, evenly spaced).
 *
 * Adapted to the new typed catalog API:
 *   - Latest Movies   → listMovies({ sort: 'added_desc' })
 *   - Top Rated       → listMovies({ sort: 'rating_desc' })
 *   - Latest Series   → listSeries({ sort: 'last_modified_desc' })
 *
 * Continue Watching + Preferred Channels rows are skipped until the
 * playback-progress and channel-pref stores are ported.
 *
 * Play resolution shows a toast for now — the MediaPlayer + heartbeat
 * layer ports later.
 */

import {
  createSignal,
  createMemo,
  createEffect,
  createResource,
  onCleanup,
  Show,
  For,
  type JSX,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { listMovies, listSeries } from "../api/catalog";
import type { MovieListItem, SeriesListItem } from "../api/types";
import { useNavigationScope } from "../lib/navigation";
import { setAppShellZone } from "../stores/shell";
import { isBackKey, isSelectKey } from "../lib/navigationKeys";
import { getGradient, getAccent } from "../lib/gradient";
import { getContentPrefs } from "../lib/contentPrefs";
import HeroCarousel, {
  type HeroItem,
  type HeroBadge,
} from "../components/HeroCarousel";
import MovieMediaCard from "../components/MovieMediaCard";
import SeriesMediaCard from "../components/SeriesMediaCard";
import { type CardItem } from "../components/cardItem";
import { openPlayer } from "../stores/player";
import {
  BookmarkIcon,
  FilmIcon,
  ResumeIcon,
  SparkleIcon,
  StarIcon,
  TvIcon,
} from "../components/icons";
import {
  getContinueWatchingItems,
  playbackState,
  type ContinueItem,
} from "../lib/playbackStore";
import {
  listWatchlist,
  watchlistState,
  type WatchlistItem,
} from "../lib/watchlistStore";
import { historyState, listHistory } from "../lib/historyStore";
import { getRecommendations } from "../api/recommendations";

// ---------------------------------------------------------------------------
// Adapters: typed list items → UI shapes
// ---------------------------------------------------------------------------

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
    // duration_secs → minutes; parseRuntimeLabel treats numbers as minutes.
    runtime: m.duration_secs ? Math.round(m.duration_secs / 60) : null,
    genres: m.genres,
    type: "movie",
  };
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

function movieToHero(
  m: MovieListItem,
  onPlay: (m: MovieListItem) => void,
  onMore: () => void,
): HeroItem {
  const badges: HeroBadge[] = [
    { label: "🎬 Movie", variant: "movie" },
  ];
  if (m.year) badges.push({ label: String(m.year), variant: "year" });
  if (m.language)
    badges.push({ label: m.language.toUpperCase(), variant: "lang" });
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
  return {
    id: `m-${m.id}`,
    title: m.name,
    poster: m.cover_big ?? m.stream_icon,
    // Prefer the wide TMDB backdrop; fall back to the portrait cover so
    // movies missing TMDB enrichment still cover the full hero.
    backdrop: m.backdrop_path ?? m.cover_big ?? m.stream_icon,
    gradient: getGradient(m.name),
    accent: getAccent(m.name),
    badges,
    genres: m.genres,
    plot: null,
    primaryAction: { label: "▶ Play Now", onClick: () => onPlay(m) },
    secondaryAction: { label: "ℹ More Info", onClick: onMore },
  };
}

function seriesToHero(
  s: SeriesListItem,
  onPlay: (s: SeriesListItem) => void,
  onMore: () => void,
): HeroItem {
  const badges: HeroBadge[] = [
    { label: "📺 Series", variant: "series" },
  ];
  const yearStr = s.release_date ? String(s.release_date).slice(0, 4) : null;
  if (yearStr) badges.push({ label: yearStr, variant: "year" });
  if (s.language)
    badges.push({ label: s.language.toUpperCase(), variant: "lang" });
  if (s.rating_5based != null) {
    badges.push({
      label: `⭐ ${s.rating_5based.toFixed(1)}`,
      variant: "rating",
    });
  }
  return {
    id: `s-${s.id}`,
    title: s.name,
    poster: s.cover,
    // Same fallback as movieToHero — keep the hero covered when the
    // series doesn't have a wide TMDB backdrop yet.
    backdrop: s.backdrop_path ?? s.cover,
    gradient: getGradient(s.name),
    accent: getAccent(s.name),
    badges,
    genres: s.genres,
    plot: null,
    primaryAction: { label: "▶ Play Now", onClick: () => onPlay(s) },
    secondaryAction: { label: "ℹ More Info", onClick: onMore },
  };
}

// ---------------------------------------------------------------------------
// Hero pool builder — interleave good-rated movies and series, evenly spaced
// ---------------------------------------------------------------------------

function buildHeroPool(
  movies: MovieListItem[],
  series: SeriesListItem[],
  onPlay: (kind: "movie" | "series", item: MovieListItem | SeriesListItem) => void,
  onMore: (kind: "movie" | "series") => void,
): HeroItem[] {
  const mSlice = movies
    .filter((m) => m.rating_5based == null || m.rating_5based >= 3.25)
    .slice(0, 15);
  const sSlice = series.slice(0, 10);
  const interleaved: HeroItem[] = [];
  const len = Math.max(mSlice.length, sSlice.length);
  for (let i = 0; i < len; i++) {
    if (mSlice[i])
      interleaved.push(
        movieToHero(
          mSlice[i],
          (m) => onPlay("movie", m),
          () => onMore("movie"),
        ),
      );
    if (sSlice[i])
      interleaved.push(
        seriesToHero(
          sSlice[i],
          (s) => onPlay("series", s),
          () => onMore("series"),
        ),
      );
  }
  const out: HeroItem[] = [];
  const step = Math.max(1, Math.floor(interleaved.length / 8));
  for (let i = 0; i < interleaved.length && out.length < 8; i += step) {
    out.push(interleaved[i]);
  }
  if (out.length > 0) return out;
  // Fallback: first 6 movies as hero items.
  return movies
    .slice(0, 6)
    .map((m) =>
      movieToHero(
        m,
        (mm) => onPlay("movie", mm),
        () => onMore("movie"),
      ),
    );
}

// ---------------------------------------------------------------------------
// Row shape consumed by ContentRow
// ---------------------------------------------------------------------------

interface HomeRow {
  id: string;
  /** Inline icon rendered before the label — keeps row headers visually
   *  consistent without relying on emoji sprites that look dated. */
  icon: JSX.Element;
  label: string;
  /**
   *   movie         — every card is a MovieListItem, opens player.
   *   series        — every card is a SeriesListItem, navigates to detail.
   *   continue      — mixed; per-item dispatch via the carried
   *                   PlaybackEntry (movie → player, series → detail).
   *   watchlist     — mixed; same per-item dispatch model as continue
   *                   but sourced from the watchlist store.
   *   recommended   — mixed MovieListItem + SeriesListItem from the
   *                   recommendations endpoint; per-item dispatch by
   *                   item.type.
   */
  variant: "movie" | "series" | "continue" | "watchlist" | "recommended";
  items: CardItem[];
  showMore?: () => void;
  raw: (
    | MovieListItem
    | SeriesListItem
    | ContinueItem
    | WatchlistItem
    | RecommendedItem
  )[];
}

/** Recommendations are served as separate movie/series arrays; we
 *  interleave them in the row and tag each entry with its kind so the
 *  click dispatcher knows whether to open the player or navigate to
 *  series detail without sniffing fields. */
interface RecommendedItem {
  kind: "movie" | "series";
  movie?: MovieListItem;
  series?: SeriesListItem;
}

/** Map a Continue-Watching entry to a CardItem so the existing
 *  Movie/Series media cards render it (progress bar comes for free
 *  via the __progressPct / __resumeSec fields piggy-backed by
 *  playbackStore.getContinueWatchingItems). */
function continueToCard(entry: ContinueItem): CardItem {
  return {
    id: entry.id ?? entry.key,
    title: entry.name,
    name: entry.name,
    poster: entry.logo,
    backdrop: entry.backdrop,
    year: entry.year,
    genres: entry.genres,
    type: entry.type === "series" ? "series" : "movie",
    __progressPct: entry.__progressPct ?? undefined,
    __resumeSec: entry.__resumeSec,
    __durationSec: entry.__durationSec,
  };
}

/** Interleave recommendation movies + series into a parallel
 *  (cards, raw) pair. The raw entries are tagged with their kind so
 *  resolveAndPlay can dispatch without re-sniffing field shapes. */
function buildRecommendedRow(
  movies: MovieListItem[],
  series: SeriesListItem[],
): { cards: CardItem[]; raw: RecommendedItem[] } {
  const cards: CardItem[] = [];
  const raw: RecommendedItem[] = [];
  const len = Math.max(movies.length, series.length);
  for (let i = 0; i < len; i++) {
    if (movies[i]) {
      cards.push(movieToCard(movies[i]));
      raw.push({ kind: "movie", movie: movies[i] });
    }
    if (series[i]) {
      cards.push(seriesToCard(series[i]));
      raw.push({ kind: "series", series: series[i] });
    }
  }
  return { cards, raw };
}

/** Map a watchlist entry to a CardItem. No progress overlay here —
 *  the watchlist is a "saved for later" surface, the progress bar
 *  belongs to Continue Watching. */
function watchlistToCard(entry: WatchlistItem): CardItem {
  return {
    id: entry.id ?? entry.key,
    title: entry.title || entry.name,
    name: entry.name || entry.title,
    poster: entry.logo,
    backdrop: entry.backdrop,
    year: entry.year,
    genres: entry.genres,
    type: entry.type,
  };
}

/**
 * Resolve the user's saved category preferences (set in Profile →
 * Preferences) into the comma-separated string the backend's
 * `category_id` query accepts.
 *   null  → no restriction (don't pass category_id)
 *   ""    → user explicitly deselected everything (caller bails)
 *   "1,2,3" → filter to these categories
 */
function resolveCategoryIdsParam(
  kind: "movies" | "series",
): string | null | "" {
  const pref = getContentPrefs()[kind];
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
// Main component
// ---------------------------------------------------------------------------

export default function Home(): JSX.Element {
  const navigate = useNavigate();
  const { isScopeOwner } = useNavigationScope("page:home", { priority: 30 });

  // Snapshot prefs at mount: the home rails fetch once, so we apply
  // whatever the user had saved last time they visited Profile. If
  // they change prefs and bounce back to Home, the route remounts and
  // re-fetches with the new categories.
  const movieCat = resolveCategoryIdsParam("movies");
  const seriesCat = resolveCategoryIdsParam("series");
  const moviesEmpty = movieCat === "";
  const seriesEmpty = seriesCat === "";

  const [latestMovies] = createResource(() => {
    if (moviesEmpty) return Promise.resolve([] as MovieListItem[]);
    return listMovies({
      sort: "added_desc",
      per_page: 20,
      category_id: movieCat ?? undefined,
    })
      .then((p) => p.items)
      .catch(() => [] as MovieListItem[]);
  });
  const [topMovies] = createResource(() => {
    if (moviesEmpty) return Promise.resolve([] as MovieListItem[]);
    return listMovies({
      sort: "rating_desc",
      per_page: 20,
      category_id: movieCat ?? undefined,
    })
      .then((p) => p.items)
      .catch(() => [] as MovieListItem[]);
  });
  const [latestSeries] = createResource(() => {
    if (seriesEmpty) return Promise.resolve([] as SeriesListItem[]);
    return listSeries({
      sort: "last_modified_desc",
      per_page: 20,
      category_id: seriesCat ?? undefined,
    })
      .then((p) => p.items)
      .catch(() => [] as SeriesListItem[]);
  });

  // ---------------------------------------------------------------------------
  // Recommendations
  // ---------------------------------------------------------------------------
  // Fetch once on mount when the user has any completed-history seeds.
  // The endpoint is server-driven (TMDB-similar + genre overlap), so a
  // single call gives us a ranked mixed-type list. We re-query if the
  // user finishes new content during this session — the source signal
  // is `historyState()`.

  const recommendationSource = createMemo(() => {
    const seeds = listHistory()
      .slice(0, 5)
      .filter((h) => h.tmdb_id != null || (h.genres && h.genres.length > 0))
      .map((h) => ({
        type: h.type,
        tmdb_id: h.tmdb_id != null ? Number(h.tmdb_id) : null,
        genres: h.genres,
      }));
    if (seeds.length === 0) return null;

    // Suppress what the user has already saved or is in the middle of
    // watching — recommending those would feel redundant.
    const excludeMovieIds = new Set<number>();
    const excludeSeriesIds = new Set<number>();
    for (const w of listWatchlist()) {
      const id = Number(w.id);
      if (!Number.isFinite(id)) continue;
      (w.type === "series" ? excludeSeriesIds : excludeMovieIds).add(id);
    }
    for (const c of getContinueWatchingItems(50)) {
      const id = Number(c.id);
      if (!Number.isFinite(id)) continue;
      (c.type === "series" ? excludeSeriesIds : excludeMovieIds).add(id);
    }
    // Translate the home-rails preference snapshots into the request
    // shape the recommendations endpoint understands. Same semantics:
    //   null  ("no restriction")     → omit the field
    //   ""    ("empty deselection")  → []  (skip the pool)
    //   "1,2" ("restrict")           → [1, 2]
    const toIdList = (raw: string | null | ""): number[] | undefined => {
      if (raw === null) return undefined;
      if (raw === "") return [];
      return raw
        .split(",")
        .map((t) => Number(t.trim()))
        .filter((n) => Number.isFinite(n));
    };
    return {
      seeds,
      limit: 20,
      exclude_movie_ids: [...excludeMovieIds],
      exclude_series_ids: [...excludeSeriesIds],
      movie_category_ids: toIdList(movieCat),
      series_category_ids: toIdList(seriesCat),
    };
  });

  const [recommended] = createResource(recommendationSource, (req) =>
    getRecommendations(req).catch(() => ({ movies: [], series: [] })),
  );

  const [heroIndex, setHeroIndex] = createSignal(0);
  const [heroAnimKey, setHeroAnimKey] = createSignal(0);
  const [focusedRow, setFocusedRow] = createSignal(-1);
  const [focusedCols, setFocusedCols] = createSignal<Record<number, number>>(
    {},
  );
  const [playError, setPlayError] = createSignal<string | null>(null);

  const loading = () =>
    latestMovies.loading || topMovies.loading || latestSeries.loading;
  const loadError = () =>
    latestMovies.error || topMovies.error || latestSeries.error;

  const resolveAndPlay = (
    kind: "movie" | "series" | "continue" | "watchlist" | "recommended",
    item:
      | MovieListItem
      | SeriesListItem
      | ContinueItem
      | WatchlistItem
      | RecommendedItem,
  ) => {
    if (kind === "recommended") {
      const wrap = item as RecommendedItem;
      if (wrap.kind === "series" && wrap.series) {
        navigate(`/series/${wrap.series.id}`);
      } else if (wrap.kind === "movie" && wrap.movie) {
        openPlayer({ kind: "movie", movie: wrap.movie });
      }
      return;
    }
    if (kind === "watchlist") {
      const entry = item as WatchlistItem;
      if (entry.type === "series") {
        const sid = Number(entry.id);
        if (Number.isFinite(sid)) navigate(`/series/${sid}`);
        return;
      }
      const mid = Number(entry.id);
      if (!Number.isFinite(mid)) return;
      openPlayer({
        kind: "movie",
        movie: {
          id: mid,
          name: entry.name || entry.title,
          year: typeof entry.year === "number" ? entry.year : null,
          language: entry.language,
          rating_5based:
            typeof entry.rating === "number" ? entry.rating : null,
          cover_big: entry.logo,
          stream_icon: entry.logo,
          backdrop_path: entry.backdrop,
          tmdb_id:
            entry.tmdb_id != null ? Number(entry.tmdb_id) : null,
          o_language: null,
          tmdb_vote_average: null,
          tmdb_popularity: null,
          duration_secs: null,
          added: null,
          genres: entry.genres,
        } as MovieListItem,
      });
      return;
    }
    if (kind === "continue") {
      const entry = item as ContinueItem;
      if (entry.type === "movie") {
        // Reconstruct enough of MovieListItem for the player's
        // playMovie call — only `id` is hard-required by the play
        // endpoint; the rest improves the player's title/poster.
        const movieId = Number(entry.id);
        if (!Number.isFinite(movieId)) return;
        openPlayer({
          kind: "movie",
          movie: {
            id: movieId,
            name: entry.name,
            year: typeof entry.year === "number" ? entry.year : null,
            language: null,
            rating_5based: null,
            cover_big: entry.logo,
            stream_icon: entry.logo,
            backdrop_path: entry.backdrop,
            tmdb_id:
              entry.tmdb_id != null ? Number(entry.tmdb_id) : null,
            o_language: null,
            tmdb_vote_average: null,
            tmdb_popularity: null,
            duration_secs: null,
            added: null,
            genres: entry.genres,
          } as MovieListItem,
        });
      } else if (entry._ottSeriesId != null) {
        // Navigate to the series detail page; the SeriesDetail
        // popup auto-resumes via getResumePositionSec when the user
        // hits Play on the same season+episode.
        navigate(`/series/${entry._ottSeriesId}`);
      }
      return;
    }
    if (kind === "movie") {
      openPlayer({ kind: "movie", movie: item as MovieListItem });
    } else {
      // Series → open the dedicated detail page where the user picks
      // an episode (auto-play first episode would skip the season tabs
      // the legacy SeriesDetail relies on for resume).
      navigate(`/series/${(item as SeriesListItem).id}`);
    }
  };

  const goMore = (kind: "movie" | "series") => {
    navigate(kind === "movie" ? "/movies" : "/series");
  };

  const heroItems = createMemo<HeroItem[]>(() =>
    buildHeroPool(
      latestMovies() ?? [],
      latestSeries() ?? [],
      resolveAndPlay,
      goMore,
    ),
  );

  const rows = createMemo<HomeRow[]>(() => {
    // Read playbackState() / watchlistState() / historyState() for
    // reactive tracking — store updates trigger a re-render of this
    // memo, so user-sourced rows (Continue Watching, My Watchlist,
    // You should like…) reflect adds / removes immediately.
    playbackState();
    watchlistState();
    historyState();
    const r: HomeRow[] = [];
    const lm = latestMovies() ?? [];
    const ls = latestSeries() ?? [];
    const tm = topMovies() ?? [];

    // Adult content is suppressed at write-time; filter defensively too so any
    // legacy/edge entry carrying the flag never shows on the home rail.
    const continueItems = getContinueWatchingItems(20).filter((e) => !e.isAdult);
    if (continueItems.length > 0) {
      r.push({
        id: "continue",
        icon: <ResumeIcon />,
        label: "Continue Watching",
        variant: "continue",
        items: continueItems.map(continueToCard),
        raw: continueItems,
      });
    }

    const watchlistItems = listWatchlist().slice(0, 20);
    if (watchlistItems.length > 0) {
      r.push({
        id: "watchlist",
        icon: <BookmarkIcon />,
        label: "My Watchlist",
        variant: "watchlist",
        items: watchlistItems.map(watchlistToCard),
        raw: watchlistItems,
      });
    }

    const recs = recommended();
    if (recs && (recs.movies.length > 0 || recs.series.length > 0)) {
      const { cards, raw } = buildRecommendedRow(recs.movies, recs.series);
      if (cards.length > 0) {
        r.push({
          id: "recommended",
          icon: <SparkleIcon />,
          label: "You should also like",
          variant: "recommended",
          items: cards,
          raw,
        });
      }
    }

    if (lm.length > 0) {
      r.push({
        id: "latestMovies",
        icon: <FilmIcon />,
        label: "Latest Movies",
        variant: "movie",
        items: lm.slice(0, 20).map(movieToCard),
        showMore: () => navigate("/movies"),
        raw: lm.slice(0, 20),
      });
    }
    if (ls.length > 0) {
      r.push({
        id: "latestSeries",
        icon: <TvIcon />,
        label: "Latest Series",
        variant: "series",
        items: ls.slice(0, 20).map(seriesToCard),
        showMore: () => navigate("/series"),
        raw: ls.slice(0, 20),
      });
    }
    if (tm.length > 0) {
      r.push({
        id: "topMovies",
        icon: <StarIcon />,
        label: "Top Rated Movies",
        variant: "movie",
        items: tm.slice(0, 20).map(movieToCard),
        showMore: () => navigate("/movies"),
        raw: tm.slice(0, 20),
      });
    }
    return r;
  });

  // Hero auto-advance — every 7 seconds, wrapped on length change.
  createEffect(() => {
    const total = heroItems().length;
    if (total === 0) return;
    const id = window.setInterval(() => {
      setHeroIndex((p) => (p + 1) % heroItems().length);
      setHeroAnimKey((k) => k + 1);
    }, 7000);
    onCleanup(() => clearInterval(id));
  });

  const goHero = (next: number) => {
    setHeroIndex(next);
    setHeroAnimKey((k) => k + 1);
  };

  // Keyboard handler — same model as the legacy HomePage.
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;

      const row = focusedRow();
      const cols = focusedCols();
      const heroLen = heroItems().length;
      const rowList = rows();

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedRow((prev) => {
          const next = Math.min(prev + 1, rowList.length - 1);
          setFocusedCols((c) => (next in c ? c : { ...c, [next]: 0 }));
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (row <= 0) {
          setAppShellZone("nav");
        } else {
          setFocusedRow((prev) => Math.max(prev - 1, -1));
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (row === -1) {
          if (heroLen > 0) goHero((heroIndex() - 1 + heroLen) % heroLen);
        } else {
          setFocusedCols((c) => ({
            ...c,
            [row]: Math.max((c[row] ?? 0) - 1, 0),
          }));
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (row === -1) {
          if (heroLen > 0) goHero((heroIndex() + 1) % heroLen);
        } else {
          const max = (rowList[row]?.items.length ?? 1) - 1;
          setFocusedCols((c) => ({
            ...c,
            [row]: Math.min((c[row] ?? 0) + 1, max),
          }));
        }
      } else if (isSelectKey(e.key)) {
        e.preventDefault();
        if (row === -1) {
          // Hero CTA fires its own onClick.
        } else {
          const r = rowList[row];
          const item = r?.raw[cols[row] ?? 0];
          if (item && r) resolveAndPlay(r.variant, item);
        }
      } else if (isBackKey(e.key)) {
        e.preventDefault();
        if (row >= 0) {
          setFocusedRow(-1);
        } else {
          setAppShellZone("nav");
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  return (
    <Show
      when={!loading()}
      fallback={
        <div class="home-page">
          <div class="hp-loading">
            <div class="hp-spinner" />
          </div>
        </div>
      }
    >
      <Show
        when={!loadError()}
        fallback={
          <div class="home-page">
            <div class="hp-error">
              <p>⚠ Failed to load content</p>
              <small>{String(loadError())}</small>
            </div>
          </div>
        }
      >
        <div class="home-page">
          <Show when={heroItems().length > 0}>
            <HeroCarousel
              items={heroItems()}
              activeIndex={heroIndex()}
              animKey={heroAnimKey()}
              onNavigate={goHero}
              focused={focusedRow() === -1}
            />
          </Show>

          <div class="hp-rows">
            <For each={rows()}>
              {(row, rowIndex) => (
                <ContentRow
                  row={row}
                  isFocusedRow={focusedRow() === rowIndex()}
                  focusedCol={focusedCols()[rowIndex()] ?? 0}
                  onPlay={(item) => resolveAndPlay(row.variant, item)}
                />
              )}
            </For>
          </div>

          <div class="hp-footer-spacer" />

          <Show when={playError()}>
            <div class="hp-play-toast" onClick={() => setPlayError(null)}>
              <span class="hp-play-toast-icon">⚠</span>
              <span class="hp-play-toast-msg">{playError()}</span>
              <button class="hp-play-toast-close">✕</button>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// ContentRow — single horizontal track of cards
// ---------------------------------------------------------------------------

function ContentRow(props: {
  row: HomeRow;
  isFocusedRow: boolean;
  focusedCol: number;
  onPlay: (
    item:
      | MovieListItem
      | SeriesListItem
      | ContinueItem
      | WatchlistItem
      | RecommendedItem,
  ) => void;
}): JSX.Element {
  let trackRef: HTMLDivElement | undefined;
  let rowRef: HTMLDivElement | undefined;

  // Scroll the focused card into view when col / row-focus changes.
  createEffect(() => {
    if (!props.isFocusedRow || !trackRef) return;
    const child = trackRef.children[props.focusedCol] as
      | HTMLElement
      | undefined;
    child?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  });

  // Scroll the entire row into view when it gains focus.
  createEffect(() => {
    if (props.isFocusedRow && rowRef) {
      rowRef.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  return (
    <div
      ref={(el) => (rowRef = el)}
      class={`hp-row hp-row--${props.row.variant}${
        props.isFocusedRow ? " row-focused" : ""
      }`}
    >
      <div class="hp-row-header">
        <h2 class="hp-row-title">
          <span class="hp-row-title-icon">{props.row.icon}</span>
          {props.row.label}
        </h2>
        <Show when={props.row.showMore}>
          <button class="hp-row-more" onClick={props.row.showMore}>
            See all <span class="hp-row-more-arrow">›</span>
          </button>
        </Show>
      </div>
      <div class="hp-row-scroll">
        <div class="hp-row-track" ref={(el) => (trackRef = el)}>
          <For each={props.row.items}>
            {(item, colIndex) => {
              const focused = () =>
                props.isFocusedRow && props.focusedCol === colIndex();
              // Pick a card silhouette per-item: pure rows use the row
              // variant, but Continue Watching / Watchlist mix movie +
              // series so we read item.type. Series posters are 2:3
              // portrait, movies are 16:9 landscape — using the right
              // one keeps the row visually coherent with the rest of
              // Home.
              const cardKind = (): "movie" | "series" =>
                props.row.variant === "series"
                  ? "series"
                  : props.row.variant === "movie"
                    ? "movie"
                    : item.type === "series"
                      ? "series"
                      : "movie";
              return (
                <Show
                  when={cardKind() === "series"}
                  fallback={
                    <MovieMediaCard
                      item={item}
                      focused={focused()}
                      onClick={() => {
                        const raw = props.row.raw[colIndex()];
                        if (raw) props.onPlay(raw);
                      }}
                    />
                  }
                >
                  <SeriesMediaCard
                    item={item}
                    focused={focused()}
                    onClick={() => {
                      const raw = props.row.raw[colIndex()];
                      if (raw) props.onPlay(raw);
                    }}
                  />
                </Show>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
