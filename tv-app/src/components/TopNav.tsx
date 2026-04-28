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
import { SearchIcon, UserIcon } from "./icons";
import logoUrl from "/128x128@2x.png?url";

interface NavTab {
  label: string;
  path: string;
  /** When set, the tab renders this icon instead of the text label and
   *  groups itself onto the right-hand side of the bar (after the
   *  spacer). Search + Profile use this. */
  icon?: () => JSX.Element;
}

const TABS: NavTab[] = [
  { label: "Home", path: "/home" },
  { label: "Live", path: "/live" },
  { label: "Movies", path: "/movies" },
  { label: "Series", path: "/series" },
  { label: "Search", path: "/search", icon: () => <SearchIcon /> },
  { label: "Profile", path: "/profile", icon: () => <UserIcon /> },
];

/** First index of the icon group — everything from this index onwards
 *  is rendered after the flex spacer (right-aligned). */
const ICON_GROUP_START = TABS.findIndex((t) => !!t.icon);

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

  // Whenever the URL changes, point `focused` at the matching tab.
  createEffect(() => {
    const path = location.pathname;
    const idx = TABS.findIndex((t) => path.startsWith(t.path));
    if (idx >= 0) setFocused(idx);
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
        setFocused((i) => Math.min(i + 1, TABS.length - 1));
        break;
      case "ArrowDown":
        setAppShellZone("content");
        break;
      case "Enter":
      case " ":
        navigate(TABS[focused()].path);
        setAppShellZone("content");
        break;
    }
  }

  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  // Active path tab — for the always-on highlight (independent of focus)
  const activeIdx = createMemo(() =>
    TABS.findIndex((t) => location.pathname.startsWith(t.path)),
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
      <For each={TABS}>
        {(tab, i) => {
          const isFocused = () =>
            appShellZone() === "nav" && focused() === i();
          const isActive = () => activeIdx() === i();
          const isIcon = !!tab.icon;
          // First icon-group item gets pushed to the right via
          // ml-auto; subsequent icon-group items follow naturally.
          const isFirstIcon = i() === ICON_GROUP_START;
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
                isFirstIcon ? "ml-auto" : ""
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
