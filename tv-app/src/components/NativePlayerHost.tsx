/**
 * Native player host — Android-only sibling of `MediaPlayer.tsx`.
 *
 * Responsibilities
 * ----------------
 * Mounted by `AppShell` (instead of `<MediaPlayer />`) when
 * `isNativePlayerAvailable()` returns true. For each item the user
 * launches we:
 *
 *   1. Resolve a stream URL.
 *      - Live: built locally from the user's xtream credentials so
 *        the native player can zap to siblings + start catchup
 *        without a /api/v1/play round-trip per channel. Phase D's
 *        "donor policy = user creds first" applied early for live.
 *      - Movie / episode: still slot-allocated through /api/v1/play
 *        — those have a clearer "watch session" semantic where
 *        heartbeat + release are appropriate.
 *   2. Look up resume position from playbackStore.
 *   3. Build the launch payload — `channelData` carries the metadata
 *      the lifted Kotlin needs:
 *        - live   → base_stream_url + creds + channels list +
 *                   currentIndex (LiveOverlayManager, EpgService).
 *        - vod    → tmdb_id + season + episode + preferred langs
 *                   (SubtitleManager, VodOverlayManager).
 *   4. Invoke the `native-player` Tauri plugin's `start_player`
 *      command. Blocks until the Activity finishes.
 *   5. Fold the result back into the same store writes the WebView
 *      player does — savePlaybackProgress (cross-store cleanup
 *      cascades), releaseAllocation.
 *   6. Series prev/next + auto-play next: when the Activity returns
 *      with exitReason `prev_episode` / `next_episode` / `finished`
 *      and the open state has sibling episodes, relaunch with the
 *      adjacent episode instead of closing.
 *
 * Renders a thin "Launching player…" placeholder while the activity
 * is starting; once the Activity is on screen, the user is in native
 * land and never sees us.
 */

import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import {
  closePlayer,
  openPlayer,
  playerOpen,
  type PlayerOpen,
} from "../stores/player";
import { useNavigationScope } from "../lib/navigation";
import { isBackKey } from "../lib/navigationKeys";
import {
  playMovie,
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
  type PlayerResult,
} from "../lib/nativePlayer";
import { setNativePlayerActive } from "../lib/hardwareBack";
import { getUserCreds } from "../lib/userCreds";
import type { UserCredentials } from "../api/me";
import { buildLiveUrl } from "../lib/streamUrls";
import { getPlaybackPreferences } from "../lib/clientPreferences";

interface ResolvedSource {
  /** Direct stream URL handed to ExoPlayer. */
  url: string;
  /** Allocation token for VOD; null for live (no slot). */
  allocationToken: string | null;
}

async function resolveSource(open: PlayerOpen): Promise<ResolvedSource> {
  if (open.kind === "movie") {
    const r = await playMovie(open.movie.id);
    return { url: r.stream_url, allocationToken: r.allocation_token };
  }
  if (open.kind === "episode") {
    const r = await playEpisode(open.episode.id);
    return { url: r.stream_url, allocationToken: r.allocation_token };
  }
  // Live — direct user-creds URL, no slot.
  const creds = await getUserCreds();
  return {
    url: buildLiveUrl(creds, open.channel.stream_id),
    allocationToken: null,
  };
}

function buildLaunchArgs(
  open: PlayerOpen,
  streamUrl: string,
  resumeMs: number,
  creds: UserCredentials | null,
): LaunchPlayerArgs {
  const prefs = getPlaybackPreferences();
  if (open.kind === "movie") {
    const m = open.movie;
    return {
      url: streamUrl,
      type: "movie",
      title: m.name,
      subtitle: m.year ? String(m.year) : "",
      resumePosition: resumeMs,
      // SubtitleManager hits /api/v1/subtitles?tmdb_id=…&lang=…
      // when tmdb_id is non-empty. Pass it along + the user's
      // preferred audio/subtitle langs so the overlay can auto-
      // pick on first track-discovery tick.
      channelData: JSON.stringify({
        tmdb_id: m.tmdb_id ?? null,
        season: 0,
        episode: 0,
        preferredSubtitleLang: prefs.preferredSubtitleLang,
        preferredAudioLang: prefs.preferredAudioLang,
      }),
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
      channelData: JSON.stringify({
        tmdb_id: s.tmdb_id ?? null,
        season: ep.season_number,
        episode: ep.episode_num,
        preferredSubtitleLang: prefs.preferredSubtitleLang,
        preferredAudioLang: prefs.preferredAudioLang,
      }),
    };
  }
  // Live: hand the native side a JSON blob the lifted EpgService /
  // LiveOverlayManager / ChannelData parser expect. Snake-case keys
  // match `ChannelData.kt#fromJson`. Channels list lets the native
  // overlay zap to siblings without re-invoking JS.
  const ch = open.channel;
  const channels = open.channels ?? [ch];
  const currentIndex = open.index ?? 0;
  const c = creds!; // resolveSource always populated creds for live
  return {
    url: streamUrl,
    type: "live",
    title: ch.name,
    subtitle: "",
    channelData: JSON.stringify({
      base_stream_url: c.base_stream_url,
      username: c.username,
      password: c.password,
      preferred_output: c.preferred_output,
      currentIndex,
      channels: channels.map((row) => ({
        stream_id: row.stream_id,
        name: row.name,
        stream_icon: row.stream_icon ?? "",
        tv_archive: !!row.tv_archive,
        audio_codec: "",
        video_codec: "",
      })),
    }),
    resumePosition: 0,
  };
}

/**
 * Map the Activity's exitReason into a sibling episode (or null when
 * the user just wants to close). `next_episode` and `finished` both
 * advance forward; `prev_episode` walks back. Returns null when there
 * is no neighbour in the season list — caller closes normally.
 */
function nextEpisodeOpen(
  open: PlayerOpen,
  reason: string,
): PlayerOpen | null {
  if (open.kind !== "episode") return null;
  const list = open.seasonEpisodes ?? [];
  if (list.length === 0) return null;
  const cur = list.findIndex((e) => e.id === open.episode.id);
  if (cur < 0) return null;
  let target: number;
  if (reason === "prev_episode") target = cur - 1;
  else if (reason === "next_episode" || reason === "finished") target = cur + 1;
  else return null;
  if (target < 0 || target >= list.length) return null;
  return {
    kind: "episode",
    series: open.series,
    episode: list[target],
    seasonEpisodes: list,
  };
}

export default function NativePlayerHost(): JSX.Element {
  const [error, setError] = createSignal<string | null>(null);
  const [launching, setLaunching] = createSignal(true);
  const [running, setRunning] = createSignal(false);

  const { isScopeOwner } = useNavigationScope("player:native", {
    active: true,
    priority: 100,
  });

  onCleanup(() => setNativePlayerActive(false));

  const onKey = (e: KeyboardEvent) => {
    if (!isScopeOwner()) return;
    if (!isBackKey(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!running()) closePlayer();
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  onMount(() => {
    const o = playerOpen();
    if (!o) {
      closePlayer();
      return;
    }
    void run(o);
  });

  /**
   * Drives one launch → Activity → result cycle. May call itself
   * recursively when the Activity returns with `prev_episode` /
   * `next_episode` / `finished` to launch the sibling episode
   * inline (no overlay flicker).
   */
  async function run(o: PlayerOpen): Promise<void> {
    let allocationToken: string | null = null;
    let result: PlayerResult | null = null;
    try {
      const source = await resolveSource(o);
      allocationToken = source.allocationToken;

      // For live, creds were already fetched inside resolveSource —
      // grab them again synchronously from the cache for buildLaunchArgs.
      let creds: UserCredentials | null = null;
      if (o.kind === "live") {
        creds = await getUserCreds();
      }

      const item = playbackItemFor(o);
      const resumeSec = item ? getResumePositionSec(item) : 0;

      setRunning(true);
      try {
        result = await launchNativePlayer(
          buildLaunchArgs(o, source.url, Math.round(resumeSec * 1000), creds),
        );
      } finally {
        setRunning(false);
      }

      if (item && result) {
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
    } finally {
      if (allocationToken) {
        releaseAllocation(allocationToken).catch(() => {});
      }
    }

    // Series prev/next + auto-play next: re-enter `run` with the
    // adjacent episode if the Activity asked for one. No allocation
    // teardown round-trip — the previous episode's slot was just
    // released above; we'll allocate a fresh one for the next.
    if (result && !error()) {
      const sibling = nextEpisodeOpen(o, result.exitReason);
      // eslint-disable-next-line no-console
      console.log(
        "[NativePlayerHost] exitReason=", result.exitReason,
        "kind=", o.kind,
        "seasonEpisodes.length=",
        o.kind === "episode" ? (o.seasonEpisodes?.length ?? 0) : "n/a",
        "currentEpisodeId=",
        o.kind === "episode" ? o.episode.id : "n/a",
        "sibling=", sibling ? `${sibling.kind}#${sibling.episode.id}` : "null",
      );
      if (sibling) {
        // Update the player store so any reactive consumers stay
        // in sync (Continue Watching highlight, etc.) and run
        // again — Activity stays opaque to JS during this tiny
        // gap; the user sees one player → another.
        openPlayer(sibling);
        await run(sibling);
        return;
      }
    }

    setLaunching(false);
    if (error()) {
      setTimeout(() => closePlayer(), 1500);
    } else {
      closePlayer();
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
