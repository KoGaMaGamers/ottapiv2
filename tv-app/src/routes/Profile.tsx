/**
 * Profile — account settings hub
 *
 * Faithful Solid port of `tv_app_v2/src/pages/ProfilePage.jsx` (1213
 * LOC). Same layout (fixed left sidebar + scrollable right panel),
 * same 4 sections (User Info, Preferences, Parental, Sign Out), same
 * spatial-grid keyboard model:
 *
 *   ↑ / ↓     move between visual rows in the 2-D grid[rowIdx][colIdx]
 *   ← / →     move between side-by-side items in the same row
 *             (← at colIdx 0 returns focus to the sidebar)
 *   Enter     activate; on a tab: switch tab AND move down to content
 *   Back/Esc  content panel → sidebar
 *   Sidebar:  ↑/↓ move sections; →/Enter enter content panel
 *
 * Each section defines `grid[rowIdx][colIdx]` so D-pad directions are
 * spatially correct. `data-foc="r-c"` anchors let scrollIntoView find
 * the focused element.
 *
 * Adaptations from the legacy (auth model only):
 *   - Form prefill is empty (we don't store user/pass creds).
 *   - User Info fields absent from MeResponse render as "—".
 */

import {
  createSignal,
  createMemo,
  createEffect,
  on,
  onCleanup,
  Show,
  For,
  type JSX,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { authUser, clearAuth } from "../stores/auth";
import { login as loginApi } from "../api/auth";
import { getMe } from "../api/me";
import {
  listLiveCategories,
  listMovieCategories,
  listSerieCategories,
  listLive,
} from "../api/catalog";
import type { MeResponse, LiveCategoryNode, FlatCategory } from "../api/types";
import {
  getContentPrefs,
  setContentPrefs,
  isAdultCategory,
  getAdultPrefs,
  setAdultPrefs,
  rememberAdultChannelIds,
  type CategoryFilter,
  type ContentPrefsView,
} from "../lib/contentPrefs";
import { useNavigationScope } from "../lib/navigation";
import { setAppShellZone } from "../stores/shell";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PIN_KEY = "ott_parental_pin";
const GRID_COLS = 3; // category grid column count — must match CSS repeat(3,…)

interface NavEntry {
  id: "info" | "prefs" | "parental" | "logout";
  icon: string;
  label: string;
}

const NAV: NavEntry[] = [
  { id: "info", icon: "👤", label: "User Info" },
  { id: "prefs", icon: "☰", label: "Preferences" },
  { id: "parental", icon: "🔒", label: "Parental" },
  { id: "logout", icon: "⏏", label: "Sign Out" },
];

const TAB_KEYS = ["live", "movies", "series"] as const;
type TabKey = (typeof TAB_KEYS)[number];

// ---------------------------------------------------------------------------
// Adapter types — shapes the JSX renders against
// ---------------------------------------------------------------------------

interface ProfileCat {
  id: number;
  parent_id: number | string | null;
  category_name: string;
  name: string;
  language: string | null;
  /**
   * Xtream provider's category_id (separate from our DB FK `id`). Null
   * when the category is synthetic / not directly fetchable from the
   * provider. Mirrors the legacy `c.category_id != null` guard used in
   * adult-channel discovery.
   */
  xtream_category_id: number | null;
}

interface AdultChannel {
  id: number;
  stream_id: number;
  name: string;
}

// Rows inside the grid[rowIdx][colIdx] navigation model.
type GridItem =
  | { id: string; type?: undefined; key?: undefined; catId?: undefined; chId?: undefined }
  | { id: string; type: "input" }
  | { id: string; type: "tab"; key: TabKey }
  | { id: string; type: "cat"; catId: number; ci: number }
  | { id: string; type: "danger" }
  | { id: string; type: "adult-ch"; chId: number; ci: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenLiveTree(roots: LiveCategoryNode[]): ProfileCat[] {
  const out: ProfileCat[] = [];
  for (const root of roots) {
    out.push({
      id: root.id,
      parent_id: 0,
      category_name: root.name,
      name: root.name,
      language: null,
      xtream_category_id: root.category_id,
    });
    for (const child of root.children ?? []) {
      out.push({
        id: child.id,
        parent_id: root.id,
        category_name: child.name,
        name: child.name,
        language: null,
        xtream_category_id: child.category_id,
      });
      // Deeper nesting (rare) — flatten under the root for simplicity.
      for (const grand of child.children ?? []) {
        out.push({
          id: grand.id,
          parent_id: child.id,
          category_name: grand.name,
          name: grand.name,
          language: null,
          xtream_category_id: grand.category_id,
        });
      }
    }
  }
  return out;
}

function flatToProfile(list: FlatCategory[]): ProfileCat[] {
  return list.map((c) => ({
    id: c.id,
    parent_id: 0,
    category_name: c.name,
    name: c.name,
    language: c.language,
    xtream_category_id: c.category_id,
  }));
}

const isLiveRoot = (cat: ProfileCat): boolean =>
  !cat.parent_id || String(cat.parent_id) === "0";

/**
 * Sort a flat live-category list into tree order:
 *   root → its direct children → next root → its children → …
 * Orphans are appended.
 */
function buildLiveTree(flat: ProfileCat[]): ProfileCat[] {
  const roots = flat.filter(isLiveRoot);
  const childMap = new Map<string, ProfileCat[]>();
  for (const cat of flat) {
    if (!isLiveRoot(cat)) {
      const pid = String(cat.parent_id);
      const arr = childMap.get(pid) ?? [];
      arr.push(cat);
      childMap.set(pid, arr);
    }
  }
  const result: ProfileCat[] = [];
  const visited = new Set<string>();
  for (const root of roots) {
    result.push(root);
    visited.add(String(root.id));
    for (const child of childMap.get(String(root.id)) ?? []) {
      result.push(child);
      visited.add(String(child.id));
    }
  }
  for (const cat of flat) {
    if (!visited.has(String(cat.id))) result.push(cat);
  }
  return result;
}

/**
 * Extract a display language tag from a category. VOD/series categories
 * carry `language` directly; live categories often embed the code in
 * the name ("FR - News", "EN | Sports", "[AR] Kids", "PT: Filmes").
 */
function extractLang(cat: ProfileCat): string | null {
  if (cat.language) return String(cat.language).toUpperCase();
  const name = cat.category_name || cat.name || "";
  const m = name.match(/^\[?([A-Za-z]{2,4})\]?[\s\-|:]+/);
  return m ? m[1].toUpperCase() : null;
}

function fmtIsoDate(iso: string | null | undefined): string {
  if (!iso) return "No expiry";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Profile(): JSX.Element {
  const navigate = useNavigate();
  const { isScopeOwner } = useNavigationScope("page:profile", {
    active: true,
    priority: 30,
  });

  // Refs ---------------------------------------------------------------------
  let containerRef: HTMLDivElement | undefined;
  let contentRef: HTMLDivElement | undefined;
  let urlInputRef: HTMLInputElement | undefined;
  let userInputRef: HTMLInputElement | undefined;
  let passInputRef: HTMLInputElement | undefined;
  let pinInputRef: HTMLInputElement | undefined;

  // Spatial focus state ------------------------------------------------------
  const [zone, setZone] = createSignal<"sidebar" | "content">("sidebar");
  const [sideIdx, setSideIdx] = createSignal(0);
  const [rowIdx, setRowIdx] = createSignal(0);
  const [colIdx, setColIdx] = createSignal(0);
  const [inputMode, setInputMode] = createSignal(false);

  // Provider info ------------------------------------------------------------
  const [provData, setProvData] = createSignal<MeResponse | null>(null);
  const [provLoading, setProvLoading] = createSignal(false);
  const [provError, setProvError] = createSignal<string | null>(null);

  // Edit credentials form ----------------------------------------------------
  const [showForm, setShowForm] = createSignal(false);
  const [editUrl, setEditUrl] = createSignal("");
  const [editUser, setEditUser] = createSignal("");
  const [editPass, setEditPass] = createSignal("");
  const [editLoading, setEditLoading] = createSignal(false);
  const [editError, setEditError] = createSignal("");
  const [editSuccess, setEditSuccess] = createSignal(false);

  // Content preferences ------------------------------------------------------
  const [tab, setTab] = createSignal<TabKey>("live");
  const [cats, setCats] = createSignal<{
    live: ProfileCat[] | null;
    movies: ProfileCat[] | null;
    series: ProfileCat[] | null;
  }>({ live: null, movies: null, series: null });
  const [catsLoading, setCatsLoading] = createSignal(false);
  const [prefs, setPrefs] = createSignal<ContentPrefsView>(getContentPrefs());

  // Parental control --------------------------------------------------------
  const [hasPin, setHasPin] = createSignal<boolean>(
    !!localStorage.getItem(PIN_KEY),
  );
  const [pinMode, setPinMode] = createSignal<
    "set" | "change" | "verify" | null
  >(null);
  const [pinStep, setPinStep] = createSignal<"enter" | "confirm" | "verify">(
    "enter",
  );
  const [pinVal, setPinVal] = createSignal("");
  const [pinFirst, setPinFirst] = createSignal("");
  const [pinErr, setPinErr] = createSignal("");
  const [pinOk, setPinOk] = createSignal("");
  const [pinVerified, setPinVerified] = createSignal(false);

  // Adult content channels ---------------------------------------------------
  const [adultChannels, setAdultChannels] = createSignal<
    AdultChannel[] | null
  >(null);
  const [adultChannelsLoading, setAdultChannelsLoading] = createSignal(false);
  const [adultSel, setAdultSel] = createSignal<CategoryFilter>(getAdultPrefs());

  const section = () => NAV[sideIdx()].id;

  // ── Build 2-D navigation grid ────────────────────────────────────────────
  const grid = createMemo<GridItem[][]>(() => {
    switch (section()) {
      case "info": {
        const rows: GridItem[][] = [
          [{ id: "refresh" }, { id: "edit-creds" }],
        ];
        if (showForm()) {
          rows.push(
            [{ id: "url-f", type: "input" }],
            [{ id: "user-f", type: "input" }],
            [{ id: "pass-f", type: "input" }],
            [{ id: "save" }, { id: "cancel" }],
          );
        }
        return rows;
      }

      case "prefs": {
        const all = cats()[tab()] ?? [];
        const rawList =
          tab() === "live" ? all.filter((c) => !isAdultCategory(c)) : all;
        const catList = tab() === "live" ? buildLiveTree(rawList) : rawList;
        const cols = tab() === "live" ? 1 : GRID_COLS;
        const catRows: GridItem[][] = [];
        for (let r = 0; r * cols < catList.length; r++) {
          catRows.push(
            catList
              .slice(r * cols, (r + 1) * cols)
              .map<GridItem>((c, ci) => ({
                id: `c-${c.id}`,
                type: "cat",
                catId: c.id,
                ci: r * cols + ci,
              })),
          );
        }
        return [
          [
            { id: "tab-live", type: "tab", key: "live" },
            { id: "tab-movies", type: "tab", key: "movies" },
            { id: "tab-series", type: "tab", key: "series" },
          ],
          [{ id: "sel-all" }, { id: "desel-all" }],
          ...catRows,
        ];
      }

      case "parental": {
        if (pinMode()) {
          return [
            [{ id: "pin-i", type: "input" }],
            [{ id: "pin-next" }, { id: "pin-cancel" }],
          ];
        }
        if (hasPin() && !pinVerified()) {
          return [[{ id: "unlock" }]];
        }
        const pinRow: GridItem[] = hasPin()
          ? [{ id: "chg-pin" }, { id: "rm-pin", type: "danger" }]
          : [{ id: "set-pin" }];
        const rows: GridItem[][] = [pinRow];
        const ADULT_COLS = 2;
        const chs = adultChannels() ?? [];
        for (let r = 0; r * ADULT_COLS < chs.length; r++) {
          rows.push(
            chs
              .slice(r * ADULT_COLS, (r + 1) * ADULT_COLS)
              .map<GridItem>((ch, ci) => ({
                id: `ach-${ch.id}`,
                type: "adult-ch",
                chId: ch.id,
                ci: r * ADULT_COLS + ci,
              })),
          );
        }
        return rows;
      }

      case "logout":
        return [[{ id: "logout-btn" }]];

      default:
        return [[]];
    }
  });

  // Reset focus on major state changes (NOT on tab change — that's nav).
  createEffect(
    on([section, showForm, pinMode], () => {
      setRowIdx(0);
      setColIdx(0);
      setInputMode(false);
    }),
  );

  // Clamp focus to valid grid position when grid shrinks.
  createEffect(() => {
    const g = grid();
    if (!g.length) return;
    const clampedRow = Math.min(rowIdx(), g.length - 1);
    const clampedCol = Math.min(colIdx(), (g[clampedRow]?.length ?? 1) - 1);
    if (clampedRow !== rowIdx()) setRowIdx(clampedRow);
    if (clampedCol !== colIdx()) setColIdx(clampedCol);
  });

  // Scroll focused element into view.
  createEffect(() => {
    if (zone() !== "content") return;
    const r = rowIdx();
    const c = colIdx();
    queueMicrotask(() => {
      const el = contentRef?.querySelector(`[data-foc="${r}-${c}"]`);
      (el as HTMLElement | null)?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  });

  // Focus container on mount.
  createEffect(() => {
    queueMicrotask(() => containerRef?.focus());
  });

  // Auto-focus PIN input when entering PIN mode.
  createEffect(
    on(pinMode, (mode) => {
      if (mode && zone() === "content") {
        window.setTimeout(() => {
          pinInputRef?.focus();
          setInputMode(true);
        }, 80);
      }
    }),
  );

  // Reset PIN session when leaving the parental section.
  createEffect(
    on(section, (s) => {
      if (s !== "parental") setPinVerified(false);
    }),
  );

  // ── Fetch provider info (the User Info section) ─────────────────────────
  const fetchProvider = async () => {
    setProvLoading(true);
    setProvError(null);
    try {
      const me = await getMe();
      setProvData(me);
    } catch (e) {
      setProvError(e instanceof Error ? e.message : String(e));
    } finally {
      setProvLoading(false);
    }
  };

  // Initial provider fetch.
  createEffect(() => {
    fetchProvider();
  });

  // ── Load categories (lazy, per tab) ─────────────────────────────────────
  createEffect(
    on(tab, async (t) => {
      if (cats()[t] !== null) return;
      setCatsLoading(true);
      try {
        if (t === "live") {
          const list = await listLiveCategories();
          setCats((p) => ({ ...p, live: flattenLiveTree(list) }));
        } else if (t === "movies") {
          const list = await listMovieCategories();
          setCats((p) => ({ ...p, movies: flatToProfile(list) }));
        } else {
          const list = await listSerieCategories();
          setCats((p) => ({ ...p, series: flatToProfile(list) }));
        }
      } catch {
        setCats((p) => ({ ...p, [t]: [] }) as typeof p);
      } finally {
        setCatsLoading(false);
      }
    }),
  );

  // ── Prefs helpers ───────────────────────────────────────────────────────
  const applyPrefs = (next: ContentPrefsView) => {
    setPrefs(next);
    setContentPrefs(next);
  };
  const isSel = (id: number | string): boolean => {
    const s = prefs()[tab()];
    return s === null || s.map(String).includes(String(id));
  };

  /** Flat toggle for Movies / Series (no hierarchy). */
  const toggle = (id: number | string) => {
    const all = (cats()[tab()] ?? []).map((c) => String(c.id));
    const cur = prefs()[tab()];
    const s = cur === null ? all : cur.map(String);
    const idStr = String(id);
    const exists = s.includes(idStr);
    const n = exists ? s.filter((x) => x !== idStr) : [...s, idStr];
    applyPrefs({
      ...prefs(),
      [tab()]: n.length === all.length ? null : n,
    });
  };

  /**
   * Cascade-aware toggle for Live categories.
   *   Uncheck root  → also uncheck all its direct children
   *   Check  child  → also auto-check its parent (if not already)
   *   Uncheck child → no upward cascade
   *   Check  root   → no downward cascade
   */
  const toggleLive = (id: number | string) => {
    const liveCats = cats().live ?? [];
    const all = liveCats.map((c) => String(c.id));
    const cur = prefs().live;
    const s = cur === null ? [...all] : cur.map(String);
    const idStr = String(id);

    const cat = liveCats.find((c) => String(c.id) === idStr);
    const root = cat ? isLiveRoot(cat) : false;

    if (s.includes(idStr)) {
      const childStrIds = root
        ? liveCats
            .filter((c) => String(c.parent_id) === idStr)
            .map((c) => String(c.id))
        : [];
      const n = s.filter(
        (x) => x !== idStr && !childStrIds.includes(x),
      );
      applyPrefs({
        ...prefs(),
        live: n.length === all.length ? null : n,
      });
    } else {
      const n = [...s, idStr];
      if (!root && cat?.parent_id) {
        const parentIdStr = String(cat.parent_id);
        if (!n.includes(parentIdStr)) n.push(parentIdStr);
      }
      applyPrefs({
        ...prefs(),
        live: n.length === all.length ? null : n,
      });
    }
  };

  const selAll = () => applyPrefs({ ...prefs(), [tab()]: null });
  const deselAll = () => applyPrefs({ ...prefs(), [tab()]: [] });

  // ── Save credentials ────────────────────────────────────────────────────
  const saveCreds = async () => {
    if (!editUser().trim() || !editPass().trim() || !editUrl().trim()) {
      setEditError("All fields are required.");
      return;
    }
    const base_url = editUrl().trim().replace(/\/+$/, "");
    try {
      new URL(base_url);
    } catch {
      setEditError("Invalid URL.");
      return;
    }
    setEditLoading(true);
    setEditError("");
    try {
      await loginApi({
        base_url,
        username: editUser().trim(),
        password: editPass().trim(),
      });
      setEditSuccess(true);
      setShowForm(false);
      window.setTimeout(() => setEditSuccess(false), 3000);
      fetchProvider();
    } catch (e) {
      setEditError(
        e instanceof Error ? e.message : "Failed to update credentials.",
      );
    } finally {
      setEditLoading(false);
    }
  };

  // ── Parental PIN ───────────────────────────────────────────────────────
  const resetPin = () => {
    setPinMode(null);
    setPinStep("enter");
    setPinVal("");
    setPinFirst("");
    setPinErr("");
    setInputMode(false);
  };

  const removePin = () => {
    localStorage.removeItem(PIN_KEY);
    setHasPin(false);
    resetPin();
    setPinOk("PIN removed.");
    window.setTimeout(() => setPinOk(""), 3000);
  };

  const submitPin = () => {
    setPinErr("");
    if (!/^\d{4}$/.test(pinVal())) {
      setPinErr("PIN must be 4 digits.");
      return;
    }
    const mode = pinMode();
    if (mode === "set") {
      if (pinStep() === "enter") {
        setPinFirst(pinVal());
        setPinVal("");
        setPinStep("confirm");
      } else {
        if (pinVal() !== pinFirst()) {
          setPinErr("PINs do not match.");
          setPinVal("");
          setPinFirst("");
          setPinStep("enter");
          return;
        }
        localStorage.setItem(PIN_KEY, pinVal());
        setHasPin(true);
        resetPin();
        setPinOk("PIN set.");
        window.setTimeout(() => setPinOk(""), 3000);
      }
    } else if (mode === "change") {
      if (pinStep() === "verify") {
        if (pinVal() !== localStorage.getItem(PIN_KEY)) {
          setPinErr("Incorrect PIN.");
          setPinVal("");
          return;
        }
        setPinVal("");
        setPinStep("enter");
      } else if (pinStep() === "enter") {
        setPinFirst(pinVal());
        setPinVal("");
        setPinStep("confirm");
      } else {
        if (pinVal() !== pinFirst()) {
          setPinErr("PINs do not match.");
          setPinVal("");
          setPinFirst("");
          setPinStep("enter");
          return;
        }
        localStorage.setItem(PIN_KEY, pinVal());
        setHasPin(true);
        resetPin();
        setPinOk("PIN changed.");
        window.setTimeout(() => setPinOk(""), 3000);
      }
    } else if (mode === "verify") {
      if (pinVal() !== localStorage.getItem(PIN_KEY)) {
        setPinErr("Incorrect PIN.");
        setPinVal("");
        return;
      }
      setPinVerified(true);
      resetPin();
    }
  };

  // ── Adult channel helpers ──────────────────────────────────────────────
  const applyAdultSel = (sel: CategoryFilter) => {
    setAdultSel(sel);
    setAdultPrefs(sel);
  };
  const isAdultChSel = (id: number | string): boolean => {
    const s = adultSel();
    return s === null || s.map(String).includes(String(id));
  };
  const toggleAdultCh = (id: number | string) => {
    const allIds = (adultChannels() ?? []).map((ch) => String(ch.id));
    const s = adultSel() === null ? allIds : adultSel()!.map(String);
    const n = s.includes(String(id))
      ? s.filter((x) => x !== String(id))
      : [...s, String(id)];
    applyAdultSel(n.length === allIds.length ? null : n);
  };
  const selAllAdult = () => applyAdultSel(null);
  const deselAllAdult = () => applyAdultSel([]);

  // ── Load adult channels (lazy) ─────────────────────────────────────────
  const loadAdultChannels = async () => {
    setAdultChannelsLoading(true);
    try {
      let liveCats = cats().live;
      if (!liveCats) {
        const fresh = await listLiveCategories();
        liveCats = flattenLiveTree(fresh);
        setCats((p) => ({ ...p, live: liveCats }));
      }

      const adultRootIds = new Set(
        liveCats.filter(isAdultCategory).map((c) => String(c.id)),
      );
      // Leaves = categories with an Xtream provider id that are either
      // themselves adult-named OR children of an adult root. The legacy
      // guard `c.category_id != null` catches both real children and
      // adult roots that hold streams directly (e.g. "For Adults" with
      // no sub-categories).
      const adultLeaves = liveCats.filter(
        (c) =>
          c.xtream_category_id != null &&
          (isAdultCategory(c) || adultRootIds.has(String(c.parent_id))),
      );

      if (adultLeaves.length === 0) {
        setAdultChannels([]);
        return;
      }

      const results = await Promise.allSettled(
        adultLeaves.map((leaf) =>
          listLive({ category_id: leaf.id, per_page: 2000 }),
        ),
      );
      const seen = new Set<string>();
      const channels: AdultChannel[] = [];
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        for (const ch of r.value.items) {
          const key = String(ch.id);
          if (!seen.has(key)) {
            seen.add(key);
            channels.push({
              id: ch.id,
              stream_id: ch.stream_id,
              name: ch.name,
            });
          }
        }
      }
      rememberAdultChannelIds(
        channels.map((ch) => ch.stream_id ?? ch.id),
      );
      setAdultChannels(channels);
    } catch {
      setAdultChannels([]);
    } finally {
      setAdultChannelsLoading(false);
    }
  };

  // Trigger adult channel load when parental section is unlocked.
  createEffect(() => {
    if (section() !== "parental") return;
    if (hasPin() && !pinVerified()) return;
    if (adultChannels() !== null) return;
    loadAdultChannels();
  });

  // ── Activate focused item ─────────────────────────────────────────────
  const activate = (item: GridItem | undefined) => {
    if (!item) return;
    switch (item.id) {
      case "refresh":
        fetchProvider();
        break;
      case "edit-creds":
        setShowForm((v) => !v);
        setEditError("");
        break;
      case "url-f":
        urlInputRef?.focus();
        setInputMode(true);
        break;
      case "user-f":
        userInputRef?.focus();
        setInputMode(true);
        break;
      case "pass-f":
        passInputRef?.focus();
        setInputMode(true);
        break;
      case "save":
        saveCreds();
        break;
      case "cancel":
        setShowForm(false);
        setEditError("");
        break;
      case "sel-all":
        selAll();
        break;
      case "desel-all":
        deselAll();
        break;
      case "set-pin":
        setPinMode("set");
        setPinStep("enter");
        setPinVal("");
        setPinErr("");
        break;
      case "chg-pin":
        setPinMode("change");
        setPinStep("verify");
        setPinVal("");
        setPinErr("");
        break;
      case "rm-pin":
        removePin();
        break;
      case "unlock":
        setPinMode("verify");
        setPinStep("enter");
        setPinVal("");
        setPinErr("");
        break;
      case "pin-i":
        pinInputRef?.focus();
        setInputMode(true);
        break;
      case "pin-next":
        submitPin();
        break;
      case "pin-cancel":
        resetPin();
        break;
      case "logout-btn":
        clearAuth();
        navigate("/login");
        break;
      default:
        if (item.type === "cat") {
          tab() === "live" ? toggleLive(item.catId) : toggle(item.catId);
        } else if (item.type === "adult-ch") {
          toggleAdultCh(item.chId);
        }
        break;
    }
  };

  // ── Keyboard / D-pad handler ──────────────────────────────────────────
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;

      // Input mode: a text field has native focus.
      if (inputMode()) {
        if (e.key === "Enter") {
          e.preventDefault();
          if (section() === "parental" && pinMode() && pinVal().length === 4) {
            submitPin();
            return;
          }
          (document.activeElement as HTMLElement | null)?.blur();
          setInputMode(false);
          containerRef?.focus();
          setRowIdx((r) => Math.min(r + 1, grid().length - 1));
        } else if (
          e.key === "Backspace" &&
          (document.activeElement as HTMLInputElement | null)?.value === ""
        ) {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
          setInputMode(false);
          containerRef?.focus();
          if (section() === "parental" && pinMode()) {
            resetPin();
          }
        }
        return;
      }

      if (zone() === "sidebar") {
        switch (e.key) {
          case "ArrowUp":
            e.preventDefault();
            if (sideIdx() === 0) {
              setAppShellZone("nav");
            } else {
              setSideIdx((i) => Math.max(0, i - 1));
            }
            break;
          case "ArrowDown":
            e.preventDefault();
            setSideIdx((i) => Math.min(NAV.length - 1, i + 1));
            break;
          case "ArrowRight":
          case "Enter":
            e.preventDefault();
            setZone("content");
            setRowIdx(0);
            setColIdx(0);
            break;
          default:
            break;
        }
        return;
      }

      const g = grid();
      const curRowLen = g[rowIdx()]?.length ?? 1;

      switch (e.key) {
        case "ArrowUp": {
          e.preventDefault();
          if (rowIdx() > 0) {
            const newRow = rowIdx() - 1;
            const newRowLen = g[newRow]?.length ?? 1;
            setRowIdx(newRow);
            setColIdx((c) => Math.min(c, newRowLen - 1));
          }
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          if (rowIdx() < g.length - 1) {
            const newRow = rowIdx() + 1;
            const newRowLen = g[newRow]?.length ?? 1;
            setRowIdx(newRow);
            setColIdx((c) => Math.min(c, newRowLen - 1));
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (colIdx() > 0) {
            const nextCol = colIdx() - 1;
            setColIdx(nextCol);
            if (section() === "prefs" && rowIdx() === 0) {
              setTab(TAB_KEYS[nextCol] as TabKey);
            }
          } else {
            setZone("sidebar");
          }
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (colIdx() < curRowLen - 1) {
            const nextCol = colIdx() + 1;
            setColIdx(nextCol);
            if (section() === "prefs" && rowIdx() === 0) {
              setTab(TAB_KEYS[nextCol] as TabKey);
            }
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          const item = g[rowIdx()]?.[colIdx()];
          if (!item) break;
          if (item.type === "tab") {
            setTab(item.key);
            if (rowIdx() < g.length - 1) {
              setRowIdx(rowIdx() + 1);
              setColIdx(0);
            }
          } else {
            activate(item);
          }
          break;
        }
        case "Backspace":
        case "Escape":
          e.preventDefault();
          if (section() === "parental" && pinMode()) {
            resetPin();
          } else {
            setZone("sidebar");
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  // ── Derived helpers ────────────────────────────────────────────────────
  const ui = () => provData();
  const statusClr = createMemo(() => {
    const status = ui()?.status;
    if (status === "Active") return "#4caf50";
    if (status === "Banned") return "#e50914";
    if (status === "Expired") return "#ff9800";
    return "#888";
  });
  const rawCatList = createMemo<ProfileCat[]>(() =>
    tab() === "live"
      ? (cats().live ?? []).filter((c) => !isAdultCategory(c))
      : cats()[tab()] ?? [],
  );
  const catList = createMemo<ProfileCat[]>(() =>
    tab() === "live" ? buildLiveTree(rawCatList()) : rawCatList(),
  );
  const effectiveCols = () => (tab() === "live" ? 1 : GRID_COLS);
  const selCount = () => {
    const t = prefs()[tab()];
    return t === null ? catList().length : t.length ?? 0;
  };

  const isFoc = (r: number, c: number): boolean =>
    zone() === "content" && rowIdx() === r && colIdx() === c;

  const pinLabel = () => {
    const labels: Record<string, Record<string, string>> = {
      set: {
        enter: "Choose a new 4-digit PIN",
        confirm: "Confirm your PIN",
      },
      change: {
        verify: "Enter current PIN",
        enter: "Enter new PIN",
        confirm: "Confirm new PIN",
      },
      verify: { enter: "Enter your PIN to unlock" },
    };
    const m = pinMode();
    if (!m) return "";
    return labels[m]?.[pinStep()] ?? "";
  };

  const ownerUsername = () =>
    authUser()?.username || ui()?.username || "—";
  const ownerBaseUrl = () => ui()?.provider_base_url || "—";

  // ──────────────────────────────────────────────────────────────────────
  // Section renderers
  // ──────────────────────────────────────────────────────────────────────

  const renderInfo = (): JSX.Element => (
    <>
      <h2 class="pc-title">User Info</h2>

      <div class="pc-user-row">
        <div class="pc-avatar">
          {(authUser()?.username?.[0] ?? "?").toUpperCase()}
        </div>
        <div class="pc-ident">
          <div class="pc-baseurl">Account identity</div>
          <div class="pc-username">{ownerUsername()}</div>
          <div class="pc-baseurl">{ownerBaseUrl()}</div>
        </div>
        <Show when={ui()?.status}>
          <span
            class="pc-badge"
            style={{
              background: `${statusClr()}22`,
              color: statusClr(),
              "border-color": `${statusClr()}55`,
            }}
          >
            ● {ui()!.status}
          </span>
        </Show>
      </div>

      <Show when={provLoading()}>
        <div class="pc-state">
          <span class="pc-spin" /> Loading…
        </div>
      </Show>
      <Show when={provError() && !provLoading()}>
        <div class="pc-state pc-state--err">⚠ {provError()}</div>
      </Show>
      <Show when={ui() && !provLoading()}>
        <div class="pc-prov-grid">
          <For
            each={
              [
                ["Account Username", ownerUsername()],
                [
                  "Provider",
                  ui()!.provider_name ?? ui()!.provider_base_url ?? "—",
                ],
                ["Provider Expiry", fmtIsoDate(ui()!.provider_exp_date)],
                [
                  "Your Expiration",
                  fmtIsoDate(
                    ui()!.effective_exp_date ??
                      ui()!.subscription_exp_date,
                  ),
                ],
                [
                  "Connections",
                  ui()!.max_connections != null
                    ? `— / ${ui()!.max_connections}`
                    : "—",
                ],
                ["Trial", ui()!.is_trial ? "Yes" : "No"],
                [
                  "Subscription enforced",
                  ui()!.subscription_enforced ? "Yes" : "No",
                ],
                ["View mode", ui()!.view_mode],
              ] as const
            }
          >
            {([lbl, val]) => (
              <div class="pc-prov-item">
                <span class="pc-prov-lbl">{lbl}</span>
                <span class="pc-prov-val">{val}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={editSuccess()}>
        <div class="pc-success">✓ Credentials updated successfully.</div>
      </Show>

      <div class="pc-row">
        <div
          class={`pc-item ${isFoc(0, 0) ? "focused" : ""}`}
          data-foc="0-0"
          onClick={fetchProvider}
        >
          ↻ Refresh
        </div>
        <div
          class={`pc-item ${showForm() ? "pc-item--active" : ""} ${
            isFoc(0, 1) ? "focused" : ""
          }`}
          data-foc="0-1"
          onClick={() => {
            setShowForm((v) => !v);
            setEditError("");
          }}
        >
          ✏ {showForm() ? "Cancel Changes" : "Change Credentials"}
        </div>
      </div>

      <Show when={showForm()}>
        <div class="pc-form">
          <Show when={editError()}>
            <div class="pc-error">⚠ {editError()}</div>
          </Show>

          <div
            class={`pc-field ${isFoc(1, 0) ? "focused" : ""}`}
            data-foc="1-0"
            onClick={() => {
              urlInputRef?.focus();
              setInputMode(true);
            }}
          >
            <span class="pc-field-lbl">Server URL</span>
            <input
              ref={(el) => (urlInputRef = el)}
              type="url"
              class="pc-inp"
              value={editUrl()}
              onInput={(e) => setEditUrl(e.currentTarget.value)}
              placeholder="http://host:port"
              disabled={editLoading()}
              onFocus={() => setInputMode(true)}
              onBlur={() => {
                setInputMode(false);
                containerRef?.focus();
              }}
            />
          </div>

          <div
            class={`pc-field ${isFoc(2, 0) ? "focused" : ""}`}
            data-foc="2-0"
            onClick={() => {
              userInputRef?.focus();
              setInputMode(true);
            }}
          >
            <span class="pc-field-lbl">Username</span>
            <input
              ref={(el) => (userInputRef = el)}
              type="text"
              class="pc-inp"
              value={editUser()}
              onInput={(e) => setEditUser(e.currentTarget.value)}
              placeholder="username"
              disabled={editLoading()}
              onFocus={() => setInputMode(true)}
              onBlur={() => {
                setInputMode(false);
                containerRef?.focus();
              }}
            />
          </div>

          <div
            class={`pc-field ${isFoc(3, 0) ? "focused" : ""}`}
            data-foc="3-0"
            onClick={() => {
              passInputRef?.focus();
              setInputMode(true);
            }}
          >
            <span class="pc-field-lbl">Password</span>
            <input
              ref={(el) => (passInputRef = el)}
              type="password"
              class="pc-inp"
              value={editPass()}
              onInput={(e) => setEditPass(e.currentTarget.value)}
              placeholder="password"
              disabled={editLoading()}
              onFocus={() => setInputMode(true)}
              onBlur={() => {
                setInputMode(false);
                containerRef?.focus();
              }}
            />
          </div>

          <div class="pc-row">
            <div
              class={`pc-item pc-item--primary ${
                isFoc(4, 0) ? "focused" : ""
              }`}
              data-foc="4-0"
              onClick={saveCreds}
            >
              <Show when={editLoading()} fallback="Save & Reconnect">
                <span class="pc-spin-sm" /> Connecting…
              </Show>
            </div>
            <div
              class={`pc-item ${isFoc(4, 1) ? "focused" : ""}`}
              data-foc="4-1"
              onClick={() => {
                setShowForm(false);
                setEditError("");
              }}
            >
              Cancel
            </div>
          </div>
        </div>
      </Show>
    </>
  );

  const renderPrefs = (): JSX.Element => {
    const TABS = [
      { id: "tab-live", key: "live" as const, label: "📺 Live TV" },
      { id: "tab-movies", key: "movies" as const, label: "🎬 Movies" },
      { id: "tab-series", key: "series" as const, label: "🎭 Series" },
    ];

    return (
      <>
        <h2 class="pc-title">Content Preferences</h2>
        <p class="pc-sub">Choose which categories appear in your library.</p>

        <div class="pc-tabs">
          <For each={TABS}>
            {(t, ci) => (
              <div
                class={`pc-tab ${tab() === t.key ? "active" : ""} ${
                  isFoc(0, ci()) ? "focused" : ""
                }`}
                data-foc={`0-${ci()}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                <Show when={prefs()[t.key] !== null}>
                  <span class="pc-tab-badge">
                    {prefs()[t.key]?.length ?? 0}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>

        <div class="pc-controls-row">
          <span class="pc-count">
            {catsLoading()
              ? "…"
              : `${selCount()} / ${catList().length} selected`}
          </span>
          <div
            class={`pc-item pc-item--sm ${isFoc(1, 0) ? "focused" : ""}`}
            data-foc="1-0"
            onClick={selAll}
          >
            Select All
          </div>
          <div
            class={`pc-item pc-item--sm ${isFoc(1, 1) ? "focused" : ""}`}
            data-foc="1-1"
            onClick={deselAll}
          >
            Deselect All
          </div>
        </div>

        <Show
          when={!catsLoading()}
          fallback={
            <div class="pc-state">
              <span class="pc-spin" /> Loading categories…
            </div>
          }
        >
          <Show
            when={catList().length > 0}
            fallback={
              <div class="pc-state pc-state--empty">No categories found.</div>
            }
          >
            <div
              class={`pc-cat-grid${
                tab() === "live" ? " pc-cat-grid--live" : ""
              }`}
            >
              <For each={catList()}>
                {(cat, ci) => {
                  const r = () => 2 + Math.floor(ci() / effectiveCols());
                  const c = () => ci() % effectiveCols();
                  const sel = () => isSel(cat.id);
                  const root = () =>
                    tab() === "live" ? isLiveRoot(cat) : false;
                  const onTgl = () =>
                    tab() === "live" ? toggleLive(cat.id) : toggle(cat.id);
                  return (
                    <div
                      class={[
                        "pc-cat-item",
                        tab() === "live"
                          ? root()
                            ? "pc-cat-item--root"
                            : "pc-cat-item--child"
                          : "",
                        sel() ? "selected" : "",
                        isFoc(r(), c()) ? "focused" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-foc={`${r()}-${c()}`}
                      onClick={onTgl}
                    >
                      <span class="pc-cat-check">{sel() ? "✓" : ""}</span>
                      <span class="pc-cat-name">
                        {cat.category_name || cat.name || "—"}
                      </span>
                      <Show when={extractLang(cat)}>
                        <span class="pc-cat-lang">{extractLang(cat)}</span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </>
    );
  };

  const renderParental = (): JSX.Element => {
    const ADULT_COLS = 2;
    const adultChList = () => adultChannels() ?? [];
    const adultSelCount = () =>
      adultSel() === null
        ? adultChList().length
        : adultSel()?.length ?? 0;

    return (
      <>
        <h2 class="pc-title">Parental Control</h2>
        <p class="pc-sub">Protect adult content with a 4-digit PIN.</p>

        <Show when={pinOk()}>
          <div class="pc-success">{pinOk()}</div>
        </Show>

        <div class="pc-status-row">
          <span class="pc-lock">{hasPin() ? "🔒" : "🔓"}</span>
          <span class="pc-status-txt">
            {hasPin()
              ? pinVerified()
                ? "PIN verified — settings unlocked"
                : "PIN is active — adult content is locked"
              : "No PIN set — content is visible to everyone"}
          </span>
        </div>

        <Show when={pinMode()}>
          <div class="pc-pin-form">
            <div class="pc-pin-label">{pinLabel()}</div>

            <div class="pc-pin-steps">
              <For
                each={
                  pinMode() === "set"
                    ? (["enter", "confirm"] as const)
                    : pinMode() === "verify"
                      ? (["enter"] as const)
                      : (["verify", "enter", "confirm"] as const)
                }
              >
                {(s, i) => {
                  const arr =
                    pinMode() === "set"
                      ? (["enter", "confirm"] as const)
                      : pinMode() === "verify"
                        ? (["enter"] as const)
                        : (["verify", "enter", "confirm"] as const);
                  return (
                    <span>
                      <span
                        class={`pc-pin-step ${
                          pinStep() === s
                            ? "active"
                            : (arr as readonly string[]).indexOf(pinStep()) > i()
                              ? "done"
                              : ""
                        }`}
                      >
                        {i() + 1}
                      </span>
                      <Show when={i() < arr.length - 1}>
                        <span class="pc-pin-step-line" />
                      </Show>
                    </span>
                  );
                }}
              </For>
            </div>

            <div
              class={`pc-field ${isFoc(0, 0) ? "focused" : ""}`}
              data-foc="0-0"
              onClick={() => {
                pinInputRef?.focus();
                setInputMode(true);
              }}
            >
              <span class="pc-field-lbl">PIN</span>
              <input
                ref={(el) => (pinInputRef = el)}
                class="pc-pin-inp"
                type="password"
                maxLength={4}
                inputMode="numeric"
                pattern="\d{4}"
                placeholder="••••"
                value={pinVal()}
                onInput={(e) => {
                  setPinVal(
                    e.currentTarget.value.replace(/\D/g, "").slice(0, 4),
                  );
                  setPinErr("");
                }}
                onFocus={() => setInputMode(true)}
                onBlur={() => {
                  setInputMode(false);
                  containerRef?.focus();
                }}
                autofocus
              />
            </div>
            <Show when={pinErr()}>
              <div class="pc-error">⚠ {pinErr()}</div>
            </Show>

            <div class="pc-row">
              <div
                class={`pc-item pc-item--primary ${
                  isFoc(1, 0) ? "focused" : ""
                }`}
                data-foc="1-0"
                onClick={submitPin}
              >
                {pinStep() === "confirm" ? "Save PIN" : "Next →"}
              </div>
              <div
                class={`pc-item ${isFoc(1, 1) ? "focused" : ""}`}
                data-foc="1-1"
                onClick={resetPin}
              >
                Cancel
              </div>
            </div>
          </div>
        </Show>

        <Show when={!pinMode() && hasPin() && !pinVerified()}>
          <div
            class={`pc-item pc-item--primary ${
              isFoc(0, 0) ? "focused" : ""
            }`}
            data-foc="0-0"
            onClick={() => {
              setPinMode("verify");
              setPinStep("enter");
              setPinVal("");
              setPinErr("");
            }}
          >
            🔓 Enter PIN to manage
          </div>
        </Show>

        <Show when={!pinMode() && (!hasPin() || pinVerified())}>
          <div class="pc-row">
            <Show
              when={hasPin()}
              fallback={
                <div
                  class={`pc-item ${isFoc(0, 0) ? "focused" : ""}`}
                  data-foc="0-0"
                  onClick={() => {
                    setPinMode("set");
                    setPinStep("enter");
                    setPinVal("");
                    setPinErr("");
                  }}
                >
                  🔒 Set PIN
                </div>
              }
            >
              <div
                class={`pc-item ${isFoc(0, 0) ? "focused" : ""}`}
                data-foc="0-0"
                onClick={() => {
                  setPinMode("change");
                  setPinStep("verify");
                  setPinVal("");
                  setPinErr("");
                }}
              >
                ✏ Change PIN
              </div>
              <div
                class={`pc-item pc-item--danger ${
                  isFoc(0, 1) ? "focused" : ""
                }`}
                data-foc="0-1"
                onClick={removePin}
              >
                🗑 Remove PIN
              </div>
            </Show>
          </div>

          <div class="pc-adult-header">
            <span class="pc-adult-icon">🔞</span>
            <span>Adult Content Channels</span>
            <Show when={adultSel() !== null}>
              <span class="pc-tab-badge">{adultSel()!.length}</span>
            </Show>
          </div>
          <p class="pc-sub pc-sub--sm">
            Choose which adult channels are visible. Deselect all to hide
            this category entirely.
          </p>
          <div class="pc-controls-row pc-controls-row--compact">
            <span class="pc-count">
              {adultChannelsLoading()
                ? "…"
                : `${adultSelCount()} / ${adultChList().length} selected`}
            </span>
            <div class="pc-item pc-item--sm" onClick={selAllAdult}>
              Select All
            </div>
            <div class="pc-item pc-item--sm" onClick={deselAllAdult}>
              Deselect All
            </div>
          </div>

          <Show
            when={!adultChannelsLoading()}
            fallback={
              <div class="pc-state">
                <span class="pc-spin" /> Loading channels…
              </div>
            }
          >
            <Show
              when={adultChList().length > 0}
              fallback={
                <div class="pc-state pc-state--empty">
                  No adult channels found in your account.
                </div>
              }
            >
              <div class="pc-adult-grid">
                <For each={adultChList()}>
                  {(ch, ci) => {
                    const r = () => 1 + Math.floor(ci() / ADULT_COLS);
                    const c = () => ci() % ADULT_COLS;
                    const sel = () => isAdultChSel(ch.id);
                    return (
                      <div
                        class={`pc-adult-item ${sel() ? "selected" : ""} ${
                          isFoc(r(), c()) ? "focused" : ""
                        }`}
                        data-foc={`${r()}-${c()}`}
                        onClick={() => toggleAdultCh(ch.id)}
                      >
                        <span class="pc-cat-check">{sel() ? "✓" : ""}</span>
                        <span class="pc-cat-name">{ch.name || "—"}</span>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </>
    );
  };

  const renderLogout = (): JSX.Element => (
    <>
      <h2 class="pc-title">Sign Out</h2>
      <p class="pc-sub">
        This will clear all local session data and return you to the login
        screen.
      </p>
      <div
        class={`pc-item pc-item--logout ${isFoc(0, 0) ? "focused" : ""}`}
        data-foc="0-0"
        onClick={() => {
          clearAuth();
          navigate("/login");
        }}
      >
        ⏏ Sign Out
      </div>
    </>
  );

  return (
    <div
      ref={(el) => (containerRef = el)}
      class="profile-page"
      tabIndex={0}
    >
      <nav class="profile-sidebar">
        <For each={NAV}>
          {(n, i) => (
            <div
              class={[
                "ps-item",
                section() === n.id ? "active" : "",
                zone() === "sidebar" && sideIdx() === i() ? "kb-focused" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                setSideIdx(i());
                if (n.id !== "logout") {
                  setZone("content");
                  setRowIdx(0);
                  setColIdx(0);
                } else {
                  clearAuth();
                  navigate("/login");
                }
              }}
            >
              <span class="ps-icon">{n.icon}</span>
              <span class="ps-label">{n.label}</span>
            </div>
          )}
        </For>
      </nav>

      <div ref={(el) => (contentRef = el)} class="profile-content-panel">
        <Show when={section() === "info"}>{renderInfo()}</Show>
        <Show when={section() === "prefs"}>{renderPrefs()}</Show>
        <Show when={section() === "parental"}>{renderParental()}</Show>
        <Show when={section() === "logout"}>{renderLogout()}</Show>
      </div>
    </div>
  );
}
