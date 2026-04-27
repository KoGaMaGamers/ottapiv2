/**
 * Sidebar — vertical D-pad-navigable category list.
 *
 * Faithful Solid port of the legacy `Sidebar.jsx` (the canonical shared
 * component used by Movies, Series, Live). Pure presentational — the
 * parent owns `activeId` (selected category, red bg) and `focusedIdx`
 * (D-pad cursor, white border) and forwards key events. This component
 * only paints the three states (active / focused / idle).
 *
 * The legacy CSS classes are coupled here:
 *   .sidebar / .sidebar--focused
 *   .sidebar-hdr / .sidebar-title
 *   .sidebar-list
 *   .sidebar-item / .sidebar-item.focused / .sidebar-item.active
 *   .sidebar-item-icon / .sidebar-item-label / .sidebar-item-count
 *   .sidebar-empty
 *   .sp-series-sidebar / .sp-series-sidebar--collapsed (Movies/Series)
 */

import { createEffect, For, Show, type JSX } from "solid-js";

export interface SidebarItem {
  id: string | number;
  label: string;
  count?: number | null;
  icon?: JSX.Element;
}

export interface SidebarProps {
  title?: string;
  /** Render an arbitrary node in place of the default title (e.g. a back button). */
  headerSlot?: JSX.Element;
  items: SidebarItem[];
  /** id of the currently SELECTED item (red bg). */
  activeId: () => string | number | null;
  /** Index of the D-pad cursor (white border). -1 to hide. */
  focusedIdx: () => number;
  /** True when the sidebar zone owns input (subtle bg highlight). */
  isFocused: () => boolean;
  onSelect?: (item: SidebarItem, index: number) => void;
  emptyLabel?: string;
  /**
   * Variant class for page-specific behaviour. Movies / Series pages
   * pass `"sp-series-sidebar"` and toggle the
   * `sp-series-sidebar--collapsed` modifier via `collapsed`. Pure
   * className passthrough — keeps CSS targeting in stylesheets.
   */
  class?: string;
  /** Apply the `--collapsed` modifier (slides off-screen). */
  collapsed?: () => boolean;
}

export default function Sidebar(props: SidebarProps): JSX.Element {
  let listRef: HTMLDivElement | undefined;

  // Auto-scroll the focused row into view (legacy behaviour).
  createEffect(() => {
    const i = props.focusedIdx();
    if (!props.isFocused() || !listRef) return;
    const child = listRef.children[i] as HTMLElement | undefined;
    child?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  const rootClass = (): string => {
    const parts = ["sidebar"];
    if (props.isFocused()) parts.push("sidebar--focused");
    if (props.class) parts.push(props.class);
    if (props.collapsed?.() && props.class?.includes("sp-series-sidebar")) {
      parts.push("sp-series-sidebar--collapsed");
    }
    return parts.join(" ");
  };

  return (
    <aside class={rootClass()}>
      <div class="sidebar-hdr">
        {props.headerSlot ?? (
          <h2 class="sidebar-title">{props.title ?? ""}</h2>
        )}
      </div>

      <div ref={(el) => (listRef = el)} class="sidebar-list">
        <Show
          when={props.items.length > 0}
          fallback={
            <p class="sidebar-empty">
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
              const cls = () => {
                const c = ["sidebar-item"];
                if (isFocused()) c.push("focused");
                if (isActive()) c.push("active");
                return c.join(" ");
              };
              return (
                <div
                  class={cls()}
                  onClick={() => props.onSelect?.(item, i())}
                >
                  <Show when={item.icon}>
                    <span class="sidebar-item-icon">{item.icon}</span>
                  </Show>
                  <span class="sidebar-item-label">{item.label}</span>
                  <Show when={item.count != null}>
                    <span class="sidebar-item-count">
                      {item.count!.toLocaleString()}
                    </span>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </aside>
  );
}
