/**
 * Adaptive heartbeat scheduler.
 *
 * The donor allocation expires unless the player keeps it warm with
 * periodic POST /api/v1/play/heartbeat calls. The backend returns its
 * preferred cadence (`heartbeat_cadence_sec` in PlayResponse, e.g.
 * 120s). We respect that, but also fire on state changes (visibility,
 * focus/blur, online events) so the backend sees activity right away
 * when the user backgrounds / foregrounds the app.
 *
 * Faithful adaptation of `tv_app_v2/src/hooks/useHeartbeat.js` — same
 * adaptive bands but driven by Solid effects instead of React refs.
 *
 *   streaming + visible → respect backend cadence
 *   streaming + hidden  → 2× cadence (background)
 *   not streaming       → 4× cadence (idle)
 *
 * Caller invokes `useHeartbeat({ ... })` from inside a Solid component
 * scope; cleanup is automatic via onCleanup.
 */

import { createEffect, onCleanup } from "solid-js";
import { heartbeat as sendHeartbeat } from "../api/play";
import type { StreamKind } from "../api/types";

export interface HeartbeatOptions {
  /** Allocation token from the most recent /play/* response. */
  token: () => string | null;
  /** Backend-recommended cadence (heartbeat_cadence_sec from PlayResponse). */
  cadenceSec: () => number;
  /** Currently producing audio/video (vs. paused or buffering). */
  isStreaming: () => boolean;
  streamKind: () => StreamKind;
  /** Stable per-stream identifier (e.g. movie id, episode id, channel id). */
  streamRef: () => string | null;
}

const STATE_CHANGE_MIN_GAP_MS = 1500;

export function useHeartbeat(opts: HeartbeatOptions): void {
  let inflight = false;
  let lastStateChangeAt = 0;

  const ping = async (reason: string) => {
    const t = opts.token();
    if (!t) return;
    if (inflight) return;
    inflight = true;
    try {
      await sendHeartbeat({
        allocation_token: t,
        is_streaming: opts.isStreaming(),
        stream_kind: opts.streamKind(),
        stream_ref: opts.streamRef() ?? undefined,
      });
    } catch (err) {
      // Network blip / token expired — let the next interval retry.
      // eslint-disable-next-line no-console
      console.warn("[heartbeat] ping failed:", err, "(reason:", reason, ")");
    } finally {
      inflight = false;
    }
  };

  // Initial ping when the token first appears.
  createEffect(() => {
    if (opts.token()) ping("start");
  });

  // Recurring timer — re-runs whenever cadence / streaming flag changes.
  createEffect(() => {
    if (!opts.token()) return;
    const base = Math.max(15, opts.cadenceSec() || 120);
    const isHidden =
      typeof document !== "undefined" &&
      document.visibilityState === "hidden";
    const interval = isHidden
      ? base * 2 * 1000
      : opts.isStreaming()
        ? base * 1000
        : base * 2 * 1000;
    const id = window.setInterval(() => ping("timer"), interval);
    onCleanup(() => clearInterval(id));
  });

  // State-change pings (visibility, focus/blur, online). Coalesce
  // bursts so we don't fire 3× back-to-back when the OS toggles the
  // window state in quick succession.
  createEffect(() => {
    if (!opts.token()) return;

    const fire = (reason: string) => {
      const now = Date.now();
      if (now - lastStateChangeAt < STATE_CHANGE_MIN_GAP_MS) return;
      lastStateChangeAt = now;
      ping(reason);
    };
    const onVisibility = () => fire("visibility_change");
    const onFocus = () => fire("focus");
    const onBlur = () => fire("blur");
    const onOnline = () => fire("online");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("online", onOnline);

    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("online", onOnline);
    });
  });
}
