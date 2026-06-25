import { api } from "./client";
import type {
  EpisodeOut,
  FlatCategory,
  GenreCountOut,
  GenreOut,
  LiveCategoryNode,
  LiveStreamItem,
  MovieDetail,
  MovieListItem,
  MovieSort,
  Page,
  SearchType,
  SeriesDetail,
  SeriesListItem,
  SeriesSort,
} from "./types";

// ---------------------------------------------------------------------------
// Genres
// ---------------------------------------------------------------------------

export function listGenres(): Promise<GenreOut[]> {
  return api.get<GenreOut[]>("/api/v1/genres");
}

/**
 * Per-provider, per-type genre list with item counts. Genres with zero
 * matching streams on the current user's provider are filtered out by
 * the backend, so the response only contains genres the user can
 * actually browse.
 */
export function listMovieGenres(): Promise<GenreCountOut[]> {
  return api.get<GenreCountOut[]>("/api/v1/genres/movies");
}

export function listSeriesGenres(): Promise<GenreCountOut[]> {
  return api.get<GenreCountOut[]>("/api/v1/genres/series");
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

// `adultOnly` returns ONLY adult categories (for the dedicated Adult page).
// The default (omitted/false) excludes them — adult content never appears on
// the regular Live/Movies/Series surfaces.
export function listLiveCategories(adultOnly = false): Promise<LiveCategoryNode[]> {
  return api.get<LiveCategoryNode[]>(`/api/v1/categories/live${adultOnly ? "?adult_only=true" : ""}`);
}

export function listMovieCategories(adultOnly = false): Promise<FlatCategory[]> {
  return api.get<FlatCategory[]>(`/api/v1/categories/movies${adultOnly ? "?adult_only=true" : ""}`);
}

export function listSerieCategories(adultOnly = false): Promise<FlatCategory[]> {
  return api.get<FlatCategory[]>(`/api/v1/categories/series${adultOnly ? "?adult_only=true" : ""}`);
}

// ---------------------------------------------------------------------------
// Listings (paginated)
// ---------------------------------------------------------------------------

function buildQuery(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface LiveListOpts {
  category_id?: number | string;
  /** Return ONLY adult channels (Adult page). Default excludes them. */
  adult_only?: boolean;
  page?: number;
  per_page?: number;
}

export function listLive(opts: LiveListOpts = {}): Promise<Page<LiveStreamItem>> {
  return api.get<Page<LiveStreamItem>>(`/api/v1/live${buildQuery(opts)}`);
}

export interface MovieListOpts {
  /** Single FK id, or list joined as `1,2,3` (backend accepts both). */
  category_id?: number | string;
  language?: string;
  genre_id?: number;
  sort?: MovieSort;
  /** Return ONLY adult movies (Adult page). Default excludes them. */
  adult_only?: boolean;
  page?: number;
  per_page?: number;
}

export function listMovies(opts: MovieListOpts = {}): Promise<Page<MovieListItem>> {
  return api.get<Page<MovieListItem>>(`/api/v1/movies${buildQuery(opts)}`);
}

export interface SeriesListOpts {
  category_id?: number | string;
  language?: string;
  genre_id?: number;
  sort?: SeriesSort;
  page?: number;
  per_page?: number;
}

export function listSeries(opts: SeriesListOpts = {}): Promise<Page<SeriesListItem>> {
  return api.get<Page<SeriesListItem>>(`/api/v1/series${buildQuery(opts)}`);
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function getMovie(id: number): Promise<MovieDetail> {
  return api.get<MovieDetail>(`/api/v1/movies/${id}`);
}

export function getSeries(id: number): Promise<SeriesDetail> {
  return api.get<SeriesDetail>(`/api/v1/series/${id}`);
}

export function getSeasonEpisodes(
  seriesId: number,
  seasonNumber: number,
): Promise<EpisodeOut[]> {
  return api.get<EpisodeOut[]>(
    `/api/v1/series/${seriesId}/seasons/${seasonNumber}/episodes`,
  );
}

// ---------------------------------------------------------------------------
// Search — typed by caller; backend response shape depends on `type`
// ---------------------------------------------------------------------------

export interface SearchOpts {
  q: string;
  type: SearchType;
  page?: number;
  per_page?: number;
}

export function searchMovies(
  opts: Omit<SearchOpts, "type"> & { type?: never },
): Promise<Page<MovieListItem>> {
  return api.get<Page<MovieListItem>>(
    `/api/v1/search${buildQuery({ ...opts, type: "movies" })}`,
  );
}

export function searchSeries(
  opts: Omit<SearchOpts, "type"> & { type?: never },
): Promise<Page<SeriesListItem>> {
  return api.get<Page<SeriesListItem>>(
    `/api/v1/search${buildQuery({ ...opts, type: "series" })}`,
  );
}

export function searchLive(
  opts: Omit<SearchOpts, "type"> & { type?: never },
): Promise<Page<LiveStreamItem>> {
  return api.get<Page<LiveStreamItem>>(
    `/api/v1/search${buildQuery({ ...opts, type: "live" })}`,
  );
}
