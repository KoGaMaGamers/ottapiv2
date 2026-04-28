/**
 * MediaPlayer — fullscreen video overlay.
 *
 * MVP scope (vs the legacy 1342-LOC `MediaPlayer.jsx`):
 *   - HTML <video> with hls.js for non-Safari HLS support.
 *   - Top bar (back + title/subtitle).
 *   - Bottom controls (seek bar, ±10s, play/pause, time display) that
 *     auto-hide after 4s of inactivity.
 *   - Three-zone keyboard model:
 *       seekBar  ← / →     ±10s
 *       buttons  ← / →     focus skipBack / play / skipFwd
 *                Enter      activate focused button
 *       (none)   ↑ / Space  toggle play/pause anywhere
 *                Esc/Back   close player
 *   - Live mode: no seek; ↑/↓ zaps to prev/next channel by re-calling
 *     /api/v1/play/live without releasing the slot (idempotent).
 *   - Allocation flow at mount: call /play/movie | /play/episode |
 *     /play/live based on the player store kind, hold the
 *     `allocation_token` for the lifetime of the overlay, send
 *     heartbeats at backend cadence, release on close.
 *
 * Deferred for separate iterations:
 *   - Subtitles (CC menu, SUBDL fetch, HLS embedded tracks, offset).
 *   - Codec inspection / no-audio warnings.
 *   - Native player path (Capacitor + tvShellBridge for Tauri).
 *   - Resume position UI.
 *   - URL fallbacks.
 */

import {
  createSignal,
  createMemo,
  createEffect,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import Hls from "hls.js";
import {
  playMovie,
  playEpisode,
  playLive,
  release as releaseAllocation,
} from "../api/play";
import type { PlayResponse, StreamKind } from "../api/types";
import {
  closePlayer,
  playerOpen,
  setLiveTarget,
  type PlayerOpen,
} from "../stores/player";
import { useNavigationScope } from "../lib/navigation";
import { useHeartbeat } from "../lib/heartbeat";

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

type FocusZone = "none" | "seekBar" | "buttons";
type FocusedButton = "skipBack" | "play" | "skipFwd";

interface Allocation {
  stream_url: string;
  allocation_token: string;
  expires_at: string;
}

function streamKindFor(open: PlayerOpen): StreamKind {
  if (open.kind === "movie") return "movie";
  if (open.kind === "live") return "live";
  return "series";
}

function streamRefFor(open: PlayerOpen): string {
  if (open.kind === "movie") return String(open.movie.id);
  if (open.kind === "live") return String(open.channel.id);
  return String(open.episode.id);
}

function titleFor(open: PlayerOpen): { title: string; subtitle: string } {
  if (open.kind === "movie") {
    return { title: open.movie.name, subtitle: "" };
  }
  if (open.kind === "live") {
    return { title: open.channel.name, subtitle: "Live" };
  }
  const ep = open.episode;
  const s = String(ep.season_number).padStart(2, "0");
  const e = String(ep.episode_num).padStart(2, "0");
  const subtitle = `S${s}E${e}${ep.title ? ` · ${ep.title}` : ""}`;
  return { title: open.series.name, subtitle };
}

async function allocateFor(open: PlayerOpen): Promise<PlayResponse> {
  if (open.kind === "movie") return playMovie(open.movie.id);
  if (open.kind === "live") return playLive(open.channel.id);
  return playEpisode(open.episode.id);
}

export default function MediaPlayer(): JSX.Element {
  const open = playerOpen;
  // We always render only when open() is non-null (gated in AppShell).
  // Use a non-null accessor inside the body for ergonomics.
  const cur = (): PlayerOpen => open()!;

  const { isScopeOwner } = useNavigationScope("player:media", {
    active: true,
    priority: 100,
  });

  // Allocation state -------------------------------------------------------
  const [alloc, setAlloc] = createSignal<Allocation | null>(null);
  const [allocError, setAllocError] = createSignal<string | null>(null);
  const [cadenceSec, setCadenceSec] = createSignal(120);

  // Player UI state --------------------------------------------------------
  const [playing, setPlaying] = createSignal(false);
  const [buffering, setBuffering] = createSignal(true);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [showControls, setShowControls] = createSignal(true);
  const [zone, setZone] = createSignal<FocusZone>("buttons");
  const [focusedBtn, setFocusedBtn] = createSignal<FocusedButton>("play");

  let videoRef: HTMLVideoElement | undefined;
  let hls: Hls | null = null;
  let hideTimer: number | null = null;
  let releasedRef = false;

  const isLive = () => cur().kind === "live";

  // ── Allocation flow on open / channel zap ───────────────────────────
  // Re-run when the open signal changes shape (movie → episode → live)
  // OR when only the live target shifts (channel zap reuses the token).
  createEffect(
    on(open, async (val) => {
      if (!val) return;
      try {
        const resp = await allocateFor(val);
        setAlloc({
          stream_url: resp.stream_url,
          allocation_token: resp.allocation_token,
          expires_at: resp.expires_at,
        });
        setCadenceSec(resp.heartbeat_cadence_sec || 120);
        setAllocError(null);
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Could not allocate a slot";
        setAllocError(msg);
      }
    }),
  );

  // ── Source attachment (HLS or native) ───────────────────────────────
  createEffect(() => {
    const a = alloc();
    if (!a || !videoRef) return;

    // Tear down any previous hls.js instance before swapping source.
    if (hls) {
      try {
        hls.destroy();
      } catch {
        /* ignore */
      }
      hls = null;
    }

    const url = a.stream_url;
    const looksHls = /\.m3u8(\?|$)/i.test(url);
    const canNative = videoRef.canPlayType("application/vnd.apple.mpegurl");

    if (looksHls && Hls.isSupported() && !canNative) {
      hls = new Hls({ maxBufferLength: 30 });
      hls.loadSource(url);
      hls.attachMedia(videoRef);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoRef?.play().catch(() => {
          /* autoplay blocked — user can press play */
        });
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          // eslint-disable-next-line no-console
          console.warn("[player] HLS fatal error:", data);
        }
      });
    } else {
      videoRef.src = url;
      videoRef.play().catch(() => {
        /* autoplay blocked */
      });
    }

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
  });

  // ── Heartbeat ───────────────────────────────────────────────────────
  useHeartbeat({
    token: () => alloc()?.allocation_token ?? null,
    cadenceSec,
    isStreaming: () => playing() && !buffering(),
    streamKind: () => streamKindFor(cur()),
    streamRef: () => streamRefFor(cur()),
  });

  // ── Auto-hide controls ──────────────────────────────────────────────
  const scheduleHide = () => {
    setShowControls(true);
    if (hideTimer != null) clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      setShowControls(false);
      setZone("none");
    }, 4000);
  };

  onMount(() => scheduleHide());

  // Refresh hide timer on any user interaction.
  const wakeControls = () => scheduleHide();

  // ── Player commands ─────────────────────────────────────────────────
  const togglePlay = () => {
    if (!videoRef) return;
    if (videoRef.paused) videoRef.play().catch(() => {});
    else videoRef.pause();
  };
  const seekBy = (delta: number) => {
    if (!videoRef || isLive()) return;
    const next = Math.max(
      0,
      Math.min(duration() || Infinity, videoRef.currentTime + delta),
    );
    videoRef.currentTime = next;
  };

  const zapLive = (direction: 1 | -1) => {
    const v = cur();
    if (v.kind !== "live") return;
    const channels = v.channels;
    const idx = v.index;
    if (!channels || channels.length === 0 || idx == null) return;
    const next = (idx + direction + channels.length) % channels.length;
    setLiveTarget(channels[next], next);
  };

  // ── Close + release ─────────────────────────────────────────────────
  const closeAndRelease = async () => {
    const a = alloc();
    if (!releasedRef && a) {
      releasedRef = true;
      try {
        await releaseAllocation(a.allocation_token);
      } catch {
        /* best-effort */
      }
    }
    if (hideTimer != null) clearTimeout(hideTimer);
    closePlayer();
  };

  onCleanup(() => {
    if (hideTimer != null) clearTimeout(hideTimer);
    if (hls) {
      try {
        hls.destroy();
      } catch {
        /* ignore */
      }
      hls = null;
    }
    // Best-effort release on unmount (e.g., user navigated away with router).
    if (!releasedRef) {
      const a = alloc();
      if (a) {
        releasedRef = true;
        releaseAllocation(a.allocation_token).catch(() => {});
      }
    }
  });

  // ── Video element event wiring ──────────────────────────────────────
  const onLoadedMeta = () => {
    if (videoRef) setDuration(videoRef.duration || 0);
  };
  const onTimeUpdate = () => {
    if (videoRef) setCurrentTime(videoRef.currentTime || 0);
  };
  const onPlayEvt = () => {
    setPlaying(true);
    setBuffering(false);
  };
  const onPauseEvt = () => setPlaying(false);
  const onWaiting = () => setBuffering(true);
  const onPlaying = () => setBuffering(false);

  // ── Keyboard handler ────────────────────────────────────────────────
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isScopeOwner()) return;
      const NAV = [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Enter",
        " ",
        "Escape",
        "Backspace",
      ];
      if (!NAV.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape" || e.key === "Backspace") {
        closeAndRelease();
        return;
      }

      // Live channel zap — works regardless of zone.
      if (isLive() && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        zapLive(e.key === "ArrowUp" ? -1 : 1);
        wakeControls();
        return;
      }

      wakeControls();

      if (e.key === " ") {
        togglePlay();
        return;
      }

      const z = zone();
      if (z === "none" || z === "buttons") {
        if (e.key === "ArrowUp") {
          setZone("seekBar");
          return;
        }
        if (e.key === "ArrowDown") {
          setZone("none");
          return;
        }
      }
      if (z === "seekBar") {
        if (e.key === "ArrowDown") {
          setZone("buttons");
          return;
        }
        if (e.key === "ArrowLeft") {
          seekBy(-10);
          return;
        }
        if (e.key === "ArrowRight") {
          seekBy(10);
          return;
        }
        if (e.key === "Enter") {
          // Seek bar Enter is a no-op (selection model is positional).
          return;
        }
      }
      if (z === "buttons") {
        if (e.key === "ArrowLeft") {
          setFocusedBtn((b) =>
            b === "skipFwd" ? "play" : b === "play" ? "skipBack" : "skipBack",
          );
          return;
        }
        if (e.key === "ArrowRight") {
          setFocusedBtn((b) =>
            b === "skipBack" ? "play" : b === "play" ? "skipFwd" : "skipFwd",
          );
          return;
        }
        if (e.key === "Enter") {
          const b = focusedBtn();
          if (b === "skipBack") seekBy(-10);
          else if (b === "skipFwd") seekBy(10);
          else togglePlay();
          return;
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    onCleanup(() => window.removeEventListener("keydown", handler, true));
  });

  // ── Render-derived ──────────────────────────────────────────────────
  const titleBlock = createMemo(() => titleFor(cur()));
  const pct = () => {
    const d = duration();
    if (!d) return 0;
    return Math.min(1, currentTime() / d);
  };

  return (
    <div
      class={`mp-root${showControls() ? " mp-show-controls" : ""}`}
      onMouseMove={wakeControls}
      onClick={wakeControls}
    >
      <video
        ref={(el) => (videoRef = el)}
        class="mp-video"
        autoplay
        playsinline
        onLoadedMetadata={onLoadedMeta}
        onTimeUpdate={onTimeUpdate}
        onPlay={onPlayEvt}
        onPause={onPauseEvt}
        onWaiting={onWaiting}
        onPlaying={onPlaying}
      />

      <Show when={buffering() && !allocError()}>
        <div class="mp-spinner-wrap">
          <div class="mp-spinner" />
        </div>
      </Show>

      <Show when={allocError()}>
        <div class="mp-error-wrap">
          <div class="mp-error-icon">⚠️</div>
          <div class="mp-error-msg">{allocError()}</div>
          <button class="mp-error-btn" onClick={closeAndRelease}>
            Close
          </button>
        </div>
      </Show>

      <Show when={showControls()}>
        <div class="mp-top-bar">
          <button class="mp-back-btn" onClick={closeAndRelease}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div class="mp-title-block">
            <span class="mp-title">{titleBlock().title}</span>
            <Show when={titleBlock().subtitle}>
              <span class="mp-subtitle">{titleBlock().subtitle}</span>
            </Show>
          </div>
        </div>

        <div class="mp-controls">
          <Show when={!isLive()}>
            <div
              class={`mp-seek-wrap ${zone() === "seekBar" ? "mp-seek-focused" : ""}`}
            >
              <div class="mp-buf-track">
                <div
                  class="mp-played-fill"
                  style={{ width: `${pct() * 100}%` }}
                />
              </div>
              <input
                class="mp-seek-range"
                type="range"
                min={0}
                max={duration() || 100}
                step={0.5}
                value={currentTime()}
                onInput={(e) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  if (videoRef) videoRef.currentTime = v;
                }}
              />
            </div>

            <div class="mp-time-row">
              <span class="mp-time">{fmtTime(currentTime())}</span>
              <Show when={duration() > 0}>
                <span class="mp-time mp-time-total">{fmtTime(duration())}</span>
              </Show>
            </div>
          </Show>

          <div class="mp-ctrl-row">
            <div class="mp-ctrl-side" />
            <div class="mp-ctrl-center">
              <Show when={!isLive()}>
                <button
                  class={`mp-btn mp-skip-btn ${
                    zone() === "buttons" && focusedBtn() === "skipBack"
                      ? "mp-btn--remote-focus"
                      : ""
                  }`}
                  onClick={() => {
                    setZone("buttons");
                    setFocusedBtn("skipBack");
                    seekBy(-10);
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    width="24"
                    height="24"
                  >
                    <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                  </svg>
                  <span class="mp-skip-label">10</span>
                </button>
              </Show>

              <button
                class={`mp-play-btn ${
                  zone() === "buttons" && focusedBtn() === "play"
                    ? "mp-play-btn--remote-focus"
                    : ""
                }`}
                onClick={() => {
                  setZone("buttons");
                  setFocusedBtn("play");
                  togglePlay();
                }}
              >
                <Show
                  when={playing()}
                  fallback={
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5,3 19,12 5,21" />
                    </svg>
                  }
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                </Show>
              </button>

              <Show when={!isLive()}>
                <button
                  class={`mp-btn mp-skip-btn ${
                    zone() === "buttons" && focusedBtn() === "skipFwd"
                      ? "mp-btn--remote-focus"
                      : ""
                  }`}
                  onClick={() => {
                    setZone("buttons");
                    setFocusedBtn("skipFwd");
                    seekBy(10);
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    width="24"
                    height="24"
                  >
                    <path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" />
                  </svg>
                  <span class="mp-skip-label">10</span>
                </button>
              </Show>
            </div>
            <div class="mp-ctrl-side" />
          </div>
        </div>
      </Show>
    </div>
  );
}
