/**
 * Navigation scope stack — port of `tv_app_v2/src/state/navigationController.js`
 * + `tv_app_v2/src/hooks/useNavigationController.jsx`.
 *
 * Model
 * -----
 * Each UI region (sidebar, hero, a horizontal rail, modal, player overlay)
 * registers as a "scope" with a string id, an `active` flag, and a
 * `priority` number. The scope at the top of the stack — highest active
 * `priority`, ties broken by most-recent `mountedAt` — owns keyboard input.
 * Each scope handles its own internal navigation (selectedIndex etc.); the
 * stack just decides whose key handler is allowed to act.
 *
 * Why this isn't tree-walk spatial navigation
 * -------------------------------------------
 * Spatial nav (auto-walk DOM rectangles, find nearest neighbour by direction)
 * looks great in demos but is brittle on TV layouts with conditional content,
 * overlays, virtualised lists, etc. The scope stack delegates layout-aware
 * decisions to the components themselves and only arbitrates ownership —
 * which is exactly the design that turned out to work in the React app
 * after a lot of struggle. Verbatim port.
 *
 * Solid differences from React
 * ----------------------------
 *  - no Context provider — module-global signal works because the scope set
 *    is naturally one-per-app
 *  - no manual `setRevision` to retrigger memos — Solid's `setScopes(prev =>
 *    new Map(prev))` makes the new Map a fresh signal value
 *  - registration uses `onCleanup` for unmount, no `useEffect` array required
 */

import { createMemo, createRoot, createSignal, onCleanup } from "solid-js";

const NAV_DEBUG_FLAG = "ott_nav_debug";

export interface NavScope {
  id: string;
  token: string;
  active: boolean;
  priority: number;
  mountedAt: number;
}

const [scopes, setScopes] = createSignal<Map<string, NavScope>>(new Map());
let seq = 0;

function buildToken(scopeId: string): string {
  return `${scopeId}::${++seq}`;
}

function normalizePriority(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Mutators (low-level — most callers should use `useNavigationScope`)
// ---------------------------------------------------------------------------

export function registerScope(
  scopeId: string,
  options: { active?: boolean; priority?: number } = {},
): string {
  const token = buildToken(scopeId);
  const scope: NavScope = {
    id: scopeId,
    token,
    active: options.active !== false,
    priority: normalizePriority(options.priority),
    mountedAt: Date.now(),
  };
  setScopes((prev) => {
    const next = new Map(prev);
    next.set(token, scope);
    return next;
  });
  return token;
}

export function updateScope(
  token: string,
  patch: Partial<Pick<NavScope, "active" | "priority">>,
): void {
  setScopes((prev) => {
    const existing = prev.get(token);
    if (!existing) return prev;
    const next = new Map(prev);
    next.set(token, {
      ...existing,
      ...patch,
      priority:
        patch.priority !== undefined
          ? normalizePriority(patch.priority, existing.priority)
          : existing.priority,
    });
    return next;
  });
}

export function unregisterScope(token: string): void {
  setScopes((prev) => {
    if (!prev.has(token)) return prev;
    const next = new Map(prev);
    next.delete(token);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Reactive readers
// ---------------------------------------------------------------------------
//
// Memos live for the lifetime of the app, so we wrap them in a root to
// give Solid an owner. Without the root Solid logs:
//   "computations created outside a createRoot or render will never be
//    disposed"
// They'd still work, but the warning was masking real issues during dev.

const { activeScopes, topScope, topScopeId } = createRoot(() => {
  const activeScopes = createMemo<NavScope[]>(() => {
    const arr = Array.from(scopes().values()).filter((s) => s.active);
    arr.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.mountedAt - a.mountedAt;
    });
    return arr;
  });

  const topScope = createMemo<NavScope | null>(
    () => activeScopes()[0] ?? null,
  );

  const topScopeId = createMemo<string | null>(
    () => topScope()?.id ?? null,
  );

  return { activeScopes, topScope, topScopeId };
});

export { activeScopes, topScope, topScopeId };

export function canHandleToken(token: string | null): boolean {
  if (!token) return false;
  const top = topScope();
  if (!top) return true; // empty stack — anyone may handle
  return top.token === token;
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

function shouldDebug(): boolean {
  try {
    return localStorage.getItem(NAV_DEBUG_FLAG) === "1";
  } catch {
    return false;
  }
}

export function traceKeyRoute(args: {
  key: string;
  scopeId: string;
  handled: boolean;
  nextScopeId?: string | null;
}): void {
  if (!shouldDebug()) return;
  // eslint-disable-next-line no-console
  console.log("[NavController] key-route", {
    ...args,
    topScopeId: topScopeId(),
  });
}

// ---------------------------------------------------------------------------
// Component-side helper
// ---------------------------------------------------------------------------

/**
 * Register a scope for the lifetime of the calling component.
 *
 * Returns:
 *   isScopeOwner — reactive accessor; true while this scope is on top of
 *                  the stack
 *   topScopeId   — reactive accessor for the global top scope id
 *   setActive    — toggle the active flag (e.g., when a modal opens/closes)
 *   setPriority  — change the priority (rare — usually static at register)
 */
export function useNavigationScope(
  scopeId: string,
  initial: { active?: boolean; priority?: number } = {},
): {
  isScopeOwner: () => boolean;
  topScopeId: () => string | null;
  setActive: (active: boolean) => void;
  setPriority: (priority: number) => void;
} {
  const token = registerScope(scopeId, initial);
  onCleanup(() => unregisterScope(token));

  const isScopeOwner = createMemo<boolean>(() => canHandleToken(token));

  return {
    isScopeOwner,
    topScopeId,
    setActive: (active: boolean) => updateScope(token, { active }),
    setPriority: (priority: number) => updateScope(token, { priority }),
  };
}
