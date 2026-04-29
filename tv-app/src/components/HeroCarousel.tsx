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
  onMount,
  on,
  Show,
  For,
  type JSX,
} from "solid-js";
import Hls from "hls.js";
import NativePreviewSurface from "./NativePreviewSurface";
import { isNativePlayerAvailable } from "../lib/nativePlayer";

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
  /**
   * Live native preview URL — when provided AND running on Tauri
   * Android, replaces the WebView <video> preview path with a
   * floating ExoPlayer surface (NativePreviewSurface). Used by
   * the Live page hero. Browser dev / desktop / VOD flows ignore
   * this prop and fall through to the standard <PreviewVideo>.
   */
  nativePreviewUrl?: string | null;
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

        {/*
          Native inline preview (Live hero on Tauri Android) takes
          priority — IPTV providers don't send CORS so the WebView
          <video> path can't load live URLs. We render a transparent
          slot in the same DOM position so the layout stays
          identical; the actual ExoPlayer renders behind via
          addContentView at the slot's viewport coordinates.
        */}
        <Show when={props.nativePreviewUrl && isNativePlayerAvailable()}>
          <div class="hp-hero-preview">
            <NativePreviewSurface
              url={props.nativePreviewUrl!}
              active={previewEnabled()}
              muted={true}
              style={{ width: "100%", height: "100%" }}
            />
          </div>
        </Show>
        <Show
          when={
            !(props.nativePreviewUrl && isNativePlayerAvailable()) &&
            previewEnabled() &&
            showPreview() &&
            activePreviewClip()?.url
          }
        >
          <div class="hp-hero-preview">
            <PreviewVideo
              url={activePreviewClip()!.url!}
              startAtSec={activePreviewClip()!.startAtSec ?? 300}
              onReady={(handle) => {
                previewPlayer = handle;
              }}
            />
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

        {/* Navigation UI (dots only — arrows removed; D-pad ←/→ on the
            hero handles paging, mouse users get the dots). */}
        <Show when={props.onNavigate && total() > 1}>
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

// ---------------------------------------------------------------------------
// PreviewVideo — inline muted-autoplay element that drives the hero clip.
//
// Lives here (vs the full MediaPlayer) because it has very different
// requirements: muted, no controls, fire-and-forget, fast tear-down. Mounts
// fresh on each clip change — simpler than swapping sources, and the
// HeroCarousel's previewSwitchReq epoch debounces rapid focus changes so
// we're not actually re-mounting on every keystroke.
// ---------------------------------------------------------------------------

function PreviewVideo(props: {
  url: string;
  startAtSec: number;
  onReady: (h: VideoPlayerHandle) => void;
}): JSX.Element {
  let videoEl: HTMLVideoElement | undefined;
  let hls: Hls | null = null;
  // Tracks whether the underlying <video> is actually producing frames.
  // Drives the loading spinner overlay below — visible from mount until
  // the first `playing` event, and re-shown if the stream stalls.
  const [playing, setPlaying] = createSignal(false);

  onMount(() => {
    if (!videoEl) return;
    const url = props.url;
    const looksHls = /\.m3u8(\?|$)/i.test(url);
    const canNative = videoEl.canPlayType("application/vnd.apple.mpegurl");

    if (looksHls && Hls.isSupported() && !canNative) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(url);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoEl?.play().catch(() => {
          /* autoplay blocked — preview just stays paused */
        });
      });
    } else {
      videoEl.src = url;
      videoEl.play().catch(() => {});
    }

    props.onReady({
      destroy: () => {
        if (hls) {
          try {
            hls.destroy();
          } catch {
            /* ignore */
          }
          hls = null;
        }
      },
      stop: () => {
        try {
          videoEl?.pause();
        } catch {
          /* ignore */
        }
      },
      seekTo: (sec: number) => {
        if (videoEl) {
          try {
            videoEl.currentTime = Math.max(0, sec);
          } catch {
            /* seek may fail on live streams — silent */
          }
        }
      },
    });
  });

  onCleanup(() => {
    if (hls) {
      try {
        hls.destroy();
      } catch {
        /* ignore */
      }
      hls = null;
    }
  });

  // The wrapper is required by the lifted hero.css —
  // `.sp-browser:not(.live-page) .hp-hero-preview .video-player-wrapper`
  // sets width:80%, anchors right, and paints the left/bottom fade
  // gradients via ::before / ::after pseudo elements. Without it the
  // video fills the entire hero with no fade.
  return (
    <div class="video-player-wrapper">
      <video
        ref={(el) => (videoEl = el)}
        class="hp-hero-preview-video"
        autoplay
        playsinline
        onPlaying={() => setPlaying(true)}
        onWaiting={() => setPlaying(false)}
        onStalled={() => setPlaying(false)}
        onEmptied={() => setPlaying(false)}
      />
      <Show when={!playing()}>
        <div class="hp-hero-preview-spinner">
          <div class="hp-spinner" />
        </div>
      </Show>
    </div>
  );
}
