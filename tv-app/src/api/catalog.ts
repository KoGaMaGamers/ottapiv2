import { api } from "./client";
import type {
  EpisodeOut,
  FlatCategory,
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

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function listLiveCategories(): Promise<LiveCategoryNode[]> {
  return api.get<LiveCategoryNode[]>("/api/v1/categories/live");
}

export function listMovieCategories(): Promise<FlatCategory[]> {
  return api.get<FlatCategory[]>("/api/v1/categories/movies");
}

export function listSerieCategories(): Promise<FlatCategory[]> {
  return api.get<FlatCategory[]>("/api/v1/categories/series");
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
  category_id?: number;
  page?: number;
  per_page?: number;
}

export function listLive(opts: LiveListOpts = {}): Promise<Page<LiveStreamItem>> {
  return api.get<Page<LiveStreamItem>>(`/api/v1/live${buildQuery(opts)}`);
}

export interface MovieListOpts {
  category_id?: number;
  language?: string;
  genre_id?: number;
  sort?: MovieSort;
  page?: number;
  per_page?: number;
}

export function listMovies(opts: MovieListOpts = {}): Promise<Page<MovieListItem>> {
  return api.get<Page<MovieListItem>>(`/api/v1/movies${buildQuery(opts)}`);
}

export interface SeriesListOpts {
  category_id?: number;
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
