/**
 * Per-page sort persistence (movies vs series). Keeps the user's last
 * sort choice across reloads and across pages.
 */

import { createSignal } from "solid-js";
import type { MovieSort, SeriesSort } from "../api/types";

const MOVIE_KEY = "ott_movies_sort_v1";
const SERIES_KEY = "ott_series_sort_v1";

const MOVIE_DEFAULT: MovieSort = "added_desc";
const SERIES_DEFAULT: SeriesSort = "last_modified_desc";

const MOVIE_VALID: MovieSort[] = [
  "year_desc",
  "added_desc",
  "rating_desc",
  "popularity_desc",
  "name_asc",
];
const SERIES_VALID: SeriesSort[] = [
  "last_modified_desc",
  "rating_desc",
  "popularity_desc",
  "name_asc",
];

function loadMovie(): MovieSort {
  try {
    const v = localStorage.getItem(MOVIE_KEY) as MovieSort | null;
    if (v && MOVIE_VALID.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return MOVIE_DEFAULT;
}

function loadSeries(): SeriesSort {
  try {
    const v = localStorage.getItem(SERIES_KEY) as SeriesSort | null;
    if (v && SERIES_VALID.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return SERIES_DEFAULT;
}

const [movieSort, _setMovieSort] = createSignal<MovieSort>(loadMovie());
const [seriesSort, _setSeriesSort] = createSignal<SeriesSort>(loadSeries());

export function setMovieSort(v: MovieSort): void {
  _setMovieSort(v);
  try {
    localStorage.setItem(MOVIE_KEY, v);
  } catch {
    /* ignore */
  }
}

export function setSeriesSort(v: SeriesSort): void {
  _setSeriesSort(v);
  try {
    localStorage.setItem(SERIES_KEY, v);
  } catch {
    /* ignore */
  }
}

export { movieSort, seriesSort };

export const MOVIE_SORT_OPTIONS: { value: MovieSort; label: string }[] = [
  { value: "added_desc", label: "Most Recent" },
  { value: "year_desc", label: "By Release Year" },
  { value: "rating_desc", label: "Top Rated" },
  { value: "popularity_desc", label: "Most Popular" },
  { value: "name_asc", label: "A–Z" },
];

export const SERIES_SORT_OPTIONS: { value: SeriesSort; label: string }[] = [
  { value: "last_modified_desc", label: "Most Recent" },
  { value: "rating_desc", label: "Top Rated" },
  { value: "popularity_desc", label: "Most Popular" },
  { value: "name_asc", label: "A–Z" },
];
