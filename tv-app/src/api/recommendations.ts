/**
 * Recommendations API — wraps `POST /api/v1/recommendations`.
 *
 * Backend takes a list of completed-item seeds (tmdb_id + genres) and
 * returns local-catalog rows scored by TMDB-similar overlap and genre
 * intersection. We never POST anything beyond the seed identity — no
 * playback positions, no timestamps — so the user's history stays on
 * the device.
 */

import { api } from "./client";
import type { MovieListItem, SeriesListItem } from "./types";

export interface RecommendationSeed {
  type: "movie" | "series";
  tmdb_id?: number | null;
  genres?: string[];
}

export interface RecommendationsRequest {
  seeds: RecommendationSeed[];
  limit?: number;
  exclude_movie_ids?: number[];
  exclude_series_ids?: number[];
  /**
   * User's content prefs (Profile → Preferences) for each kind.
   *   undefined — no category restriction
   *   []        — user has deselected every category, skip this kind
   *   [...]     — restrict to these category ids
   */
  movie_category_ids?: number[];
  series_category_ids?: number[];
}

export interface RecommendationsResponse {
  movies: MovieListItem[];
  series: SeriesListItem[];
}

export function getRecommendations(
  body: RecommendationsRequest,
): Promise<RecommendationsResponse> {
  return api.post<RecommendationsResponse>("/api/v1/recommendations", body);
}
