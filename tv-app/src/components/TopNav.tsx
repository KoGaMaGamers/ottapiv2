import { createEffect, createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { appShellZone, setAppShellZone } from "../stores/shell";
import { useNavigationScope } from "../lib/navigation";
import { isDirectionalKey, isSelectKey } from "../lib/navigationKeys";

interface NavTab {
  label: string;
  path: string;
}

const TABS: NavTab[] = [
  { label: "Home", path: "/home" },
  { label: "Live", path: "/live" },
  { label: "Movies", path: "/movies" },
  { label: "Series", path: "/series" },
  { label: "Search", path: "/search" },
  { label: "Profile", path: "/profile" },
];

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

  const { isScopeOwner, setActive } = useNavigationScope("topnav", {
    priority: 0,
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
    <nav
      class={`sticky top-0 z-30 flex items-center gap-1 px-6 py-3 bg-zinc-950/85 backdrop-blur-md border-b transition-colors ${
        appShellZone() === "nav" ? "border-violet-500/40" : "border-zinc-900"
      }`}
    >
      <span class="mr-4 text-violet-400 font-semibold tracking-wide">OTT</span>
      <For each={TABS}>
        {(tab, i) => {
          const isFocused = () =>
            appShellZone() === "nav" && focused() === i();
          const isActive = () => activeIdx() === i();
          return (
            <button
              onClick={() => {
                setFocused(i());
                navigate(tab.path);
                setAppShellZone("content");
              }}
              class={`px-3 py-1.5 rounded-md text-sm font-medium outline-none transition-colors ${
                isActive()
                  ? "text-white"
                  : "text-zinc-400 hover:text-zinc-200"
              } ${
                isFocused()
                  ? "bg-violet-600/30 ring-1 ring-violet-400"
                  : ""
              }`}
            >
              {tab.label}
            </button>
          );
        }}
      </For>
    </nav>
  );
}
