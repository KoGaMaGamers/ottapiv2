/**
 * Backend API DTOs — mirror the pydantic shapes returned by the
 * FastAPI server (see `src/routers/catalog.py`, `src/routers/play.py`,
 * `src/routers/me.py`, `src/routers/subtitles.py`).
 *
 * Hand-maintained for now; if the backend grows, generate from
 * /openapi.json instead of hand-syncing.
 */

// ---------------------------------------------------------------------------
// Pagination wrapper used by listing endpoints
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  has_next: boolean;
}

// ---------------------------------------------------------------------------
// /api/v1/me
// ---------------------------------------------------------------------------

export type ViewMode = "fallback" | "curated";

export interface MeResponse {
  user_id: number;
  username: string;
  provider_id: number;
  provider_name: string | null;
  provider_base_url: string;
  is_populated: boolean;
  view_mode: ViewMode;
  status: string | null;
  is_trial: boolean | null;
  max_connections: number | null;
  subscription_enforced: boolean;
  subscription_exp_date: string | null;
  provider_exp_date: string | null;
  effective_exp_date: string | null;
}

// ---------------------------------------------------------------------------
// Genres + categories
// ---------------------------------------------------------------------------

export interface GenreOut {
  id: number;
  tmdb_genre_id: number | null;
  name: string;
}

export interface LiveCategoryNode {
  id: number;
  name: string;
  category_id: number | null;
  children: LiveCategoryNode[];
}

export interface FlatCategory {
  id: number;
  category_id: number;
  name: string;
  language: string | null;
}

// ---------------------------------------------------------------------------
// Live streams
// ---------------------------------------------------------------------------

export interface LiveStreamItem {
  id: number;
  stream_id: number;
  name: string;
  raw_name: string | null;
  stream_icon: string | null;
  epg_channel_id: string | null;
  category_id: number | null;
  live_category_id: number | null;
  tv_archive: boolean;
  added: string | null;
}

// ---------------------------------------------------------------------------
// Movies — list item & detail
// ---------------------------------------------------------------------------

export interface MovieListItem {
  id: number;
  name: string;
  year: number | null;
  language: string | null;
  rating_5based: number | null;
  cover_big: string | null;
  stream_icon: string | null;
  backdrop_path: string | null;
  tmdb_id: number | null;
  o_language: string | null;
  tmdb_vote_average: number | null;
  tmdb_popularity: number | null;
  duration_secs: number | null;
  added: string | null;
  genres: string[];
}

export interface MovieDetail extends MovieListItem {
  o_name: string | null;
  description: string | null;
  actors: string | null;
  director: string | null;
  country: string | null;
  age_rating: string | null;
  bitrate: number | null;
  status: string | null;
  youtube_trailer: string | null;
  releasedate: string | null;
  duration: string | null;
  video_codec: string | null;
  video_width: number | null;
  video_height: number | null;
  audio_codec: string | null;
  audio_channels: number | null;
  audio_channel_layout: string | null;
  container_extension: string | null;
  category_id: number | null;
  movie_category_id: number | null;
}

export type MovieSort =
  | "added_desc"
  | "added_asc"
  | "year_desc"
  | "year_asc"
  | "rating_desc"
  | "name_asc"
  | "popularity_desc";

// ---------------------------------------------------------------------------
// Series — list item, detail, seasons & episodes
// ---------------------------------------------------------------------------

export interface SeasonOut {
  id: number;
  season_number: number;
  name: string | null;
  overview: string | null;
  air_date: string | null;
  episode_count: number | null;
  cover: string | null;
  cover_big: string | null;
}

export interface SeriesListItem {
  id: number;
  name: string;
  language: string | null;
  rating_5based: number | null;
  cover: string | null;
  backdrop_path: string | null;
  tmdb_id: number | null;
  o_language: string | null;
  tmdb_vote_average: number | null;
  tmdb_popularity: number | null;
  last_modified: string | null;
  release_date: string | null;
  genres: string[];
}

export interface SeriesDetail extends SeriesListItem {
  o_name: string | null;
  plot: string | null;
  cast: string | null;
  director: string | null;
  youtube_trailer: string | null;
  episode_run_time: number | null;
  category_id: number | null;
  series_category_id: number | null;
  seasons: SeasonOut[];
}

export interface EpisodeOut {
  id: number;
  season_number: number;
  episode_num: number;
  title: string | null;
  plot: string | null;
  movie_image: string | null;
  duration_secs: number | null;
  rating: string | null;
  release_date: string | null;
  container_extension: string | null;
  tmdb_id: number | null;
  audio_language: string | null;
  video_codec: string | null;
  video_width: number | null;
  video_height: number | null;
  audio_codec: string | null;
  audio_channels: number | null;
  audio_channel_layout: string | null;
  frame_rate: string | null;
  aspect_ratio: string | null;
  bitrate: number | null;
  crew: string | null;
}

export type SeriesSort =
  | "last_modified_desc"
  | "name_asc"
  | "popularity_desc"
  | "rating_desc";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchType = "movies" | "series" | "live";

// ---------------------------------------------------------------------------
// Play / allocation
// ---------------------------------------------------------------------------

export interface PlayResponse {
  stream_url: string;
  allocation_token: string;
  expires_at: string;
  slot_username: string;
  heartbeat_cadence_sec: number;
}

export interface HeartbeatResponse {
  expires_at: string | null;
  is_streaming: boolean;
}

export type StreamKind = "live" | "movie" | "series";

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

export interface SubtitleEntry {
  id: number;
  tmdb_id: number;
  lang: string;
  label: string;
  season: number;
  episode: number;
  url_vtt: string;
}
