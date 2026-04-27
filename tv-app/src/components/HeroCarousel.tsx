/**
 * HeroCarousel — full-width hero section used at the top of content pages.
 *
 * Faithful Solid port of `tv_app_v2/src/components/HeroCarousel.jsx`. The
 * parent page owns timer / index / actions; this component is purely
 * presentational and fires callbacks for navigation. The CSS class names
 * (`hp-hero`, `hp-hero-bg`, `hp-badge`, …) are coupled to the lifted CSS
 * in `src/styles/hero.css`.
 *
 * Items shape — every entry must be a normalised object:
 *   {
 *     id, title,
 *     poster?, backdrop?, gradient, accent,
 *     badges?: { label, variant? }[],
 *     genres?: string[],
 *     plot?,
 *     primaryAction?:   { label, onClick, loading? },
 *     secondaryAction?: { label, onClick },
 *   }
 *
 * Preview-clip plumbing kept from the legacy:
 *   • The VideoPlayer slot stays mounted and we just switch source / seek
 *     target — avoids native detach/attach blink on the WebView.
 *   • A monotonically-increasing `previewSwitchReq` epoch guards stale
 *     timers when the user zaps quickly.
 *   • Hard-stop on unmount (.destroy + .stop), soft-stop on prop change
 *     (.stop only).
 *
 * NOTE: VideoPlayer hasn't been ported yet — the preview slot is wired
 * up but renders a placeholder. Once VideoPlayer lands the slot will
 * mount the real player and `previewPlayer` will hold its imperative
 * handle.
 */

import {
  createSignal,
  createEffect,
  createMemo,
  onCleanup,
  on,
  Show,
  For,
  type JSX,
} from "solid-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeroBadge {
  label: string;
  variant?: string;
}

export interface HeroAction {
  label: string;
  onClick: () => void;
  loading?: boolean;
}

export interface HeroItem {
  id: string | number;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  gradient: string;
  accent: string;
  badges?: HeroBadge[];
  genres?: string[];
  plot?: string | null;
  primaryAction?: HeroAction;
  secondaryAction?: HeroAction;
}

export interface PreviewClip {
  clipId?: string | number;
  url: string | null;
  startAtSec?: number;
  playForSec?: number | null;
  isLive?: boolean;
}

/**
 * Imperative handle exposed by the (future) VideoPlayer component. Kept
 * here as the same shape used by the legacy ref so wiring it up later
 * is a one-line change.
 */
export interface VideoPlayerHandle {
  destroy?: () => void;
  stop?: () => void;
  seekTo: (sec: number) => void;
}

export interface HeroCarouselProps {
  items: HeroItem[];
  activeIndex?: number;
  animKey?: number;
  onNavigate?: (newIndex: number) => void;
  className?: string;
  previewClip?: PreviewClip | null;
  previewEnabled?: boolean;
  focused?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HeroCarousel(props: HeroCarouselProps): JSX.Element {
  const items = () => props.items ?? [];
  const activeIndex = () => props.activeIndex ?? 0;
  const animKey = () => props.animKey ?? 0;
  const previewEnabled = () => props.previewEnabled ?? true;
  const className = () => props.className ?? "";
  const focused = () => props.focused ?? false;

  const total = () => items().length;
  const active = () => items()[activeIndex()];
  const isSeriesBrowserHero = () => className().includes("sp-browser-hero");

  // Cast on init so TS keeps the wider type inside closures — without
  // it, control-flow narrowing pins the variable to `null` and access
  // resolves to `never`.
  let previewPlayer = null as VideoPlayerHandle | null;
  let previewSwitchReq = 0;

  const [showPreview, setShowPreview] = createSignal(false);
  const [activePreviewClip, setActivePreviewClip] =
    createSignal<PreviewClip | null>(null);

  const previewActive = () => showPreview() && !!activePreviewClip()?.url;

  const prev = () => props.onNavigate?.((activeIndex() - 1 + total()) % total());
  const next = () => props.onNavigate?.((activeIndex() + 1) % total());

  const hardStopPreview = () => {
    previewPlayer?.destroy?.();
    previewPlayer?.stop?.();
    setShowPreview(false);
    setActivePreviewClip(null);
  };

  const softStopPreview = () => {
    previewPlayer?.stop?.();
    setShowPreview(false);
    setActivePreviewClip(null);
  };

  // Source-switch effect — equivalent to the deps array on the legacy
  // useEffect. We rebuild the signature whenever any of the watched
  // preview-clip fields change.
  createEffect(
    on(
      () => {
        const clip = props.previewClip;
        return [
          clip?.clipId,
          clip?.url,
          clip?.startAtSec,
          clip?.playForSec,
          clip?.isLive,
          previewEnabled(),
        ] as const;
      },
      () => {
        previewSwitchReq += 1;
        const reqId = previewSwitchReq;

        if (!previewEnabled()) {
          softStopPreview();
          return;
        }

        const clip = props.previewClip;
        if (!clip?.url) {
          softStopPreview();
          return;
        }

        // Keep the preview mounted and just switch source/seek target.
        // Avoids frequent native detach/attach cycles that can blink
        // the WebView on Fire TV.
        setActivePreviewClip(clip);
        setShowPreview(true);

        const t1 = window.setTimeout(() => {
          if (previewSwitchReq !== reqId) return;
          previewPlayer?.seekTo(clip.startAtSec ?? 300);
        }, 1200);

        const isContinuous = clip.isLive === true || clip.playForSec == null;
        const maxPlaySec = Math.max(1, Math.min(clip.playForSec ?? 40, 60));
        const t2 = isContinuous
          ? null
          : window.setTimeout(() => {
              if (previewSwitchReq !== reqId) return;
              softStopPreview();
            }, maxPlaySec * 1000);

        onCleanup(() => {
          clearTimeout(t1);
          if (t2 != null) clearTimeout(t2);
        });
      },
    ),
  );

  // Hard-stop on unmount.
  onCleanup(() => hardStopPreview());

  // Re-trigger the slide-in animation whenever animKey changes. `Show
  // keyed` re-creates the child subtree on every change of the `when`
  // value — equivalent to React's `key={animKey}` remount trick.
  const animBucket = createMemo(() => `anim-${animKey()}`);

  return (
    <Show when={total() > 0}>
      <section
        class={`hp-hero${className() ? ` ${className()}` : ""}${
          previewActive() ? " hp-hero--preview-playing" : ""
        }${focused() ? " hero-focused" : ""}`}
        style={{ "--accent": active()?.accent } as JSX.CSSProperties}
      >
        {/* Cross-fading gradient + backdrop layers */}
        <For each={items()}>
          {(item, i) => (
            <div
              class={`hp-hero-bg${i() === activeIndex() ? " active" : ""}`}
              style={{ background: item.gradient }}
            >
              <Show when={item.backdrop}>
                <img
                  src={item.backdrop!}
                  alt=""
                  class="sp-hero-backdrop"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display =
                      "none";
                  }}
                />
              </Show>
            </div>
          )}
        </For>

        <Show when={previewEnabled() && showPreview() && activePreviewClip()?.url}>
          <div class="hp-hero-preview">
            {/*
              Placeholder slot until VideoPlayer is ported. The wrapper
              keeps the layout (positioning + gradients defined in
              hero.css) so the surrounding hero looks correct in the
              meantime.
            */}
            <div class="video-player-wrapper" />
          </div>
        </Show>

        <div class="hp-hero-overlay" />

        {/* Portrait poster (right side decoration) */}
        <Show when={active()?.poster}>
          <div
            class={`hp-hero-poster${
              active()?.backdrop ? " sp-hero-poster--has-backdrop" : ""
            }`}
          >
            <img
              src={active()!.poster!}
              alt={active()!.title}
              class="hp-hero-poster-img"
              onError={(e) => {
                const parent = (e.currentTarget as HTMLImageElement)
                  .parentElement;
                if (parent) parent.style.display = "none";
              }}
            />
          </div>
        </Show>

        <Show when={isSeriesBrowserHero()}>
          <div class="hp-hero-bottom-fade" />
        </Show>

        {/* Text content block (re-animates when animKey changes).
            `Show keyed` requires the render fn to take the bucket value
            as a parameter — even though we don't use it, the parameter
            is what makes the typed overload resolve. */}
        <Show keyed when={animBucket()}>
          {(_bucket) => {
            const a = active();
            if (!a) return null;
            return (
              <div class="hp-hero-content">
                <Show when={(a.badges ?? []).length > 0}>
                  <div class="hp-hero-badges">
                    <For each={a.badges}>
                      {(b) => (
                        <span class={`hp-badge ${b.variant ?? ""}`}>
                          {b.label}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={(a.genres ?? []).length > 0}>
                  <div class="hp-hero-genres">
                    <For each={a.genres!.slice(0, 3)}>
                      {(g) => <span class="hp-genre-tag">{g}</span>}
                    </For>
                  </div>
                </Show>

                <h1 class="hp-hero-title">{a.title}</h1>

                <Show when={a.plot}>
                  <p class="hp-hero-plot">{a.plot}</p>
                </Show>

                <div class="hp-hero-actions">
                  <Show when={a.primaryAction}>
                    <button
                      class="hp-btn primary"
                      disabled={a.primaryAction!.loading}
                      onClick={a.primaryAction!.onClick}
                    >
                      {a.primaryAction!.loading
                        ? "⏳ Loading…"
                        : a.primaryAction!.label}
                    </button>
                  </Show>
                  <Show when={a.secondaryAction}>
                    <button
                      class="hp-btn secondary"
                      onClick={a.secondaryAction!.onClick}
                    >
                      {a.secondaryAction!.label}
                    </button>
                  </Show>
                </div>
              </div>
            );
          }}
        </Show>

        {/* Navigation UI (only when navigation is enabled) */}
        <Show when={props.onNavigate && total() > 1}>
          <button class="hp-hero-arrow left" onClick={prev}>
            ‹
          </button>
          <button class="hp-hero-arrow right" onClick={next}>
            ›
          </button>

          <div class="hp-hero-dots">
            <For each={items()}>
              {(_, i) => (
                <button
                  class={`hp-dot${i() === activeIndex() ? " active" : ""}`}
                  onClick={() => props.onNavigate?.(i())}
                />
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}
