/**
 * Shell-level focus signal.
 *
 * Pages and the TopNav both register navigation scopes. Same priority
 * (0), so mountedAt would always favour the page (it mounts after).
 * To let the user "escape up" from a page into the nav and back, we
 * use this signal as the active-scope arbiter:
 *
 *   appShellZone() === "nav"     → TopNav scope is active
 *   appShellZone() === "content" → page scope is active
 *
 * Pages set "nav" when the user presses Up at their topmost zone.
 * TopNav sets "content" when the user presses Down (or activates a
 * link, which navigates and resets to "content").
 */

import { createSignal } from "solid-js";

export type AppShellZone = "nav" | "content";

const [appShellZone, setAppShellZone] = createSignal<AppShellZone>("content");

export { appShellZone, setAppShellZone };
