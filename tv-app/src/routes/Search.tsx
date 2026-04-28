/**
 * Search — global search with on-screen keyboard + grouped results.
 *
 * Faithful Solid port of `tv_app_v2/src/pages/SearchPage.jsx` (734
 * LOC). Two-pane layout: left aside (query input + 4-row on-screen
 * keyboard + predictions list), right panel (3 result groups: Live /
 * Movies / Series, each a 3-col grid). 6 keyboard zones (header /
 * keyboard / suggestions / live / movies / series) wired into the
 * scope-stack model.
 *
 * Backend mapping: the legacy /api/v1/search-global single-call
 * endpoint isn't part of our backend — we fan out to searchMovies /
 * searchSeries / searchLive in parallel and assemble predictions
 * client-side from the merged result titles (same fallback pattern
 * the legacy used when global search failed).
 *
 * Card-click routing (matches the user's per-type UX preference):
 *   movie  → opens MovieDetailModal in-place
 *   series → navigate to /series/:id (dedicated detail page)
 *   live   → navigate to /live (channel auto-play needs MediaPlayer +
 *           a way to pass a selected channel; for now we just route
 *           to the page so the user can find it manually)
 */

import {
  createSignal,
  createMemo,
  createEffect,
  createRoot,
  on,
  onCleanup,
  Show,
  For,
  type JSX,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { searchMovies, searchSeries, searchLive } from "../api/catalog";
import type {
  LiveStreamItem,
  MovieListItem,
  SeriesListItem,
} from "../api/types";
import { useNavigationScope } from "../lib/navigation";
import { setAppShellZone } from "../stores/shell";
import { isBackKey } from "../lib/navigationKeys";
import LiveMediaCard from "../components/LiveMediaCard";
import MovieMediaCard from "../components/MovieMediaCard";
import SeriesMediaCard from "../components/SeriesMediaCard";
import MovieDetailModal from "../components/MovieDetailModal";
import { type CardItem } from "../components/cardItem";
import { openPlayer } from "../stores/player";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type Zone =
  | "queryHeader"
  | "keyboardGrid"
  | "suggestionsList"
  | "liveGroup"
  | "moviesGroup"
  | "seriesGroup";

type GroupZone = "liveGroup" | "moviesGroup" | "seriesGroup";
type GroupType = "live" | "movies" | "series";

const GROUP_TO_TYPE: Record<GroupZone, GroupType> = {
  liveGroup: "live",
  moviesGroup: "movies",
  seriesGroup: "series",
};

const RESULT_COLS = 3;
const DEBOUNCE_MS = 250;

const KEYBOARD_ROWS: string[][] = [
  ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L", "BACKSPACE"],
  ["Z", "X", "C", "V", "B", "N", "M", "SPACE", "CLEAR", "SEARCH"],
];

interface KeyboardKey {
  key: string;
  rowIndex: number;
  colIndex: number;
}

const KEYBOARD_KEYS: KeyboardKey[] = KEYBOARD_ROWS.flatMap((row, rowIndex) =>
  row.map((key, colIndex) => ({ key, rowIndex, colIndex })),
);

const KEYBOARD_ROW_STARTS: number[] = (() => {
  const starts: number[] = [];
  let i = 0;
  for (const row of KEYBOARD_ROWS) {
    starts.push(i);
    i += row.length;
  }
  return starts;
})();

const KEYBOARD_ROW_LENGTHS: number[] = KEYBOARD_ROWS.map((r) => r.length);

// ---------------------------------------------------------------------------
// Result item shape (post-normalization)
// ---------------------------------------------------------------------------

interface SearchResult {
  id: string;
  type: GroupType;
  title: string;
  poster: string | null;
  subtitle: string | null;
  year: string | null;
  rating: number | null;
  /** The raw typed item — needed for navigation / modal opening. */
  raw: LiveStreamItem | MovieListItem | SeriesListItem;
  relevanceScore: number;
}

interface ResultGroups {
  live: SearchResult[];
  movies: SearchResult[];
  series: SearchResult[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreMatch(title: string | null | undefined, q: string): number {
  const name = String(title || "").toLowerCase();
  const query = q.toLowerCase().trim();
  if (!name || !query) return 0;
  if (name === query) return 1;
  if (name.startsWith(query)) return 0.9;
  if (name.includes(` ${query}`)) return 0.75;
  if (name.includes(query)) return 0.6;
  return 0;
}

function normalizeMovie(m: MovieListItem, q: string): SearchResult {
  return {
    id: `movie-${m.id}`,
    type: "movies",
    title: m.name,
    poster: m.cover_big ?? m.stream_icon,
    subtitle: m.language,
    year: m.year != null ? String(m.year) : null,
    rating: m.rating_5based,
    raw: m,
    relevanceScore: scoreMatch(m.name, q),
  };
}

function normalizeSeries(s: SeriesListItem, q: string): SearchResult {
  return {
    id: `series-${s.id}`,
    type: "series",
    title: s.name,
    poster: s.cover,
    subtitle: s.language,
    year: s.release_date ? String(s.release_date).slice(0, 4) : null,
    rating: s.rating_5based,
    raw: s,
    relevanceScore: scoreMatch(s.name, q),
  };
}

function normalizeLive(l: LiveStreamItem, q: string): SearchResult {
  return {
    id: `live-${l.id}`,
    type: "live",
    title: l.name,
    poster: l.stream_icon,
    subtitle: "Live channel",
    year: null,
    rating: null,
    raw: l,
    relevanceScore: scoreMatch(l.name, q),
  };
}

function buildPredictionsFromGroups(groups: ResultGroups): string[] {
  const pool = [...groups.live, ...groups.movies, ...groups.series].sort(
    (a, b) => b.relevanceScore - a.relevanceScore,
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of pool) {
    const key = item.title.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.title);
    if (out.length >= 8) break;
  }
  return out;
}

function resultToCardItem(r: SearchResult): CardItem {
  return {
    id: r.raw.id,
    title: r.title,
    name: r.title,
    poster: r.poster,
    backdrop: (r.raw as MovieListItem).backdrop_path ?? null,
    rating: r.rating,
    language: r.subtitle,
    year: r.year,
    type: r.type === "movies" ? "movie" : r.type,
    genres: r.subtitle ? [r.subtitle] : [],
  };
}

// ---------------------------------------------------------------------------
// Persistent search state
// ---------------------------------------------------------------------------
//
// These signals live at module scope (inside a createRoot for owner
// hygiene) so the user's query + last result set survive a route
// remount. The driving case: navigate from a series result to
// /series/:id, hit Back, and land back on Search with the input still
// populated and the cards still in place. Component-local signals
// would reset to empty on remount.
//
// Trade-off: cached results may be stale if the user comes back much
// later, but the debounced effect re-runs on mount with the persisted
// query so a fresh fetch lands a moment after the cached results
// flash in. Net UX is "instant restore + background refresh", which
// is what the user expects from search-state continuity.

const persisted = createRoot(() => {
  const [query, setQuery] = createSignal("");
  const [predictions, setPredictions] = createSignal<string[]>([]);
  const [groups, setGroups] = createSignal<ResultGroups>({
    live: [],
    movies: [],
    series: [],
  });
  return { query, setQuery, predictions, setPredictions, groups, setGroups };
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Search(): JSX.Element {
  const navigate = useNavigate();
  const { isScopeOwner } = useNavigationScope("page:search", {
    active: true,
    priority: 90,
  });

  const { query, setQuery, predictions, setPredictions, groups, setGroups } =
    persisted;
  const [loading, setLoading] = createSignal(false);

  const [zone, setZone] = createSignal<Zone>("queryHeader");
  const [lastSidebarZone, setLastSidebarZone] = createSignal<
    "keyboardGrid" | "suggestionsList"
  >("keyboardGrid");
  const [focusedKbdIdx, setFocusedKbdIdx] = createSignal(0);
  const [focusedSuggestionIdx, setFocusedSuggestionIdx] = createSignal(0);
  const [focusedGroupIdx, setFocusedGroupIdx] = createSignal<
    Record<GroupZone, number>
  >({
    liveGroup: 0,
    moviesGroup: 0,
    seriesGroup: 0,
  });

  // Selected movie for the in-place detail modal
  const [selectedMovie, setSelectedMovie] = createSignal<MovieListItem | null>(
    null,
  );

  const suggestionItemRefs: (HTMLElement | null)[] = [];
  const groupSectionRefs: Record<GroupZone, HTMLElement | null> = {
    liveGroup: null,
    moviesGroup: null,
    seriesGroup: null,
  };
  const groupItemRefs: Record<GroupZone, (HTMLElement | null)[]> = {
    liveGroup: [],
    moviesGroup: [],
    seriesGroup: [],
  };

  let inputRef: HTMLInputElement | undefined;

  const activeGroupZones = createMemo<GroupZone[]>(() => {
    const out: GroupZone[] = [];
    const g = groups();
    if (g.live.length > 0) out.push("liveGroup");
    if (g.movies.length > 0) out.push("moviesGroup");
    if (g.series.length > 0) out.push("seriesGroup");
    return out;
  });

  // ── Search execution (debounced) ────────────────────────────────────
  const runSearch = async (q: string) => {
    try {
      const [movieRes, seriesRes, liveRes] = await Promise.allSettled([
        searchMovies({ q, per_page: 20 }),
        searchSeries({ q, per_page: 20 }),
        searchLive({ q, per_page: 20 }),
      ]);
      const movies =
        movieRes.status === "fulfilled"
          ? movieRes.value.items.map((m) => normalizeMovie(m, q))
          : [];
      const series =
        seriesRes.status === "fulfilled"
          ? seriesRes.value.items.map((s) => normalizeSeries(s, q))
          : [];
      const live =
        liveRes.status === "fulfilled"
          ? liveRes.value.items.map((l) => normalizeLive(l, q))
          : [];
      const next: ResultGroups = { live, movies, series };
      setGroups(next);
      setPredictions(buildPredictionsFromGroups(next));
    } catch {
      setGroups({ live: [], movies: [], series: [] });
      setPredictions([]);
    } finally {
      setLoading(false);
    }
  };

  let debounce: number | null = null;
  createEffect(
    on(query, (q) => {
      if (debounce != null) clearTimeout(debounce);
      const trimmed = q.trim();
      if (!trimmed) {
        setLoading(false);
        setPredictions([]);
        setGroups({ live: [], movies: [], series: [] });
        return;
      }
      setLoading(true);
      debounce = window.setTimeout(() => runSearch(trimmed), DEBOUNCE_MS);
    }),
  );

  // Web input focus follows the header zone (skipped on TV — no soft kbd).
  createEffect(() => {
    if (zone() === "queryHeader") {
      queueMicrotask(() => inputRef?.focus());
    } else {
      inputRef?.blur();
    }
  });

  // Auto-scroll the focused suggestion / focused result card into view
  createEffect(() => {
    if (zone() !== "suggestionsList") return;
    const idx = focusedSuggestionIdx();
    queueMicrotask(() =>
      suggestionItemRefs[idx]?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      }),
    );
  });

  createEffect(() => {
    const z = zone();
    if (z !== "liveGroup" && z !== "moviesGroup" && z !== "seriesGroup") {
      return;
    }
    queueMicrotask(() => {
      groupSectionRefs[z]?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
      const idx = focusedGroupIdx()[z] ?? 0;
      groupItemRefs[z][idx]?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "smooth",
      });
    });
  });

  // ── Helpers used by key handlers ─────────────────────────────────────
  const groupListFor = (z: GroupZone): SearchResult[] =>
    groups()[GROUP_TO_TYPE[z]];

  const moveToFirstResult = (): boolean => {
    const zones = activeGroupZones();
    if (zones.length === 0) return false;
    const first = zones[0];
    setZone(first);
    setFocusedGroupIdx((p) => ({
      ...p,
      [first]: Math.min(
        p[first] ?? 0,
        Math.max(0, groupListFor(first).length - 1),
      ),
    }));
    return true;
  };

  const handleActivateItem = (item: SearchResult) => {
    if (item.type === "movies") {
      setSelectedMovie(item.raw as MovieListItem);
    } else if (item.type === "series") {
      navigate(`/series/${item.raw.id}`);
    } else {
      openPlayer({ kind: "live", channel: item.raw as LiveStreamItem });
    }
  };

  const applyPrediction = (value: string) => {
    if (!value) return;
    setQuery(value);
    setFocusedSuggestionIdx(0);
    window.setTimeout(() => {
      if (!moveToFirstResult()) {
        setZone("suggestionsList");
      }
    }, 120);
  };

  const applyKeyboardKey = (kbd: string) => {
    if (kbd === "SPACE") {
      setQuery((p) => `${p} `);
      return;
    }
    if (kbd === "BACKSPACE") {
      setQuery((p) => p.slice(0, -1));
      return;
    }
    if (kbd === "CLEAR") {
      setQuery("");
      setPredictions([]);
      setGroups({ live: [], movies: [], series: [] });
      return;
    }
    if (kbd === "SEARCH") {
      const q = query().trim();
      if (!q) return;
      if (debounce != null) clearTimeout(debounce);
      setLoading(true);
      runSearch(q).then(() => {
        if (!moveToFirstResult()) setZone("suggestionsList");
      });
      return;
    }
    setQuery((p) => `${p}${kbd.toLowerCase()}`);
  };

  const moveKeyboardFocus = (
    direction: "left" | "right" | "up" | "down",
  ) => {
    const cur = focusedKbdIdx();
    const meta = KEYBOARD_KEYS[cur];
    if (!meta) return;
    const { rowIndex, colIndex } = meta;
    if (direction === "left") {
      setFocusedKbdIdx(
        Math.max(cur - 1, KEYBOARD_ROW_STARTS[rowIndex]),
      );
      return;
    }
    if (direction === "right") {
      const rowEnd =
        KEYBOARD_ROW_STARTS[rowIndex] + KEYBOARD_ROW_LENGTHS[rowIndex] - 1;
      if (cur >= rowEnd) {
        moveToFirstResult();
        return;
      }
      setFocusedKbdIdx(Math.min(cur + 1, rowEnd));
      return;
    }
    if (direction === "up") {
      if (rowIndex === 0) {
        setZone("queryHeader");
        return;
      }
      const targetRow = rowIndex - 1;
      const targetCol = Math.min(
        colIndex,
        KEYBOARD_ROW_LENGTHS[targetRow] - 1,
      );
      setFocusedKbdIdx(KEYBOARD_ROW_STARTS[targetRow] + targetCol);
      return;
    }
    // down
    const targetRow = rowIndex + 1;
    if (targetRow >= KEYBOARD_ROW_LENGTHS.length) {
      if (predictions().length > 0) {
        setLastSidebarZone("suggestionsList");
        setZone("suggestionsList");
      }
      return;
    }
    const targetCol = Math.min(
      colIndex,
      KEYBOARD_ROW_LENGTHS[targetRow] - 1,
    );
    setFocusedKbdIdx(KEYBOARD_ROW_STARTS[targetRow] + targetCol);
  };

  // ── Keyboard handler ────────────────────────────────────────────────
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;
      // Modal owns input when open
      if (selectedMovie()) return;

      const NAV = [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Enter",
      ];
      if (!NAV.includes(e.key) && !isBackKey(e.key)) return;
      e.preventDefault();
      e.stopPropagation();

      if (isBackKey(e.key)) {
        const z = zone();
        if (
          z === "liveGroup" ||
          z === "moviesGroup" ||
          z === "seriesGroup"
        ) {
          setZone(lastSidebarZone());
          return;
        }
        if (z === "suggestionsList") {
          setZone("keyboardGrid");
          setLastSidebarZone("keyboardGrid");
          return;
        }
        // header / keyboard → leave the page
        setAppShellZone("nav");
        return;
      }

      const z = zone();

      if (z === "queryHeader") {
        if (e.key === "ArrowDown") {
          setZone("keyboardGrid");
          setLastSidebarZone("keyboardGrid");
        } else if (e.key === "ArrowRight") {
          moveToFirstResult();
        } else if (e.key === "Enter") {
          setZone("keyboardGrid");
        } else if (e.key === "ArrowUp") {
          setAppShellZone("nav");
        }
        return;
      }

      if (z === "keyboardGrid") {
        if (e.key === "ArrowLeft") moveKeyboardFocus("left");
        else if (e.key === "ArrowRight") moveKeyboardFocus("right");
        else if (e.key === "ArrowUp") moveKeyboardFocus("up");
        else if (e.key === "ArrowDown") moveKeyboardFocus("down");
        else if (e.key === "Enter") {
          const k = KEYBOARD_KEYS[focusedKbdIdx()]?.key;
          if (k) applyKeyboardKey(k);
        }
        return;
      }

      if (z === "suggestionsList") {
        const i = focusedSuggestionIdx();
        if (e.key === "ArrowDown") {
          if (predictions().length > 0) {
            setFocusedSuggestionIdx(
              Math.min(i + 1, predictions().length - 1),
            );
          } else if (activeGroupZones().length > 0) {
            moveToFirstResult();
          }
        } else if (e.key === "ArrowUp") {
          if (i === 0) {
            setZone("keyboardGrid");
            setLastSidebarZone("keyboardGrid");
          } else {
            setFocusedSuggestionIdx(Math.max(i - 1, 0));
          }
        } else if (e.key === "ArrowLeft") {
          setZone("keyboardGrid");
          setLastSidebarZone("keyboardGrid");
        } else if (e.key === "ArrowRight") {
          setLastSidebarZone("suggestionsList");
          moveToFirstResult();
        } else if (e.key === "Enter") {
          const value = predictions()[i];
          if (value) applyPrediction(value);
        }
        return;
      }

      // Group zone (live/movies/series)
      const groupZone = z as GroupZone;
      const list = groupListFor(groupZone);
      const idx = focusedGroupIdx()[groupZone] ?? 0;
      const zones = activeGroupZones();
      const here = zones.indexOf(groupZone);
      const nextGroup = (zones[here + 1] ?? null) as GroupZone | null;
      const prevGroup = (zones[here - 1] ?? null) as GroupZone | null;

      if (e.key === "ArrowRight") {
        setFocusedGroupIdx((p) => ({
          ...p,
          [groupZone]: Math.min(idx + 1, list.length - 1),
        }));
      } else if (e.key === "ArrowLeft") {
        if (idx === 0) {
          setZone(lastSidebarZone());
        } else {
          setFocusedGroupIdx((p) => ({
            ...p,
            [groupZone]: Math.max(idx - 1, 0),
          }));
        }
      } else if (e.key === "ArrowDown") {
        const nextRowIdx = idx + RESULT_COLS;
        if (nextRowIdx < list.length) {
          setFocusedGroupIdx((p) => ({ ...p, [groupZone]: nextRowIdx }));
        } else if (nextGroup) {
          const targetCol = idx % RESULT_COLS;
          const nextLen = groupListFor(nextGroup).length;
          if (nextLen > 0) {
            setZone(nextGroup);
            setFocusedGroupIdx((p) => ({
              ...p,
              [nextGroup]: Math.min(targetCol, nextLen - 1),
            }));
          }
        }
      } else if (e.key === "ArrowUp") {
        const prevRowIdx = idx - RESULT_COLS;
        if (prevRowIdx >= 0) {
          setFocusedGroupIdx((p) => ({ ...p, [groupZone]: prevRowIdx }));
        } else if (prevGroup) {
          const targetCol = idx % RESULT_COLS;
          const prevLen = groupListFor(prevGroup).length;
          if (prevLen > 0) {
            const lastRowStart =
              Math.floor((prevLen - 1) / RESULT_COLS) * RESULT_COLS;
            let targetIdx = lastRowStart + targetCol;
            while (targetIdx >= prevLen && targetIdx - RESULT_COLS >= 0) {
              targetIdx -= RESULT_COLS;
            }
            targetIdx = Math.max(0, Math.min(targetIdx, prevLen - 1));
            setZone(prevGroup);
            setFocusedGroupIdx((p) => ({ ...p, [prevGroup]: targetIdx }));
          }
        } else {
          setZone(lastSidebarZone());
        }
      } else if (e.key === "Enter") {
        if (list[idx]) handleActivateItem(list[idx]);
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  const totalResults = createMemo(
    () =>
      groups().live.length + groups().movies.length + groups().series.length,
  );

  // Render a single result group
  const renderGroup = (
    z: GroupZone,
    label: string,
  ): JSX.Element => {
    const list = () => groupListFor(z);
    const focused = () => focusedGroupIdx()[z] ?? 0;
    const isZone = () => zone() === z;

    return (
      <Show when={list().length > 0}>
        <section
          class="sp2-group"
          ref={(el) => (groupSectionRefs[z] = el)}
        >
          <h2 class="sp2-group-title">{label}</h2>
          <div class="sp2-grid">
            <For each={list()}>
              {(item, i) => {
                const isFocused = () => isZone() && focused() === i();
                const card: CardItem = resultToCardItem(item);
                return (
                  <div
                    class={`sp2-card-wrap${isFocused() ? " focused" : ""}`}
                    ref={(el) => (groupItemRefs[z][i()] = el)}
                  >
                    <Show when={item.type === "live"}>
                      <LiveMediaCard
                        item={card}
                        focused={isFocused()}
                        onClick={() => handleActivateItem(item)}
                      />
                    </Show>
                    <Show when={item.type === "movies"}>
                      <MovieMediaCard
                        item={card}
                        focused={isFocused()}
                        onClick={() => handleActivateItem(item)}
                      />
                    </Show>
                    <Show when={item.type === "series"}>
                      <SeriesMediaCard
                        item={card}
                        focused={isFocused()}
                        onClick={() => handleActivateItem(item)}
                      />
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </section>
      </Show>
    );
  };

  return (
    <div class="sp2-page">
      <aside class="sp2-sidebar">
        <div
          class={`sp2-input-wrap${zone() === "queryHeader" ? " focused" : ""}`}
        >
          <input
            ref={(el) => (inputRef = el)}
            class="sp2-input"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search titles, channels, actors..."
            autocomplete="off"
            onFocus={() => setZone("queryHeader")}
          />
        </div>

        <div
          class={`sp2-kbd${zone() === "keyboardGrid" ? " active" : ""}`}
        >
          <For each={KEYBOARD_KEYS}>
            {(kbd, idx) => {
              const isFocused = () =>
                zone() === "keyboardGrid" && focusedKbdIdx() === idx();
              const label = () =>
                kbd.key === "BACKSPACE"
                  ? "⌫"
                  : kbd.key === "SPACE"
                    ? "␣"
                    : kbd.key === "CLEAR"
                      ? "🧹"
                      : kbd.key === "SEARCH"
                        ? "🔍"
                        : kbd.key;
              return (
                <button
                  class={`sp2-kbd-key sp2-kbd-key--${kbd.key.toLowerCase()}${isFocused() ? " focused" : ""}`}
                  onClick={() => applyKeyboardKey(kbd.key)}
                >
                  {label()}
                </button>
              );
            }}
          </For>
        </div>

        <div
          class={`sp2-predictions${zone() === "suggestionsList" ? " active" : ""}`}
        >
          <Show when={predictions().length === 0}>
            <div class="sp2-suggestions-empty">
              {query().trim() ? "No suggestions yet" : ""}
            </div>
          </Show>
          <For each={predictions()}>
            {(item, idx) => (
              <button
                ref={(el) => (suggestionItemRefs[idx()] = el)}
                class={`sp2-prediction${
                  zone() === "suggestionsList" &&
                  focusedSuggestionIdx() === idx()
                    ? " focused"
                    : ""
                }`}
                onClick={() => applyPrediction(item)}
              >
                {item}
              </button>
            )}
          </For>
        </div>
      </aside>

      <div class="sp2-results-panel">
        <div class="sp2-top">
          <h1 class="sp2-title">Search</h1>
          <p class="sp2-subtitle">Live, movies, and series in one place</p>
        </div>

        <div class="sp2-body">
          <Show when={loading()}>
            <div class="sp2-state">Searching...</div>
          </Show>
          <Show when={!loading() && query().trim() && totalResults() === 0}>
            <div class="sp2-state">No results for "{query()}"</div>
          </Show>

          {renderGroup("liveGroup", "Live")}
          {renderGroup("moviesGroup", "Movies")}
          {renderGroup("seriesGroup", "Series")}
        </div>
      </div>

      <Show when={selectedMovie()}>
        <MovieDetailModal
          movie={selectedMovie()!}
          onClose={() => setSelectedMovie(null)}
          onPlay={() => {
            const m = selectedMovie();
            setSelectedMovie(null);
            if (m) openPlayer({ kind: "movie", movie: m });
          }}
        />
      </Show>
    </div>
  );
}
