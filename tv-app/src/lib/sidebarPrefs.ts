/**
 * Sidebar collapsed-state persistence.
 *
 * Shared across Movies + Series pages so toggling on one persists
 * when the user navigates to the other; written to localStorage on
 * every change so reload remembers the choice.
 */

import { createSignal } from "solid-js";

const KEY = "ott_sidebar_open_v1";

function loadInitial(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === null) return true; // default: open
    return v === "1";
  } catch {
    return true;
  }
}

const [sidebarOpen, _setSidebarOpen] = createSignal<boolean>(loadInitial());

export function setSidebarOpen(open: boolean): void {
  _setSidebarOpen(open);
  try {
    localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export { sidebarOpen };
