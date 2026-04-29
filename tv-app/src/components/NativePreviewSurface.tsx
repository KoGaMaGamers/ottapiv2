/**
 * NativePreviewSurface — Solid wrapper over the native-player plugin's
 * inline preview API.
 *
 * Renders an empty positioned div whose getBoundingClientRect() drives
 * the floating native ExoPlayer surface beneath the WebView. The DOM
 * div itself has no visual content (the ExoPlayer renders BEHIND the
 * WebView at the same coordinates) — but it reserves the layout slot
 * so siblings don't overlap and so we have something measurable to
 * compute viewport bounds from.
 *
 * Use when:
 *   - Running on Tauri Android (`isNativePlayerAvailable()` true), AND
 *   - The stream is live IPTV / anything CORS would block in a
 *     `<video>` element.
 *
 * Lifecycle (mirrors legacy VideoPlayer.jsx native-preview path):
 *   1. onMount: schedule attachInlinePreview + the first play.
 *   2. ResizeObserver + window resize/scroll: scheduleSync(false) →
 *      updateInlinePreview with new bounds. ~1 RAF debounce.
 *   3. props.url change: playInlinePreview with the new source.
 *   4. props.active flips false: stopInlinePreview.
 *   5. onCleanup: stopInlinePreview + detachInlinePreview.
 *
 * The surface is identified by a random id per component instance so
 * two simultaneous mounts (rare but possible — page transitions) don't
 * step on each other; the native side enforces a single-preview policy
 * via removeOthers when a new attach arrives.
 */

import { createEffect, on, onCleanup, onMount, type JSX } from "solid-js";
import {
  attachInlinePreview,
  detachInlinePreview,
  isNativePlayerAvailable,
  playInlinePreview,
  stopInlinePreview,
  updateInlinePreview,
  type InlinePreviewBounds,
} from "../lib/nativePlayer";

export interface NativePreviewSurfaceProps {
  /** Stream URL — usually a live channel's `/{base}/live/{u}/{p}/{id}.m3u8`. */
  url: string | null;
  /**
   * When false, the surface stays attached but stops playback. Use to
   * pause without paying the attach/detach overhead between focus
   * changes. Default true.
   */
  active?: boolean;
  /** Mute by default — preview surfaces shouldn't bleed audio. */
  muted?: boolean;
  /** Optional CSS class on the wrapper div for size/position styling. */
  class?: string;
  /** Optional inline style on the wrapper div. */
  style?: JSX.CSSProperties;
}

function randId(): string {
  return `np-${Math.random().toString(36).slice(2, 10)}`;
}

export default function NativePreviewSurface(
  props: NativePreviewSurfaceProps,
): JSX.Element {
  const id = randId();
  let wrapper: HTMLDivElement | undefined;
  let attached = false;
  let lastBounds: InlinePreviewBounds | null = null;
  let rafId = 0;
  let resizeObserver: ResizeObserver | null = null;

  const computeBounds = (): InlinePreviewBounds | null => {
    if (!wrapper) return null;
    const rect = wrapper.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      id,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      zIndex: 1000,
      dpr: window.devicePixelRatio || 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  };

  const hasBoundsDelta = (
    a: InlinePreviewBounds | null,
    b: InlinePreviewBounds | null,
  ): boolean => {
    if (!a || !b) return true;
    const t = 1.5;
    return (
      Math.abs(a.x - b.x) > t ||
      Math.abs(a.y - b.y) > t ||
      Math.abs(a.width - b.width) > t ||
      Math.abs(a.height - b.height) > t ||
      Math.abs((a.viewportWidth ?? 0) - (b.viewportWidth ?? 0)) > t ||
      Math.abs((a.viewportHeight ?? 0) - (b.viewportHeight ?? 0)) > t
    );
  };

  const syncBounds = async (forceAttach: boolean) => {
    const bounds = computeBounds();
    if (!bounds) return;
    if (!forceAttach && !hasBoundsDelta(lastBounds, bounds)) return;

    try {
      if (forceAttach || !attached) {
        await attachInlinePreview(bounds);
        attached = true;
      } else {
        await updateInlinePreview(bounds);
      }
      lastBounds = bounds;
    } catch {
      /* native call failed — leave attached=false, retry on next sync */
    }
  };

  const scheduleSync = (forceAttach: boolean) => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      void syncBounds(forceAttach);
    });
  };

  const ensurePlay = async () => {
    const url = props.url;
    if (!url || props.active === false) return;
    // Guarantee attach-before-play so the native side has a surface
    // to draw into.
    if (!attached) {
      const bounds = computeBounds();
      if (!bounds) return;
      try {
        await attachInlinePreview(bounds);
        attached = true;
        lastBounds = bounds;
      } catch {
        return;
      }
    }
    try {
      await playInlinePreview({
        id,
        url,
        muted: props.muted ?? true,
        isLive: true,
      });
    } catch {
      /* best-effort */
    }
  };

  onMount(() => {
    if (!isNativePlayerAvailable()) return;

    scheduleSync(true);
    // A second sync ~120ms later catches the post-mount layout when
    // the parent grid finishes its initial reflow — same trick the
    // legacy VideoPlayer used.
    window.setTimeout(() => scheduleSync(false), 120);
    void ensurePlay();

    const onWindowMove = () => scheduleSync(false);
    window.addEventListener("resize", onWindowMove, { passive: true });
    window.addEventListener("scroll", onWindowMove, true);

    if (typeof ResizeObserver !== "undefined" && wrapper) {
      resizeObserver = new ResizeObserver(() => scheduleSync(false));
      resizeObserver.observe(wrapper);
    }

    onCleanup(() => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onWindowMove);
      window.removeEventListener("scroll", onWindowMove, true);
      resizeObserver?.disconnect();
      resizeObserver = null;
      void stopInlinePreview(id).catch(() => {});
      void detachInlinePreview(id).catch(() => {});
      attached = false;
      lastBounds = null;
    });
  });

  // Re-play when the URL or active flag change.
  createEffect(
    on(
      () => [props.url, props.active] as const,
      ([url, active]) => {
        if (!isNativePlayerAvailable()) return;
        if (!url || active === false) {
          void stopInlinePreview(id).catch(() => {});
          return;
        }
        void ensurePlay();
      },
      { defer: true },
    ),
  );

  return (
    <div
      ref={(el) => (wrapper = el)}
      class={props.class}
      style={props.style}
      // The native ExoPlayer surface renders BEHIND this div via
      // addContentView, so we make the div transparent / pointer-
      // events:none to let underlying interactive elements through.
      // The Hero preview region in CSS handles z-index for
      // surrounding gradients.
    />
  );
}
