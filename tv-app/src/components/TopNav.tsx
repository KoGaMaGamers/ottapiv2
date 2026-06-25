import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { appShellZone, setAppShellZone } from "../stores/shell";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";
import { getShowAdultContent } from "../lib/clientPreferences";
import { SearchIcon, UserIcon } from "./icons";
import logoUrl from "/128x128@2x.png?url";

const PIN_KEY = "ott_parental_pin";

/** Fired by Profile when the "Show Adult content" toggle or the PIN changes,
 *  so the (non-reactive localStorage-backed) Adult tab updates without reload. */
export const ADULT_VISIBILITY_EVENT = "adult-visibility-changed";

interface NavTab {
  label: string;
  path: string;
  /** When set, the tab renders this icon instead of the text label and
   *  groups itself onto the right-hand side of the bar (after the
   *  spacer). Search + Profile use this. */
  icon?: () => JSX.Element;
}

// Static tabs, split so the conditional "Adult" tab can be inserted at the end
// of the text group (just before the right-aligned icon group).
const TEXT_TABS: NavTab[] = [
  { label: "Home", path: "/home" },
  { label: "Live", path: "/live" },
  { label: "Movies", path: "/movies" },
  { label: "Series", path: "/series" },
];
const ICON_TABS: NavTab[] = [
  { label: "Search", path: "/search", icon: () => <SearchIcon /> },
  { label: "Profile", path: "/profile", icon: () => <UserIcon /> },
];
const ADULT_TAB: NavTab = { label: "Adult", path: "/adult" };

/** The Adult tab shows only when the user opted in AND a parental PIN exists
 *  (no PIN ⇒ hidden regardless of the toggle). */
function adultMenuVisible(): boolean {
  return getShowAdultContent() && !!localStorage.getItem(PIN_KEY);
}

/**
 * Top navigation strip. D-pad-active when `appShellZone() === "nav"`.
 *
 * Left/Right cycle through tabs (no wrap), Enter activates the current
 * tab (navigates + drops back to "content"), Down also drops to
 * "content" without navigating (lets user dismiss the nav and resume
 * page work).
 *
 * The "currently active" highlight tracks the URL — so opening
 * /movies/:id keeps the Movies tab lit even on the detail page.
 */
export default function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [focused, setFocused] = createSignal(0);

  // Priority needs to beat any page scope (pages register at 30) so
  // that when appShellZone flips to "nav", the scope-stack actually
  // hands input ownership to TopNav. Without this, the visual nav
  // highlight tracked the zone signal but ←/→ keys still went to the
  // page handler (which had higher priority and silently swallowed
  // them) — user could see Movies/Live/Profile lit up but couldn't
  // move between tabs. The active flag still gates whether the scope
  // exists in the stack at all, so a high priority is harmless when
  // the user's not in nav mode.
  const { isScopeOwner, setActive } = useNavigationScope("topnav", {
    priority: 100,
    active: appShellZone() === "nav",
  });

  // Mirror the shell signal into the scope's active flag.
  createEffect(() => setActive(appShellZone() === "nav"));

  // localStorage / clientPreferences aren't reactive — re-read the Adult-tab
  // visibility on mount, on cross-tab `storage` events, and on the custom
  // event Profile dispatches when the toggle or PIN changes.
  const [showAdult, setShowAdult] = createSignal(adultMenuVisible());
  const refreshAdult = () => setShowAdult(adultMenuVisible());
  onMount(() => {
    window.addEventListener("storage", refreshAdult);
    window.addEventListener(ADULT_VISIBILITY_EVENT, refreshAdult);
  });
  onCleanup(() => {
    window.removeEventListener("storage", refreshAdult);
    window.removeEventListener(ADULT_VISIBILITY_EVENT, refreshAdult);
  });

  // The live tab list: text tabs, optional Adult tab, then the icon group.
  const tabs = createMemo<NavTab[]>(() => [
    ...TEXT_TABS,
    ...(showAdult() ? [ADULT_TAB] : []),
    ...ICON_TABS,
  ]);
  const iconGroupStart = createMemo(() => tabs().findIndex((t) => !!t.icon));

  // Whenever the URL changes (or the tab set changes), point `focused` at the
  // matching tab. Also re-evaluate Adult visibility on navigation (e.g. after
  // leaving Profile).
  createEffect(() => {
    const path = location.pathname;
    refreshAdult();
    const idx = tabs().findIndex((t) => path.startsWith(t.path));
    if (idx >= 0) setFocused(idx);
  });

  // Keep focus in range if the tab set shrinks (Adult tab removed).
  createEffect(() => {
    const n = tabs().length;
    if (focused() > n - 1) setFocused(n - 1);
  });

  function onKey(e: KeyboardEvent) {
    if (!isScopeOwner()) return;
    if (!isDirectionalKey(e.key) && !isSelectKey(e.key)) return;
    e.preventDefault();
    switch (e.key) {
      case "ArrowLeft":
        setFocused((i) => Math.max(i - 1, 0));
        break;
      case "ArrowRight":
        setFocused((i) => Math.min(i + 1, tabs().length - 1));
        break;
      case "ArrowDown":
        setAppShellZone("content");
        break;
      case "Enter":
      case " ":
        navigate(tabs()[focused()].path);
        setAppShellZone("content");
        break;
    }
  }

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // Active path tab — for the always-on highlight (independent of focus)
  const activeIdx = createMemo(() =>
    tabs().findIndex((t) => location.pathname.startsWith(t.path)),
  );

  return (
    // Fixed (not sticky) so the page content can extend behind the
    // bar — Home's hero / preview / poster fills the viewport with
    // the nav floating on top. The black→transparent gradient gives
    // enough contrast for the brand + tab labels without the heavy
    // backdrop-blur slab the nav had before.
    <nav
      class="fixed top-0 left-0 right-0 z-30 flex items-center gap-1 px-6 py-3 bg-gradient-to-b from-black/65 via-black/30 to-transparent"
    >
      <div class="mr-4 flex items-center gap-2">
        <img
          src={logoUrl}
          alt=""
          class="h-7 w-7 rounded-md"
          draggable={false}
        />
        <span class="text-zinc-100 font-semibold tracking-wide">
          Symbioplayer
        </span>
      </div>
      <For each={tabs()}>
        {(tab, i) => {
          const isFocused = () =>
            appShellZone() === "nav" && focused() === i();
          const isActive = () => activeIdx() === i();
          const isIcon = !!tab.icon;
          // First icon-group item gets pushed to the right via
          // ml-auto; subsequent icon-group items follow naturally.
          const isFirstIcon = () => i() === iconGroupStart();
          return (
            <button
              onClick={() => {
                setFocused(i());
                navigate(tab.path);
                setAppShellZone("content");
              }}
              title={tab.label}
              aria-label={tab.label}
              class={`${isIcon ? "p-2 text-base" : "px-3 py-1.5 text-sm"} rounded-md font-medium outline-none transition-colors ${
                isFirstIcon() ? "ml-auto" : ""
              } ${
                isActive() ? "text-white" : "text-zinc-400 hover:text-zinc-200"
              } ${
                isFocused()
                  ? "bg-violet-600/30 ring-1 ring-violet-400"
                  : ""
              }`}
            >
              {isIcon ? tab.icon!() : tab.label}
            </button>
          );
        }}
      </For>
    </nav>
  );
}
