/**
 * Live — drillable category sidebar + channel list with EPG timeline.
 *
 * Faithful Solid port of `tv_app_v2/src/pages/LivePage.jsx` (1056 LOC).
 * Same shell: HeroCarousel showing focused channel + a non-collapsed
 * `.lp-sidebar` (220px) + a list panel with a 3-hour time ruler and
 * one row per channel showing the per-channel EPG timeline. Adult-
 * named root categories gate behind a PIN overlay (digit grid).
 *
 * EPG comes from our backend's `/api/v1/live/{id}/epg` pass-through —
 * fetched on focus change with a prev/current/next pre-fetch window so
 * adjacent rows are already populated by the time the user lands on
 * them. Backend caches per-user for 5 min.
 *
 * Three-zone keyboard model:
 *   hero ↓   → sidebar (or list, if channels already loaded)
 *   sidebar →/Enter → drill / open list
 *   sidebar ← → goBackTree() (or hero if empty stack)
 *   list ↑/↓ → channel; ← → sidebar; Enter → play (stub)
 *   PIN overlay owns input when open: digits + 4×3 keypad nav
 *
 * Deferred:
 *   - Hero preview clip — auth model has no direct stream URL without a
 *     slot allocation. Same gap as MoviesPage / SeriesPage.
 *   - Recent-channels rail — no preferred-channels store ported yet.
 *   - Virtualization — render all rows for a first cut. The legacy used
 *     react-window for >1000-channel categories; revisit if scrolling
 *     gets sluggish on a real Fire TV.
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
import { listLiveCategories, listLive } from "../api/catalog";
import { fetchShortEpg } from "../api/epg";
import type {
  EpgListing,
  LiveCategoryNode,
  LiveStreamItem,
} from "../api/types";
import { useNavigationScope } from "../lib/navigation";
import { setAppShellZone } from "../stores/shell";
import {
  isAdultCategory,
  filterByPrefs,
  getContentPrefs,
  getAdultPrefs,
  rememberAdultChannelIds,
} from "../lib/contentPrefs";
import { getGradient, getAccent } from "../lib/gradient";
import HeroCarousel, {
  type HeroBadge,
  type HeroItem,
} from "../components/HeroCarousel";
import Sidebar, { type SidebarItem } from "../components/Sidebar";
import { openPlayer } from "../stores/player";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PIN_KEY = "ott_parental_pin";
const TIMELINE_SLOT_MINUTES = 30;
const TIMELINE_WINDOW_MINUTES = 180;
const TIMELINE_BLOCK_GAP_PCT = 0.2;
const EPG_LIMIT = 4;

// PIN keypad navigation rows (matches the legacy 3-col grid + 2-col actions).
//   0..8 = digits 1-9 (3 rows of 3)
//   9    = C (clear)
//   10   = digit 0
//   11   = ← (backspace)
//   12   = Cancel
//   13   = Unlock
const PIN_GRID_ROWS: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [9, 10, 11],
  [12, 13],
];

type Zone = "hero" | "sidebar" | "list";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Provider returns titles/descriptions base64-encoded. Decode safely; if
 * the value isn't valid b64 (some providers send mixed encoding), fall
 * back to the raw input.
 */
function decodeB64(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const bin = atob(value);
    if (typeof TextDecoder !== "undefined") {
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    }
    const pct = Array.from(
      bin,
      (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
    ).join("");
    return decodeURIComponent(pct);
  } catch {
    return value;
  }
}

function fmtTime(val: number | string | null | undefined): string {
  if (val == null || val === "") return "";
  let d: Date;
  if (typeof val === "number") {
    d = new Date(val > 1_000_000_000_000 ? val : val * 1000);
  } else {
    d = new Date(String(val).replace(" ", "T"));
  }
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function toEpochMs(val: number | string | null | undefined): number | null {
  if (val == null || val === "") return null;
  if (typeof val === "number") {
    return val > 1_000_000_000_000 ? val : val * 1000;
  }
  const parsed = new Date(String(val).replace(" ", "T")).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

interface TimelineItem {
  id: string;
  label: string;
  isLive: boolean;
  leftPct: number;
  widthPct: number;
  timeLabel: string;
}

function buildTimelineItems(args: {
  epg: EpgListing[];
  streamId: number;
  timelineStartMs: number;
  timelineEndMs: number;
  timelineTotalMs: number;
  nowMs: number;
}): TimelineItem[] {
  const { epg, streamId, timelineStartMs, timelineEndMs, timelineTotalMs, nowMs } = args;

  const raw = epg
    .map((entry, i) => {
      const start = toEpochMs(entry.start_timestamp ?? entry.start ?? null);
      const end = toEpochMs(
        entry.stop_timestamp ?? entry.end ?? entry.stop ?? null,
      );
      if (
        start == null ||
        end == null ||
        end <= timelineStartMs ||
        start >= timelineEndMs
      ) {
        return null;
      }
      const visibleStart = Math.max(start, timelineStartMs);
      const visibleEnd = Math.min(end, timelineEndMs);
      const leftPct = ((visibleStart - timelineStartMs) / timelineTotalMs) * 100;
      const rightPct = ((visibleEnd - timelineStartMs) / timelineTotalMs) * 100;
      return {
        id: `${streamId}-${i}`,
        label: decodeB64(entry.title || "No programme info"),
        isLive: start <= nowMs && end > nowMs,
        leftPct,
        rightPct,
        timeLabel: `${fmtTime(start)} - ${fmtTime(end)}`,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.leftPct - b.leftPct);

  // Prevent visual overlap when provider EPG has overlaps or very short
  // adjacent programs.
  const out: TimelineItem[] = [];
  let prevRight = 0;
  for (const item of raw) {
    const adjLeft = Math.max(item.leftPct, prevRight);
    const adjRight = Math.max(item.rightPct, adjLeft);
    const widthPct = adjRight - adjLeft;
    if (widthPct <= 0) continue;
    const hasGap = widthPct > TIMELINE_BLOCK_GAP_PCT * 2;
    const visualLeft = hasGap ? adjLeft + TIMELINE_BLOCK_GAP_PCT : adjLeft;
    let visualWidth = hasGap
      ? widthPct - TIMELINE_BLOCK_GAP_PCT * 2
      : widthPct;
    visualWidth = Math.max(6, visualWidth);
    visualWidth = Math.min(visualWidth, Math.max(0, 100 - visualLeft));
    out.push({
      id: item.id,
      label: item.label,
      isLive: item.isLive,
      leftPct: visualLeft,
      widthPct: visualWidth,
      timeLabel: item.timeLabel,
    });
    prevRight = Math.max(adjRight, visualLeft + visualWidth);
  }
  return out;
}

interface SidebarFlatNode {
  id: number;
  name: string;
  category_id: number | null;
  parent_id: number | null;
  children: LiveCategoryNode[]; // raw children to drill into
}

function flattenRoots(roots: LiveCategoryNode[]): SidebarFlatNode[] {
  return roots.map((r) => ({
    id: r.id,
    name: r.name,
    category_id: r.category_id,
    parent_id: null,
    children: r.children ?? [],
  }));
}

function flattenChildren(
  parent: LiveCategoryNode,
): SidebarFlatNode[] {
  return (parent.children ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    category_id: c.category_id,
    parent_id: parent.id,
    children: c.children ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Live(): JSX.Element {
  const { isScopeOwner } = useNavigationScope("page:live", {
    active: true,
    priority: 30,
  });

  // Category tree (loaded once)
  const [tree] = createResource<LiveCategoryNode[]>(() =>
    listLiveCategories().catch(() => [] as LiveCategoryNode[]),
  );

  // Current navigation level + drill stack
  const [currentItems, setCurrentItems] = createSignal<SidebarFlatNode[]>([]);
  const [navStack, setNavStack] = createSignal<
    { node: SidebarFlatNode; items: SidebarFlatNode[] }[]
  >([]);

  // Apply prefs.live + adult filter once when tree lands (top level only).
  //
  // prefs.live filters by category id, but Profile's prefs picker
  // intentionally excludes adult categories from selection (they're
  // gated by their own pref) — so adult cats are never in
  // `prefs.live` and the live-prefs filter would silently drop them.
  // Re-include any adult roots from the original list after the
  // live filter; the adult opt-out (`adultPrefs === []`) is the only
  // control that should hide them from the sidebar.
  createEffect(
    on(tree, (roots) => {
      if (!roots) return;
      const flatRoots = flattenRoots(roots);
      const prefs = getContentPrefs();
      let filtered = filterByPrefs(flatRoots, prefs.live);
      if (prefs.live !== null && prefs.live.length > 0) {
        const seen = new Set(filtered.map((c) => c.id));
        for (const cat of flatRoots) {
          if (isAdultCategory(cat) && !seen.has(cat.id)) {
            filtered.push(cat);
            seen.add(cat.id);
          }
        }
      }
      const adultPrefs = getAdultPrefs();
      if (adultPrefs !== null && adultPrefs.length === 0) {
        filtered = filtered.filter((cat) => !isAdultCategory(cat));
      }
      setCurrentItems(filtered);
    }),
  );

  // Channels (for the active leaf)
  const [channels, setChannels] = createSignal<LiveStreamItem[]>([]);
  const [activeLeaf, setActiveLeaf] = createSignal<SidebarFlatNode | null>(
    null,
  );
  const [listLoading, setListLoading] = createSignal(false);

  // Focus / zone state
  const [zone, setZone] = createSignal<Zone>("hero");
  const [sidebarIdx, setSidebarIdx] = createSignal(0);
  const [channelIdx, setChannelIdx] = createSignal(0);

  // EPG cache (per stream_id) + status tracking
  const [epgCache, setEpgCache] = createSignal<Record<string, EpgListing[]>>({});
  const [epgStatus, setEpgStatus] = createSignal<
    Record<string, "idle" | "loading" | "loaded" | "error">
  >({});

  // Adult PIN overlay state
  const [pinOverlay, setPinOverlay] = createSignal<{
    open: boolean;
    val: string;
    err: string;
  }>({ open: false, val: "", err: "" });
  const [pinFocusIndex, setPinFocusIndex] = createSignal(0);
  let pendingAdultNode: SidebarFlatNode | null = null;
  let adultContext = false;

  // Timeline window — 30-min aligned, 3-hour wide
  const timelineStartMs = (() => {
    const slot = TIMELINE_SLOT_MINUTES * 60 * 1000;
    return Math.floor(Date.now() / slot) * slot;
  })();
  const timelineEndMs =
    timelineStartMs + TIMELINE_WINDOW_MINUTES * 60 * 1000;
  const timelineTotalMs = timelineEndMs - timelineStartMs;
  const timelineTicks = (() => {
    const slot = TIMELINE_SLOT_MINUTES * 60 * 1000;
    const count = Math.floor(TIMELINE_WINDOW_MINUTES / TIMELINE_SLOT_MINUTES);
    return Array.from(
      { length: count + 1 },
      (_, i) => timelineStartMs + i * slot,
    );
  })();

  // Live "now" indicator — re-render every minute so the guide stays current.
  const [nowMs, setNowMs] = createSignal(Date.now());
  createEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    onCleanup(() => clearInterval(id));
  });
  const nowOffsetPct = createMemo(() =>
    clamp(((nowMs() - timelineStartMs) / timelineTotalMs) * 100, 0, 100),
  );

  // ── EPG fetch (per channel, prev/current/next window) ─────────────────
  const epgInflight = new Set<string>();

  const fetchEpgFor = async (channel: LiveStreamItem) => {
    const sid = String(channel.stream_id);
    if (!sid || epgInflight.has(sid)) return;
    if (epgCache()[sid]) return;
    epgInflight.add(sid);
    setEpgStatus((p) => ({ ...p, [sid]: "loading" }));
    try {
      const resp = await fetchShortEpg(channel.id, EPG_LIMIT);
      const listings = resp.epg_listings ?? [];
      setEpgCache((p) => ({ ...p, [sid]: listings.slice(0, EPG_LIMIT) }));
      setEpgStatus((p) => ({
        ...p,
        [sid]: listings.length > 0 ? "loaded" : "loaded",
      }));
    } catch {
      setEpgCache((p) => ({ ...p, [sid]: [] }));
      setEpgStatus((p) => ({ ...p, [sid]: "error" }));
    } finally {
      epgInflight.delete(sid);
    }
  };

  // Pre-fetch prev/current/next when focus changes.
  createEffect(() => {
    const list = channels();
    if (!list.length) return;
    const i = channelIdx();
    [i - 1, i, i + 1]
      .filter((x) => x >= 0 && x < list.length)
      .forEach((x) => fetchEpgFor(list[x]));
  });

  // ── Hero items (focused channel) ─────────────────────────────────────
  const focusedChannel = createMemo<LiveStreamItem | null>(() =>
    channels()[channelIdx()] ?? null,
  );

  const heroItems = createMemo<HeroItem[]>(() => {
    const ch = focusedChannel();
    if (!ch) return [];
    const epg = epgCache()[String(ch.stream_id)] ?? [];
    const now = epg[0];
    const next = epg[1];
    const nowTitle = now ? decodeB64(now.title) : "";
    const nextTitle = next ? decodeB64(next.title) : "";
    const nowWindow = now
      ? [
          fmtTime(now.start_timestamp ?? now.start ?? null),
          fmtTime(now.stop_timestamp ?? now.end ?? now.stop ?? null),
        ]
          .filter(Boolean)
          .join(" - ")
      : "";
    const subtitle =
      [nowWindow, nowTitle, nextTitle ? `Next: ${nextTitle}` : ""]
        .filter(Boolean)
        .join(" • ") || null;

    const badges: HeroBadge[] = [{ label: "📺 Live", variant: "live" }];

    return [
      {
        id: String(ch.id ?? ch.stream_id),
        title: ch.name,
        poster: ch.stream_icon,
        backdrop: ch.stream_icon,
        gradient: getGradient(ch.name || String(ch.stream_id)),
        accent: getAccent(ch.name || String(ch.stream_id)),
        genres: [],
        plot: subtitle,
        badges,
      },
    ];
  });

  // ── Sidebar drilling ──────────────────────────────────────────────────
  const drillInto = (node: SidebarFlatNode) => {
    const children = node.children;
    if (!children || children.length === 0) {
      // Leaf — load channels
      loadChannelsFor(node);
      return;
    }
    const prefs = getContentPrefs();
    const filtered = filterByPrefs(
      flattenChildren({
        id: node.id,
        name: node.name,
        category_id: node.category_id,
        children,
      }),
      prefs.live,
    );
    setNavStack((s) => [...s, { node, items: currentItems() }]);
    setCurrentItems(filtered);
    setSidebarIdx(0);
  };

  const goBackTree = (): boolean => {
    const stack = navStack();
    if (stack.length === 0) return false;
    const prev = stack[stack.length - 1];
    setNavStack((s) => s.slice(0, -1));
    setCurrentItems(prev.items);
    setSidebarIdx(0);
    return true;
  };

  const loadChannelsFor = async (leaf: SidebarFlatNode) => {
    setActiveLeaf(leaf);
    setChannels([]);
    setChannelIdx(0);
    setListLoading(true);
    try {
      const resp = await listLive({
        category_id: leaf.id,
        per_page: 500,
      });
      let data = resp.items;

      // If we're inside an adult-named category, apply adult prefs filter.
      if (adultContext) {
        const adultPrefs = getAdultPrefs();
        if (adultPrefs !== null) {
          if (adultPrefs.length === 0) {
            data = [];
          } else {
            const allowed = new Set(adultPrefs.map(String));
            const filtered = data.filter((ch) =>
              allowed.has(String(ch.id)),
            );
            data = filtered.length > 0 ? filtered : data;
          }
        }
        rememberAdultChannelIds(data.map((c) => c.stream_id ?? c.id));
      }

      setChannels(data);
      setZone(data.length > 0 ? "list" : "sidebar");
    } catch {
      setChannels([]);
      setZone("sidebar");
    } finally {
      setListLoading(false);
    }
  };

  const handleNodeSelect = (node: SidebarFlatNode) => {
    const inAdultPath = navStack().some((s) => isAdultCategory(s.node));
    const enteringAdult = isAdultCategory(node) && !inAdultPath;
    const storedPin = localStorage.getItem(PIN_KEY);

    if (enteringAdult && storedPin) {
      pendingAdultNode = node;
      setPinFocusIndex(0);
      setPinOverlay({ open: true, val: "", err: "" });
      return;
    }

    adultContext = isAdultCategory(node) || inAdultPath;
    if (node.category_id != null && (!node.children || node.children.length === 0)) {
      // Real provider category with no children → leaf
      loadChannelsFor(node);
    } else if (node.children && node.children.length > 0) {
      drillInto(node);
    } else {
      // Has category_id but also drillable — prefer leaf-load behavior
      loadChannelsFor(node);
    }
  };

  // ── PIN overlay control ───────────────────────────────────────────────
  const closePin = () => {
    pendingAdultNode = null;
    setPinFocusIndex(0);
    setPinOverlay({ open: false, val: "", err: "" });
  };

  const submitPin = () => {
    const stored = localStorage.getItem(PIN_KEY);
    const v = pinOverlay().val;
    if (v === stored) {
      const node = pendingAdultNode;
      pendingAdultNode = null;
      setPinOverlay({ open: false, val: "", err: "" });
      if (node) {
        adultContext = true;
        if (
          node.category_id != null &&
          (!node.children || node.children.length === 0)
        ) {
          loadChannelsFor(node);
        } else {
          drillInto(node);
        }
      }
      return;
    }
    setPinOverlay((p) => ({ ...p, val: "", err: "Incorrect PIN. Try again." }));
  };

  const appendDigit = (d: string) => {
    setPinOverlay((p) =>
      p.val.length < 4 ? { ...p, val: p.val + d, err: "" } : p,
    );
  };
  const backspaceDigit = () => {
    setPinOverlay((p) => {
      if (p.val.length > 0) return { ...p, val: p.val.slice(0, -1), err: "" };
      pendingAdultNode = null;
      return { open: false, val: "", err: "" };
    });
  };

  const activatePinControl = (idx: number) => {
    if (idx >= 0 && idx <= 8) {
      appendDigit(String(idx + 1));
    } else if (idx === 9) {
      setPinOverlay((p) => ({ ...p, val: "", err: "" }));
    } else if (idx === 10) {
      appendDigit("0");
    } else if (idx === 11) {
      backspaceDigit();
    } else if (idx === 12) {
      closePin();
    } else if (idx === 13) {
      submitPin();
    }
  };

  const movePinFocus = (direction: "left" | "right" | "up" | "down") => {
    const cur = pinFocusIndex();
    const rowIdx = PIN_GRID_ROWS.findIndex((r) => r.includes(cur));
    if (rowIdx < 0) {
      setPinFocusIndex(0);
      return;
    }
    const row = PIN_GRID_ROWS[rowIdx];
    const colIdx = row.indexOf(cur);
    if (direction === "left") {
      setPinFocusIndex(row[Math.max(0, colIdx - 1)]);
    } else if (direction === "right") {
      setPinFocusIndex(row[Math.min(row.length - 1, colIdx + 1)]);
    } else if (direction === "up") {
      if (rowIdx === 0) return;
      const prevRow = PIN_GRID_ROWS[rowIdx - 1];
      const ratio = row.length > 1 ? colIdx / (row.length - 1) : 0;
      const targetCol = Math.round(ratio * (prevRow.length - 1));
      setPinFocusIndex(prevRow[targetCol]);
    } else if (direction === "down") {
      if (rowIdx >= PIN_GRID_ROWS.length - 1) return;
      const nextRow = PIN_GRID_ROWS[rowIdx + 1];
      const ratio = row.length > 1 ? colIdx / (row.length - 1) : 0;
      const targetCol = Math.round(ratio * (nextRow.length - 1));
      setPinFocusIndex(nextRow[targetCol]);
    }
  };

  // ── Keyboard handler ──────────────────────────────────────────────────
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;

      // PIN overlay owns input when open.
      if (pinOverlay().open) {
        if (e.key >= "0" && e.key <= "9") {
          e.preventDefault();
          appendDigit(e.key);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          movePinFocus("left");
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          movePinFocus("right");
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          movePinFocus("up");
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          movePinFocus("down");
        } else if (e.key === "Backspace") {
          e.preventDefault();
          backspaceDigit();
        } else if (e.key === "Enter") {
          e.preventDefault();
          activatePinControl(pinFocusIndex());
        } else if (e.key === "Escape") {
          e.preventDefault();
          closePin();
        }
        return;
      }

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

      const back = e.key === "Escape" || e.key === "Backspace";

      if (zone() === "hero") {
        if (e.key === "ArrowDown") {
          if (channels().length > 0) setZone("list");
          else setZone("sidebar");
        } else if (e.key === "ArrowRight") {
          if (channels().length > 0) setZone("list");
        } else if (e.key === "ArrowUp" || back) {
          setAppShellZone("nav");
        } else if (e.key === "Enter") {
          const ch = focusedChannel();
          if (ch) {
            openPlayer({
              kind: "live",
              channel: ch,
              channels: channels(),
              index: channelIdx(),
            });
          }
        }
        return;
      }

      if (zone() === "sidebar") {
        if (e.key === "ArrowDown") {
          setSidebarIdx((p) =>
            Math.min(p + 1, currentItems().length - 1),
          );
        } else if (e.key === "ArrowUp") {
          if (sidebarIdx() === 0) setZone("hero");
          else setSidebarIdx((p) => Math.max(p - 1, 0));
        } else if (e.key === "ArrowRight" || e.key === "Enter") {
          const node = currentItems()[sidebarIdx()];
          if (node) handleNodeSelect(node);
        } else if (e.key === "ArrowLeft") {
          if (!goBackTree()) setZone("hero");
        } else if (back) {
          if (!goBackTree()) setZone("hero");
        }
        return;
      }

      // list zone
      if (e.key === "ArrowDown") {
        setChannelIdx((p) => Math.min(p + 1, channels().length - 1));
      } else if (e.key === "ArrowUp") {
        if (channelIdx() === 0) setZone("hero");
        else setChannelIdx((p) => Math.max(p - 1, 0));
      } else if (e.key === "ArrowLeft") {
        setZone("sidebar");
      } else if (e.key === "Enter") {
        const ch = channels()[channelIdx()];
        if (ch) {
          openPlayer({
            kind: "live",
            channel: ch,
            channels: channels(),
            index: channelIdx(),
          });
        }
      } else if (back) {
        setZone("sidebar");
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  // Auto-scroll the focused row into view.
  let listRef: HTMLDivElement | undefined;
  createEffect(() => {
    if (zone() !== "list") return;
    const i = channelIdx();
    queueMicrotask(() => {
      const child = listRef?.children[i] as HTMLElement | undefined;
      child?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });

  // ── Per-row precomputed timeline items ──────────────────────────────
  const channelRows = createMemo(() =>
    channels().map((channel) => {
      const sid = String(channel.stream_id);
      const epg = epgCache()[sid] ?? [];
      return {
        channel,
        epg,
        epgStatus: epgStatus()[sid] ?? "idle",
        timelineItems: buildTimelineItems({
          epg,
          streamId: channel.stream_id,
          timelineStartMs,
          timelineEndMs,
          timelineTotalMs,
          nowMs: nowMs(),
        }),
      };
    }),
  );

  // ── Sidebar UI items (with back button when nested) ──────────────────
  const sidebarUiItems = createMemo<SidebarItem[]>(() =>
    currentItems().map((n) => ({
      id: n.id,
      label: n.name,
    })),
  );

  const sidebarHeader = (): JSX.Element => {
    const stack = navStack();
    if (stack.length > 0) {
      return (
        <div class="lp-sidebar-header-slot">
          <button
            class="lp-sidebar-back-btn"
            onClick={() => goBackTree()}
            type="button"
          >
            ← {stack[stack.length - 1].node.name}
          </button>
        </div>
      );
    }
    return (
      <div class="lp-sidebar-header-slot">
        <h2 class="sidebar-title">📺 Live Categories</h2>
      </div>
    );
  };

  return (
    <div class="series-page sp-browser live-page">
      <Show when={heroItems().length > 0}>
        <HeroCarousel
          className="sp-browser-hero lp-browser-hero"
          activeIndex={0}
          animKey={channelIdx()}
          items={heroItems()}
          previewClip={null}
          previewEnabled={false}
          focused={zone() === "hero"}
        />
      </Show>

      <div class="sp-body lp-body">
        <Sidebar
          title=""
          headerSlot={sidebarHeader()}
          class="lp-sidebar"
          items={sidebarUiItems()}
          activeId={() => activeLeaf()?.id ?? null}
          focusedIdx={sidebarIdx}
          isFocused={() => zone() === "sidebar"}
          emptyLabel={tree.loading ? "Loading…" : "No categories"}
          onSelect={(_item, i) => {
            setSidebarIdx(i);
            const node = currentItems()[i];
            if (node) handleNodeSelect(node);
          }}
        />

        <div
          class={`sp-genre-panel lp-list-panel${zone() === "list" ? " sp-genre-panel--active" : ""}`}
        >
          <div class="sp-genre-panel-hdr lp-list-hdr">
            <h2 class="sp-genre-panel-title">
              {activeLeaf() ? activeLeaf()!.name : "Live channels"}
            </h2>
            <Show when={!listLoading() && channels().length > 0}>
              <span class="sp-genre-panel-count">
                {channels().length} channels
              </span>
            </Show>
          </div>

          <div class="lp-time-ruler">
            <div class="lp-time-ruler-left">
              <span class="lp-time-ruler-meta">ON NOW</span>
              <span class="lp-time-ruler-now-label">{fmtTime(nowMs())}</span>
            </div>
            <div class="lp-time-ruler-track">
              <div
                class="lp-time-ruler-now"
                style={{ left: `${nowOffsetPct()}%` }}
              >
                <span>{fmtTime(nowMs())}</span>
              </div>
              <For each={timelineTicks}>
                {(tick) => {
                  const left =
                    ((tick - timelineStartMs) / timelineTotalMs) * 100;
                  return (
                    <div
                      class="lp-time-ruler-tick"
                      style={{ left: `${left}%` }}
                    >
                      <span>{fmtTime(tick)}</span>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

          <Show
            when={!listLoading()}
            fallback={
              <div class="sp-empty-state">
                <p>Loading channels…</p>
              </div>
            }
          >
            <Show
              when={channels().length > 0}
              fallback={
                <div class="sp-empty-state lp-empty-state">
                  <span class="sp-empty-icon">📺</span>
                  <p>No channels in this category.</p>
                </div>
              }
            >
              <div class="lp-channel-list" ref={(el) => (listRef = el)}>
                <Index each={channelRows()}>
                  {(rowAcc, idx) => {
                    const row = () => rowAcc();
                    const focused = () =>
                      zone() === "list" && idx === channelIdx();
                    return (
                      <button
                        type="button"
                        class={`lp-channel-row${focused() ? " focused" : ""}`}
                        onMouseEnter={() => {
                          setZone("list");
                          setChannelIdx(idx);
                        }}
                        onClick={() => {
                          setZone("list");
                          setChannelIdx(idx);
                          openPlayer({
                            kind: "live",
                            channel: row().channel,
                            channels: channels(),
                            index: idx,
                          });
                        }}
                      >
                        <div class="lp-row-logo-col">
                          <div class="lp-row-logo-wrap">
                            <Show
                              when={row().channel.stream_icon}
                              fallback={
                                <div class="lp-row-logo-name">
                                  {(row().channel.name || "?")
                                    .slice(0, 2)
                                    .toUpperCase()}
                                </div>
                              }
                            >
                              <img
                                src={row().channel.stream_icon!}
                                alt={row().channel.name}
                                class="lp-row-logo"
                                onError={(e) => {
                                  (
                                    e.currentTarget as HTMLImageElement
                                  ).style.display = "none";
                                }}
                              />
                            </Show>
                          </div>
                          <div class="lp-row-logo-name">
                            {row().channel.name}
                          </div>
                        </div>

                        <div class="lp-row-main">
                          <div class="lp-row-timeline">
                            <div
                              class="lp-row-now-guide"
                              style={{ left: `${nowOffsetPct()}%` }}
                            />
                            <Show
                              when={row().timelineItems.length > 0}
                              fallback={
                                <div class="lp-row-epg-placeholder">
                                  {row().epgStatus === "loading" ||
                                  row().epgStatus === "idle"
                                    ? "Loading EPG…"
                                    : row().epgStatus === "error"
                                      ? "EPG unavailable"
                                      : "No EPG data"}
                                </div>
                              }
                            >
                              <For each={row().timelineItems}>
                                {(item) => (
                                  <div
                                    class={`lp-row-program${item.isLive ? " is-live" : ""}`}
                                    style={{
                                      left: `${item.leftPct}%`,
                                      width: `${item.widthPct}%`,
                                    }}
                                  >
                                    <span class="lp-row-program-title">
                                      {item.label}
                                    </span>
                                    <span class="lp-row-program-time">
                                      {item.timeLabel}
                                    </span>
                                  </div>
                                )}
                              </For>
                            </Show>
                          </div>
                        </div>
                      </button>
                    );
                  }}
                </Index>
              </div>
            </Show>
          </Show>
        </div>
      </div>

      {/* ── Adult-content PIN overlay ──────────────────────────────── */}
      <Show when={pinOverlay().open}>
        <div class="lp-pin-overlay">
          <div class="lp-pin-modal">
            <div class="lp-pin-icon">🔞</div>
            <h2 class="lp-pin-title">Adult Content</h2>
            <p class="lp-pin-sub">Enter your PIN to continue</p>
            <div class="lp-pin-dots">
              <For each={[0, 1, 2, 3]}>
                {(i) => (
                  <span
                    class={`lp-pin-dot${i < pinOverlay().val.length ? " filled" : ""}`}
                  />
                )}
              </For>
            </div>
            <Show when={pinOverlay().err}>
              <div class="lp-pin-err">{pinOverlay().err}</div>
            </Show>
            <div class="lp-pin-keypad">
              <For each={[1, 2, 3, 4, 5, 6, 7, 8, 9]}>
                {(n) => (
                  <button
                    type="button"
                    class={`lp-pin-key${pinFocusIndex() === n - 1 ? " focused" : ""}`}
                    onClick={() => activatePinControl(n - 1)}
                  >
                    {n}
                  </button>
                )}
              </For>
              <button
                type="button"
                class={`lp-pin-key lp-pin-key--muted${pinFocusIndex() === 9 ? " focused" : ""}`}
                onClick={() => activatePinControl(9)}
              >
                C
              </button>
              <button
                type="button"
                class={`lp-pin-key${pinFocusIndex() === 10 ? " focused" : ""}`}
                onClick={() => activatePinControl(10)}
              >
                0
              </button>
              <button
                type="button"
                class={`lp-pin-key lp-pin-key--muted${pinFocusIndex() === 11 ? " focused" : ""}`}
                onClick={() => activatePinControl(11)}
              >
                ←
              </button>
            </div>
            <div class="lp-pin-actions">
              <button
                type="button"
                class={`lp-pin-action${pinFocusIndex() === 12 ? " focused" : ""}`}
                onClick={() => activatePinControl(12)}
              >
                Cancel
              </button>
              <button
                type="button"
                class={`lp-pin-action lp-pin-action--primary${pinFocusIndex() === 13 ? " focused" : ""}`}
                onClick={() => activatePinControl(13)}
                disabled={pinOverlay().val.length !== 4}
              >
                Unlock
              </button>
            </div>
            <p class="lp-pin-hint">Use digits or keypad to enter PIN.</p>
          </div>
        </div>
      </Show>
    </div>
  );
}
