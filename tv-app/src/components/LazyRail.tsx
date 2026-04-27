import {
  createResource,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
} from "solid-js";
import Rail from "./Rail";

/**
 * Rail that fetches its data only when its container is about to scroll
 * into view. Used by the genre-rails layout where 25+ genres would
 * otherwise issue 25+ requests on mount.
 *
 * The fetcher runs whenever:
 *   - the rail becomes visible (via IntersectionObserver, root margin
 *     400px so the data lands before the rail is on screen)
 *   - the `reactiveKey` changes (e.g. the user picks a different sort)
 *
 * `reactiveKey` is just an opaque value used to invalidate the
 * Resource — its identity matters, not its type. Stringify the
 * relevant inputs into it (e.g. `${sortValue}`).
 */
export interface LazyRailProps<T> {
  title: string;
  fetch: () => Promise<T[]>;
  reactiveKey: () => unknown;
  isFocused: () => boolean;
  selectedIndex: () => number;
  renderItem: (item: T, focused: boolean, index: number) => JSX.Element;
  /** Forwarded ref so the parent page can scroll-to-rail on focus change. */
  ref?: (el: HTMLDivElement) => void;
  emptyLabel?: string;
}

export default function LazyRail<T>(props: LazyRailProps<T>) {
  const [visible, setVisible] = createSignal(false);

  let observerEl: HTMLDivElement | undefined;

  onMount(() => {
    if (!observerEl) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
          }
        }
      },
      { rootMargin: "400px" },
    );
    obs.observe(observerEl);
    onCleanup(() => obs.disconnect());
  });

  const [data] = createResource(
    () => (visible() ? props.reactiveKey() : null),
    () => props.fetch(),
  );

  return (
    <div
      ref={(el) => {
        observerEl = el;
        props.ref?.(el);
      }}
      class="min-h-[260px]"
    >
      <Rail
        title={props.title}
        items={data() ?? []}
        selectedIndex={props.selectedIndex}
        isFocused={props.isFocused}
        renderItem={props.renderItem}
        emptyLabel={
          data.loading ? "Loading…" : props.emptyLabel ?? "Nothing here yet."
        }
      />
    </div>
  );
}
