import { createEffect, For, type JSX, Show } from "solid-js";

export interface SidebarItem {
  id: string | number;
  label: string;
  count?: number | null;
  icon?: JSX.Element;
}

/**
 * Vertical D-pad-navigable sidebar. Pure presentational — parent owns
 * `activeId` (currently selected category) and `focusedIdx` (D-pad
 * cursor) and forwards key events; this component just paints the
 * three states (active / focused / idle).
 *
 * Used by Movies, Series, Live (with `headerSlot` for the back button)
 * and Profile pages.
 */
export interface SidebarProps {
  title?: string;
  /** Render an arbitrary node in place of the default title (e.g. back button). */
  headerSlot?: JSX.Element;
  items: SidebarItem[];
  /** id of the currently SELECTED category (red bg). */
  activeId: () => string | number | null;
  /** Index of the D-pad cursor (white border). -1 to hide. */
  focusedIdx: () => number;
  /** True when the sidebar zone is the active region (subtle bg highlight). */
  isFocused: () => boolean;
  onSelect?: (item: SidebarItem, index: number) => void;
  emptyLabel?: string;
  class?: string;
}

export default function Sidebar(props: SidebarProps) {
  let listRef: HTMLDivElement | undefined;
  let activeRef: HTMLDivElement | undefined;

  // Auto-scroll the focused row into view (legacy behavior). Track
  // focusedIdx to re-run; don't bind the result.
  createEffect(() => {
    props.focusedIdx();
    if (activeRef) {
      activeRef.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  return (
    <aside
      class={`flex flex-col w-64 h-full border-r border-zinc-800 transition-colors ${
        props.isFocused() ? "bg-zinc-900/60" : "bg-zinc-950"
      } ${props.class ?? ""}`}
    >
      <div class="px-4 py-3 border-b border-zinc-800">
        {props.headerSlot ?? (
          <h2 class="text-sm font-medium text-zinc-400">{props.title}</h2>
        )}
      </div>

      <div ref={listRef} class="flex-1 overflow-y-auto py-2">
        <Show
          when={props.items.length > 0}
          fallback={
            <p class="px-4 py-2 text-sm text-zinc-600">
              {props.emptyLabel ?? "Nothing here"}
            </p>
          }
        >
          <For each={props.items}>
            {(item, i) => {
              const isFocused = () =>
                props.isFocused() && props.focusedIdx() === i();
              const isActive = () =>
                props.activeId() != null &&
                String(item.id) === String(props.activeId());

              return (
                <div
                  ref={(el) => {
                    if (isFocused()) activeRef = el;
                  }}
                  onClick={() => props.onSelect?.(item, i())}
                  class={`flex items-center gap-2 px-4 py-2 cursor-pointer text-sm transition-colors ${
                    isActive()
                      ? "bg-violet-600/30 text-violet-200"
                      : "text-zinc-400"
                  } ${
                    isFocused()
                      ? "ring-1 ring-violet-400 ring-inset bg-zinc-800/50"
                      : ""
                  } hover:text-zinc-200`}
                >
                  {item.icon && (
                    <span class="shrink-0 w-5 text-center">{item.icon}</span>
                  )}
                  <span class="flex-1 truncate">{item.label}</span>
                  {item.count != null && (
                    <span class="shrink-0 text-xs text-zinc-600">
                      {item.count.toLocaleString()}
                    </span>
                  )}
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </aside>
  );
}
