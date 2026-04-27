import { For, type JSX, Show } from "solid-js";

/**
 * Horizontal scrolling rail. Pure presentational — it does NOT manage
 * its own keyboard input; parent pages own a single scope and dispatch
 * left/right within the active rail and up/down between rails.
 *
 * Usage from a page:
 *
 *   <Rail
 *     title="Continue Watching"
 *     items={items()}
 *     selectedIndex={() => railIndex()}
 *     isFocused={() => focusedRail() === RAIL_CONTINUE}
 *     renderItem={(item, focused) => (
 *       <PosterCard title={item.name} ... focused={() => focused} />
 *     )}
 *   />
 *
 * Each card scrolls itself into view via PosterCard's createEffect, so
 * Rail just needs to render them in document order.
 */
export interface RailProps<T> {
  title: string;
  items: T[];
  /** Index of the highlighted item within this rail. */
  selectedIndex: () => number;
  /** Is THIS rail the currently active one in the parent's focus model? */
  isFocused: () => boolean;
  /** Render function — receives item + whether this individual item is focused. */
  renderItem: (item: T, focused: boolean, index: number) => JSX.Element;
  /** Optional right-aligned action (e.g., "See all" link). */
  trailing?: JSX.Element;
  /** Empty-state fallback. */
  emptyLabel?: string;
}

export default function Rail<T>(props: RailProps<T>) {
  return (
    <section class="mb-8">
      <div class="flex items-baseline justify-between px-8 mb-2">
        <h2
          class={`text-lg font-medium transition-colors ${
            props.isFocused() ? "text-white" : "text-zinc-300"
          }`}
        >
          {props.title}
        </h2>
        <Show when={props.trailing}>{props.trailing}</Show>
      </div>

      <Show
        when={props.items.length > 0}
        fallback={
          <p class="px-8 text-sm text-zinc-600">
            {props.emptyLabel ?? "Nothing here yet."}
          </p>
        }
      >
        <div class="flex gap-3 px-8 overflow-x-auto scrollbar-none scroll-smooth">
          <For each={props.items}>
            {(item, idx) =>
              props.renderItem(
                item,
                props.isFocused() && props.selectedIndex() === idx(),
                idx(),
              )
            }
          </For>
        </div>
      </Show>
    </section>
  );
}
