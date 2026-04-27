import { createEffect, createSignal, For, JSX, onCleanup, Show } from "solid-js";

/**
 * Auto-advancing hero banner at the top of content pages.
 *
 * Pure presentational: the parent supplies the items and may control
 * the active index (controlled mode) or let the hero auto-advance
 * (uncontrolled mode, default 7 s per slide). Auto-advance pauses
 * while the hero is the focused region (so the user has time to
 * press Play).
 *
 * Preview-clip playback (legacy `tv_app_v2/components/HeroCarousel.jsx`)
 * lands later when the player layer is ready — for now we render a
 * static backdrop + title + plot + CTAs.
 */

export interface HeroItem {
  id: string | number;
  title: string;
  subtitle?: string | null;
  /** Wide backdrop image — renders behind the gradient. */
  backdrop?: string | null;
  /** Optional portrait poster (shown floating over the backdrop). */
  poster?: string | null;
  /** Optional CSS gradient string for the backdrop overlay. */
  gradient?: string;
  /** Plot / synopsis line. */
  plot?: string | null;
  /** Inline meta badges — e.g. <span>2024</span><span>★ 7.4</span>. */
  meta?: JSX.Element;
  /** Right-aligned chip row (genre tags etc.). */
  tags?: string[];
}

export interface HeroAction {
  label: string;
  onClick: () => void;
  /** When true, render with the accent (violet) color. Default for the first action. */
  primary?: boolean;
}

export interface HeroCarouselProps {
  items: HeroItem[];
  /** Optional controlled active index. If omitted, the carousel manages its own. */
  activeIndex?: () => number;
  onIndexChange?: (idx: number) => void;
  /** Auto-advance interval in ms. Set to 0 to disable. */
  intervalMs?: number;
  /** Pause auto-advance while this returns true (typically the hero scope is focused). */
  paused?: () => boolean;
  /** Up-to-2 CTAs rendered under the title. */
  actions?: HeroAction[];
  /** Whether the hero zone is the focused region — affects subtle styling. */
  isFocused?: () => boolean;
}

const DEFAULT_INTERVAL = 7000;

export default function HeroCarousel(props: HeroCarouselProps) {
  const [internalIndex, setInternalIndex] = createSignal(0);
  const index = () =>
    props.activeIndex ? props.activeIndex() : internalIndex();
  const total = () => props.items.length;
  const active = () => props.items[index()] ?? null;

  function setIndex(next: number) {
    if (props.activeIndex) {
      props.onIndexChange?.(next);
    } else {
      setInternalIndex(next);
      props.onIndexChange?.(next);
    }
  }

  // Auto-advance loop.
  createEffect(() => {
    const interval = props.intervalMs ?? DEFAULT_INTERVAL;
    if (interval <= 0 || total() <= 1) return;
    if (props.paused?.()) return;

    const t = window.setInterval(() => {
      const cur = props.activeIndex ? props.activeIndex() : internalIndex();
      const next = (cur + 1) % total();
      setIndex(next);
    }, interval);
    onCleanup(() => clearInterval(t));
  });

  return (
    <Show when={total() > 0}>
      <section
        class={`relative h-[55vh] min-h-[380px] overflow-hidden ${
          props.isFocused?.() ? "ring-1 ring-violet-500/30" : ""
        }`}
      >
        {/* Stack all backdrops; cross-fade by toggling opacity on the active one. */}
        <For each={props.items}>
          {(item, i) => (
            <div
              class={`absolute inset-0 transition-opacity duration-700 ${
                i() === index() ? "opacity-100" : "opacity-0"
              }`}
            >
              {item.backdrop && (
                <img
                  src={item.backdrop}
                  alt=""
                  class="w-full h-full object-cover"
                />
              )}
              <div
                class="absolute inset-0"
                style={{
                  background:
                    item.gradient ??
                    "linear-gradient(90deg, rgba(11,11,11,0.95) 0%, rgba(11,11,11,0.6) 50%, rgba(11,11,11,0.85) 100%)",
                }}
              />
              <div class="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#0b0b0b] to-transparent" />
            </div>
          )}
        </For>

        {/* Foreground content for the active item. */}
        <Show when={active()}>
          {(it) => (
            <div class="relative z-10 h-full flex items-end px-8 pb-12 max-w-[60%]">
              <div>
                {it().meta && (
                  <div class="mb-2 flex gap-2 text-xs text-zinc-400">
                    {it().meta}
                  </div>
                )}
                <h1 class="text-4xl font-semibold mb-2">{it().title}</h1>
                <Show when={it().subtitle}>
                  {(s) => <p class="text-zinc-400 mb-3">{s()}</p>}
                </Show>
                <Show when={it().plot}>
                  {(p) => (
                    <p class="text-sm text-zinc-300 line-clamp-3 mb-4">
                      {p()}
                    </p>
                  )}
                </Show>
                <Show when={it().tags && it().tags!.length > 0}>
                  <div class="flex gap-2 mb-5">
                    <For each={it().tags}>
                      {(t) => (
                        <span class="text-xs px-2 py-0.5 rounded-full bg-zinc-800/80 ring-1 ring-zinc-700">
                          {t}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={props.actions && props.actions.length > 0}>
                  <div class="flex gap-3">
                    <For each={props.actions}>
                      {(action, i) => (
                        <button
                          onClick={action.onClick}
                          class={`rounded-md px-5 py-2 text-sm font-medium transition-colors outline-none ${
                            action.primary || i() === 0
                              ? "bg-violet-600 hover:bg-violet-500 text-white"
                              : "bg-zinc-800/80 hover:bg-zinc-700 ring-1 ring-zinc-700"
                          }`}
                        >
                          {action.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>
          )}
        </Show>

        {/* Dot indicators */}
        <Show when={total() > 1}>
          <div class="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex gap-1.5">
            <For each={props.items}>
              {(_, i) => (
                <button
                  aria-label={`Go to slide ${i() + 1}`}
                  onClick={() => setIndex(i())}
                  class={`w-1.5 h-1.5 rounded-full transition-colors ${
                    i() === index()
                      ? "bg-violet-400"
                      : "bg-zinc-600 hover:bg-zinc-500"
                  }`}
                />
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}
