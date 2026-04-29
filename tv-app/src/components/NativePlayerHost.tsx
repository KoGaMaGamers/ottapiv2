/**
 * Native player host — Android-only sibling of `MediaPlayer.tsx`.
 *
 * Mounted by `AppShell` (instead of `<MediaPlayer />`) when
 * `isNativePlayerAvailable()` returns true. Lifecycle:
 *
 *   1. On mount: allocate a stream URL via the same /api/v1/play/*
 *      endpoint the WebView player uses (slot allocation, heartbeat
 *      cadence, etc. all unchanged).
 *   2. Look up resume position from playbackStore.
 *   3. Invoke the `native-player` Tauri plugin's `start_player`
 *      command — this hands control over to the lifted ExoPlayer
 *      Activity, which blocks until the user closes it.
 *   4. On close: the Activity returns final position / duration / exit
 *      reason / language picks. We fold those into the same store
 *      writes the WebView player does:
 *        - savePlaybackProgress (triggers the cross-store cleanup
 *          chain when ≥90% — watchlist remove + history record)
 *        - releaseAllocation
 *   5. Clear `playerOpen` so AppShell unmounts us.
 *
 * Renders a thin "Launching player…" placeholder while the activity
 * is starting; once the Activity is on screen, the user is in native
 * land and never sees us.
 */

import { createSignal, onMount, Show, type JSX } from "solid-js";
import { closePlayer, playerOpen, type PlayerOpen } from "../stores/player";
import {
  playMovie,
  playLive,
  playEpisode,
  release as releaseAllocation,
} from "../api/play";
import {
  getResumePositionSec,
  savePlaybackProgress,
} from "../lib/playbackStore";
import { playbackItemFor } from "../lib/playbackItem";
import {
  launchNativePlayer,
  type LaunchPlayerArgs,
} from "../lib/nativePlayer";

// Same fan-out the WebView player uses. The stream URL we hand the
// native side comes from this allocation; once the activity closes
// we release the slot.
async function allocateFor(open: PlayerOpen) {
  if (open.kind === "movie") return playMovie(open.movie.id);
  if (open.kind === "live") return playLive(open.channel.id);
  return playEpisode(open.episode.id);
}

function buildLaunchArgs(
  open: PlayerOpen,
  streamUrl: string,
  resumeMs: number,
): LaunchPlayerArgs {
  if (open.kind === "movie") {
    const m = open.movie;
    return {
      url: streamUrl,
      type: "movie",
      title: m.name,
      subtitle: m.year ? String(m.year) : "",
      resumePosition: resumeMs,
    };
  }
  if (open.kind === "episode") {
    const s = open.series;
    const ep = open.episode;
    const epLabel =
      `S${String(ep.season_number).padStart(2, "0")}` +
      `E${String(ep.episode_num).padStart(2, "0")}`;
    return {
      url: streamUrl,
      type: "episode",
      title: s.name,
      subtitle: ep.title ? `${epLabel} · ${ep.title}` : epLabel,
      resumePosition: resumeMs,
    };
  }
  // Live: hand the native side a JSON blob the lifted EpgService /
  // LiveOverlayManager can parse for channel + EPG metadata. Mirrors
  // the legacy Capacitor `channelData` payload shape.
  const ch = open.channel;
  const channelData = JSON.stringify({
    streamId: ch.stream_id,
    name: ch.name,
    epgChannelId: ch.epg_channel_id ?? null,
    streamIcon: ch.stream_icon ?? null,
    tvArchive: !!ch.tv_archive,
    categoryId: ch.category_id ?? null,
  });
  return {
    url: streamUrl,
    type: "live",
    title: ch.name,
    subtitle: "",
    channelData,
    resumePosition: 0,
  };
}

export default function NativePlayerHost(): JSX.Element {
  const [error, setError] = createSignal<string | null>(null);
  const [launching, setLaunching] = createSignal(true);

  onMount(() => {
    const o = playerOpen();
    if (!o) {
      closePlayer();
      return;
    }
    void run(o);
  });

  async function run(o: PlayerOpen) {
    let allocationToken: string | null = null;
    try {
      const alloc = await allocateFor(o);
      allocationToken = alloc.allocation_token;

      const item = playbackItemFor(o);
      const resumeSec = item ? getResumePositionSec(item) : 0;

      // Hand off to native. This call blocks until the Activity finishes.
      const result = await launchNativePlayer(
        buildLaunchArgs(o, alloc.stream_url, Math.round(resumeSec * 1000)),
      );

      // Persist the final position. Cross-store cleanup (watchlist /
      // history) fires inside savePlaybackProgress when completion
      // criteria are hit.
      if (item) {
        const finalPosSec = (result.lastPosition || 0) / 1000;
        const finalDurSec = (result.lastDuration || 0) / 1000;
        const finishedFlag = result.exitReason === "finished";
        const nearEnd =
          finalDurSec > 0 && finalPosSec >= finalDurSec * 0.98;
        savePlaybackProgress(item, {
          positionSec: finalPosSec,
          durationSec: finalDurSec,
          markCompleted: finishedFlag || nearEnd,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Fall through — still close the overlay + release.
    } finally {
      if (allocationToken) {
        releaseAllocation(allocationToken).catch(() => {
          /* swallow — release is best-effort */
        });
      }
      // Unmount this host. AppShell will re-render without us.
      // Slight delay so the user can see an error toast if one
      // happened (though usually the native activity took over the
      // screen and we never showed anything).
      setTimeout(() => closePlayer(), error() ? 1500 : 100);
      setLaunching(false);
    }
  }

  return (
    <Show when={launching()}>
      <div
        class="fixed inset-0 z-[9000] bg-black flex items-center justify-center text-white"
        aria-busy="true"
      >
        <Show
          when={error()}
          fallback={
            <div class="text-sm opacity-70">Launching player…</div>
          }
        >
          {(msg) => (
            <div class="text-sm text-rose-400 max-w-md text-center px-4">
              Couldn't launch native player: {msg()}
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}
