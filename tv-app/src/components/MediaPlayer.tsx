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
  For,
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
import type { PlayResponse, StreamKind, SubtitleEntry } from "../api/types";
import {
  closePlayer,
  playerOpen,
  setLiveTarget,
  type PlayerOpen,
} from "../stores/player";
import { useNavigationScope } from "../lib/navigation";
import { useHeartbeat } from "../lib/heartbeat";
import { isBackKey, BACK_KEYS } from "../lib/navigationKeys";
import { listSubtitles, subtitleVttUrl } from "../api/subtitles";
import {
  getResumePositionSec,
  savePlaybackProgress,
} from "../lib/playbackStore";
import { playbackItemFor } from "../lib/playbackItem";
import {
  getPlaybackPreferences,
  setClientPreferences,
} from "../lib/clientPreferences";

// Languages exposed in the CC menu. Backend fetches on demand
// per-language, so showing the full set up-front is cheap (no upstream
// traffic until the user actually picks one).
const SUB_LANGS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ar", label: "العربية" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "ru", label: "Русский" },
  { code: "tr", label: "Türkçe" },
];

type SubLangState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "missing" }
  | { status: "loaded"; entry: SubtitleEntry };

/** Don't bother resuming for sub-MIN_RESUME_SEC saves — feels weird. */
const MIN_RESUME_SEC = 10;
/** Wall-clock interval between automatic progress writes (matches legacy). */
const PROGRESS_SAVE_INTERVAL_MS = 10_000;

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

type FocusZone = "none" | "seekBar" | "buttons" | "subMenu" | "audioMenu";
type FocusedButton = "skipBack" | "play" | "skipFwd" | "audio" | "cc";

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

interface SubtitleContext {
  tmdb_id: number;
  season: number;
  episode: number;
}

/**
 * Pull the (tmdb_id, season, episode) tuple needed to query the
 * subtitle backend. Returns null when the kind doesn't support
 * subtitles (live channels) or when tmdb enrichment hasn't run yet
 * for this title.
 */
function subtitleContextFor(open: PlayerOpen): SubtitleContext | null {
  if (open.kind === "movie") {
    const tmdb = open.movie.tmdb_id;
    if (tmdb == null) return null;
    return { tmdb_id: tmdb, season: 0, episode: 0 };
  }
  if (open.kind === "episode") {
    const tmdb = open.series.tmdb_id;
    if (tmdb == null) return null;
    return {
      tmdb_id: tmdb,
      season: open.episode.season_number,
      episode: open.episode.episode_num,
    };
  }
  return null;
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

// playbackItemFor lives in lib/playbackItem.ts so the native player
// host can reuse it without dragging in the WebView player.

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

  // ── Subtitle state ────────────────────────────────────────────────
  // Each language sits in one of: idle (not requested) / loading / loaded /
  // missing. The menu shows all SUB_LANGS regardless of state and renders
  // a spinner / ✓ / ✗ next to each based on its status.
  const [subLangState, setSubLangState] = createSignal<
    Record<string, SubLangState>
  >({});
  const [activeSubId, setActiveSubId] = createSignal<number | null>(null);
  const [subMenuIdx, setSubMenuIdx] = createSignal(0); // 0 = Off, 1+ = lang
  const subContext = createMemo<SubtitleContext | null>(() =>
    subtitleContextFor(cur()),
  );
  const activeSubEntry = createMemo<SubtitleEntry | null>(() => {
    const id = activeSubId();
    if (id == null) return null;
    for (const v of Object.values(subLangState())) {
      if (v.status === "loaded" && v.entry.id === id) return v.entry;
    }
    return null;
  });

  // ── Embedded HLS tracks (audio + subtitle, populated by hls.js events).
  // For native HLS playback (Safari) the browser surfaces these via
  // videoEl.audioTracks / textTracks instead — we ignore that path for
  // now since hls.js covers all non-Safari browsers.
  interface AudioTrack {
    id: number;
    name: string;
    lang: string;
  }
  interface EmbeddedSubTrack {
    id: number;
    name: string;
    lang: string;
  }
  const [audioTracks, setAudioTracks] = createSignal<AudioTrack[]>([]);
  const [activeAudioId, setActiveAudioId] = createSignal<number | null>(null);
  const [embeddedSubs, setEmbeddedSubs] = createSignal<EmbeddedSubTrack[]>([]);
  const [activeEmbeddedSubId, setActiveEmbeddedSubId] = createSignal<
    number | null
  >(null);
  const [bufferedPct, setBufferedPct] = createSignal(0);
  const [audioMenuIdx, setAudioMenuIdx] = createSignal(0);

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

    // Reset embedded-track state on every source switch (channel zap, etc.)
    setAudioTracks([]);
    setActiveAudioId(null);
    setEmbeddedSubs([]);
    setActiveEmbeddedSubId(null);

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
      // Audio + subtitle track discovery — populated as the manifest
      // is parsed. Mirrors what ExoPlayer surfaces natively in the
      // Android overlay; here we expose the same picker UI in JS.
      const refreshAudio = () => {
        if (!hls) return;
        setAudioTracks(
          hls.audioTracks.map((t) => ({
            id: t.id,
            name: t.name || t.lang || `Track ${t.id + 1}`,
            lang: t.lang || "",
          })),
        );
        setActiveAudioId(hls.audioTrack);
      };
      const refreshSubs = () => {
        if (!hls) return;
        setEmbeddedSubs(
          hls.subtitleTracks.map((t) => ({
            id: t.id,
            name: t.name || t.lang || `Subtitle ${t.id + 1}`,
            lang: t.lang || "",
          })),
        );
        setActiveEmbeddedSubId(
          hls.subtitleTrack >= 0 ? hls.subtitleTrack : null,
        );
      };
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshAudio);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, refreshAudio);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshSubs);
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, refreshSubs);
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

  // ── Subtitle commands ──────────────────────────────────────────────
  const fetchSubLang = async (lang: string) => {
    const ctx = subContext();
    if (!ctx) return;
    const cur = subLangState()[lang]?.status;
    if (cur === "loading" || cur === "loaded" || cur === "missing") return;
    setSubLangState((p) => ({ ...p, [lang]: { status: "loading" } }));
    try {
      const list = await listSubtitles({
        tmdb_id: ctx.tmdb_id,
        lang,
        season: ctx.season,
        episode: ctx.episode,
      });
      const entry = list.find((e) => e.lang === lang);
      setSubLangState((p) => ({
        ...p,
        [lang]: entry
          ? { status: "loaded", entry }
          : { status: "missing" },
      }));
    } catch {
      setSubLangState((p) => ({ ...p, [lang]: { status: "missing" } }));
    }
  };

  // Persist the user's last subtitle/audio choice to the client prefs
  // bag so the next playback (any title) auto-applies it. The legacy
  // bag already had these fields; we just write on pick.
  const savePreferredSubtitleLang = (lang: string | null) => {
    setClientPreferences({
      playback: {
        subtitleMode: lang ? "preferred" : "off",
        preferredSubtitleLang: lang,
      },
    });
  };
  const savePreferredAudioLang = (lang: string | null) => {
    setClientPreferences({ playback: { preferredAudioLang: lang } });
  };

  const selectSubtitle = async (lang: string | null) => {
    // Picking a SUBDL lang implies turning off any in-band HLS sub.
    if (hls && hls.subtitleTrack >= 0) {
      hls.subtitleTrack = -1;
      setActiveEmbeddedSubId(null);
    }
    if (lang == null) {
      setActiveSubId(null);
      savePreferredSubtitleLang(null);
      return;
    }
    let st = subLangState()[lang];
    if (!st || st.status === "idle") {
      await fetchSubLang(lang);
      st = subLangState()[lang];
    }
    if (st?.status === "loaded") {
      setActiveSubId(st.entry.id);
      savePreferredSubtitleLang(lang);
    }
  };

  const selectEmbeddedSub = (id: number | null) => {
    if (!hls) return;
    // Picking an in-band track implies dropping any external SUBDL.
    setActiveSubId(null);
    hls.subtitleTrack = id ?? -1;
    setActiveEmbeddedSubId(id);
    if (id == null) {
      savePreferredSubtitleLang(null);
    } else {
      const track = embeddedSubs().find((t) => t.id === id);
      if (track?.lang) savePreferredSubtitleLang(track.lang);
    }
  };

  const selectAudioTrack = (id: number) => {
    if (!hls) return;
    hls.audioTrack = id;
    setActiveAudioId(id);
    const track = audioTracks().find((t) => t.id === id);
    if (track?.lang) savePreferredAudioLang(track.lang);
  };

  // ── Auto-apply remembered prefs when tracks become available ──────
  // Runs once per player session. Reads the client prefs bag and:
  //  - matches preferredAudioLang to a discovered HLS audio track
  //  - if subtitleMode === "preferred", picks the matching in-band
  //    subtitle if available, otherwise falls back to fetching SUBDL
  //    in that language.
  // Marked applied after the first attempt so a later track-update
  // event doesn't overwrite a manual choice the user just made.
  let prefsApplied = false;
  createEffect(() => {
    if (prefsApplied) return;
    const audios = audioTracks();
    const embedded = embeddedSubs();
    const ctx = subContext();
    // Wait until we have at least one of the surfaces — otherwise we
    // run the effect too early and the "track unavailable" branch
    // permanently skips the preference.
    if (audios.length === 0 && embedded.length === 0 && !ctx) return;

    const prefs = getPlaybackPreferences();
    let didSomething = false;

    if (
      audios.length > 1 &&
      prefs.preferredAudioLang &&
      activeAudioId() == null
    ) {
      const match = audios.find(
        (a) => a.lang.toLowerCase() === prefs.preferredAudioLang!.toLowerCase(),
      );
      if (match) {
        selectAudioTrack(match.id);
        didSomething = true;
      }
    }

    if (
      prefs.subtitleMode === "preferred" &&
      prefs.preferredSubtitleLang &&
      activeEmbeddedSubId() == null &&
      activeSubId() == null
    ) {
      const lang = prefs.preferredSubtitleLang.toLowerCase();
      const inband = embedded.find((s) => s.lang.toLowerCase() === lang);
      if (inband) {
        selectEmbeddedSub(inband.id);
        didSomething = true;
      } else if (ctx) {
        // Fire-and-forget — fetchSubLang persists state in subLangState
        // and selectSubtitle activates once loaded.
        selectSubtitle(prefs.preferredSubtitleLang);
        didSomething = true;
      }
    }

    if (didSomething) prefsApplied = true;
  });

  // Activate the matching textTrack on the <video> when the active
  // subtitle changes — Solid mounts the <track> reactively below, but
  // browsers default new tracks to `disabled`, so we flip mode to
  // `showing` once the entry is in place.
  createEffect(() => {
    const entry = activeSubEntry();
    queueMicrotask(() => {
      if (!videoRef) return;
      const tracks = videoRef.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        t.mode =
          entry && t.label === entry.label && t.language === entry.lang
            ? "showing"
            : "disabled";
      }
    });
  });

  // ── Progress emission ───────────────────────────────────────────────
  // Save the current position every 10s while playing. The store has
  // its own "completed" detection (>=90% watched OR within 120s of the
  // end) that auto-purges. The `final` flag here only adds an extra
  // signal when the user closes near the end (>=98%) — a manual close
  // mid-movie must NOT purge the entry, otherwise the user can't
  // resume.
  const saveProgress = (final = false) => {
    // Guard against the unmount-time race: closePlayer() flips the
    // store to null first, then Solid's createEffect cleanup runs the
    // last interval tick. cur() would assert non-null and crash. Bail
    // when there's nothing to save against.
    const o = open();
    if (!o || !videoRef) return;
    const item = playbackItemFor(o);
    if (!item) return;
    const pos = videoRef.currentTime || 0;
    const dur = videoRef.duration || duration() || 0;
    const completed = final && dur > 0 && pos >= dur * 0.98;
    savePlaybackProgress(item, {
      positionSec: pos,
      durationSec: dur,
      markCompleted: completed,
    });
  };
  createEffect(() => {
    if (isLive()) return;
    if (!playing()) return;
    const id = window.setInterval(
      () => saveProgress(false),
      PROGRESS_SAVE_INTERVAL_MS,
    );
    onCleanup(() => clearInterval(id));
  });

  // ── Close + release ─────────────────────────────────────────────────
  // Close the UI synchronously and let the release request race in the
  // background. Awaiting the release before closing made the back
  // button feel broken: a slow network or unresponsive backend would
  // hold the player open for tens of seconds. Releases are best-effort
  // anyway — the slot has its own TTL on the server.
  const closeAndRelease = () => {
    saveProgress(true);
    const a = alloc();
    if (!releasedRef && a) {
      releasedRef = true;
      releaseAllocation(a.allocation_token).catch(() => {
        /* best-effort */
      });
    }
    if (hideTimer != null) clearTimeout(hideTimer);
    closePlayer();
  };

  onCleanup(() => {
    saveProgress(false);
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
    if (!videoRef) return;
    setDuration(videoRef.duration || 0);
    // Resume from saved position if we have one and the user hasn't
    // already nudged the playhead. Done here (not on play() call) so
    // the duration is known and the seek lands cleanly. Live skipped
    // — playbackItemFor returns null for live.
    const item = playbackItemFor(cur());
    if (item) {
      const resume = getResumePositionSec(item);
      if (resume > MIN_RESUME_SEC && videoRef.currentTime < 1) {
        try {
          videoRef.currentTime = resume;
        } catch {
          /* seek may fail if duration unknown — silent */
        }
      }
    }
  };
  const onTimeUpdate = () => {
    if (videoRef) setCurrentTime(videoRef.currentTime || 0);
  };
  const onProgress = () => {
    // Update the buffered-fill chunk on the seek bar. Always uses the
    // last buffered range so the indicator matches the bar's right edge
    // when the player has buffered ahead.
    if (!videoRef) return;
    const d = videoRef.duration || 0;
    const ranges = videoRef.buffered;
    if (!d || ranges.length === 0) {
      setBufferedPct(0);
      return;
    }
    const end = ranges.end(ranges.length - 1);
    setBufferedPct(Math.min(1, end / d));
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
        ...BACK_KEYS,
      ];
      if (!NAV.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();

      if (isBackKey(e.key)) {
        // If a submenu is open, dismiss it instead of closing the
        // whole player — same back-out semantics as any nested overlay.
        if (zone() === "subMenu") {
          setZone("buttons");
          setFocusedBtn("cc");
          return;
        }
        if (zone() === "audioMenu") {
          setZone("buttons");
          setFocusedBtn("audio");
          return;
        }
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
        // Button order: skipBack ← play → skipFwd → [audio if >1 track] → cc.
        // CC available when the content has a tmdb_id (movie / episode).
        // AUDIO available when the stream exposes more than one audio
        // track (HLS multi-audio).
        const order: FocusedButton[] = ["skipBack", "play", "skipFwd"];
        if (audioTracks().length > 1) order.push("audio");
        if (subContext() || embeddedSubs().length > 0) order.push("cc");
        const idx = order.indexOf(focusedBtn());
        if (e.key === "ArrowLeft") {
          if (idx > 0) setFocusedBtn(order[idx - 1]);
          return;
        }
        if (e.key === "ArrowRight") {
          if (idx >= 0 && idx < order.length - 1) {
            setFocusedBtn(order[idx + 1]);
          }
          return;
        }
        if (e.key === "Enter") {
          const b = focusedBtn();
          if (b === "skipBack") seekBy(-10);
          else if (b === "skipFwd") seekBy(10);
          else if (b === "cc") {
            setZone("subMenu");
            // Land on the currently active entry: external SUBDL → its
            // index in the SUBDL section; embedded HLS → its index in
            // the embedded section; otherwise Off.
            const active = activeSubEntry();
            const embIdx = activeEmbeddedSubId();
            if (active) {
              const langIdx = SUB_LANGS.findIndex(
                (l) => l.code === active.lang,
              );
              setSubMenuIdx(
                langIdx >= 0
                  ? 1 + embeddedSubs().length + langIdx
                  : 0,
              );
            } else if (embIdx != null) {
              const i = embeddedSubs().findIndex((t) => t.id === embIdx);
              setSubMenuIdx(i >= 0 ? 1 + i : 0);
            } else {
              setSubMenuIdx(0);
            }
          } else if (b === "audio") {
            setZone("audioMenu");
            const active = activeAudioId();
            const i = audioTracks().findIndex((t) => t.id === active);
            setAudioMenuIdx(i >= 0 ? i : 0);
          } else togglePlay();
          return;
        }
      }
      if (z === "subMenu") {
        const total = 1 + embeddedSubs().length + SUB_LANGS.length;
        if (e.key === "ArrowDown") {
          setSubMenuIdx((i) => Math.min(i + 1, total - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          setSubMenuIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          const i = subMenuIdx();
          const eCount = embeddedSubs().length;
          if (i === 0) {
            selectSubtitle(null);
            selectEmbeddedSub(null);
          } else if (i <= eCount) {
            selectEmbeddedSub(embeddedSubs()[i - 1].id);
          } else {
            const lang = SUB_LANGS[i - 1 - eCount]?.code;
            if (lang) selectSubtitle(lang);
          }
          setZone("buttons");
          setFocusedBtn("cc");
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          return;
        }
      }
      if (z === "audioMenu") {
        const total = audioTracks().length;
        if (e.key === "ArrowDown") {
          setAudioMenuIdx((i) => Math.min(i + 1, total - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          setAudioMenuIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          const t = audioTracks()[audioMenuIdx()];
          if (t) selectAudioTrack(t.id);
          setZone("buttons");
          setFocusedBtn("audio");
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
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
        onProgress={onProgress}
        onPlay={onPlayEvt}
        onPause={onPauseEvt}
        onWaiting={onWaiting}
        onPlaying={onPlaying}
      >
        <Show when={activeSubEntry()}>
          <track
            kind="subtitles"
            src={subtitleVttUrl(activeSubEntry()!)}
            srclang={activeSubEntry()!.lang}
            label={activeSubEntry()!.label}
            default
          />
        </Show>
      </video>

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
                  class="mp-buf-fill"
                  style={{ width: `${bufferedPct() * 100}%` }}
                />
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
            <div class="mp-ctrl-side mp-ctrl-right">
              {/* AUDIO button — only when the stream exposes >1 audio track */}
              <Show when={audioTracks().length > 1}>
                <div class="mp-menu-wrap">
                  <button
                    class={`mp-btn mp-cc-btn${activeAudioId() != null ? " mp-btn--active" : ""}${
                      zone() === "buttons" && focusedBtn() === "audio"
                        ? " mp-btn--remote-focus"
                        : ""
                    }`}
                    onClick={() => {
                      setZone("audioMenu");
                      setFocusedBtn("audio");
                      const i = audioTracks().findIndex(
                        (t) => t.id === activeAudioId(),
                      );
                      setAudioMenuIdx(i >= 0 ? i : 0);
                    }}
                  >
                    <span class="mp-btn-label">AUDIO</span>
                  </button>

                  <Show when={zone() === "audioMenu"}>
                    <div class="mp-menu">
                      <div class="mp-menu-header">
                        Audio
                        <span class="mp-menu-hint">
                          {" "}↑↓ navigate · Enter select · ← back
                        </span>
                      </div>
                      <For each={audioTracks()}>
                        {(track, i) => {
                          const isActive = () => track.id === activeAudioId();
                          const isFocused = () => audioMenuIdx() === i();
                          return (
                            <button
                              class={`mp-menu-item${
                                isActive() ? " mp-menu-item--active" : ""
                              }${
                                isFocused() ? " mp-menu-item--kbfocus" : ""
                              }`}
                              onClick={() => {
                                selectAudioTrack(track.id);
                                setZone("buttons");
                                setFocusedBtn("audio");
                              }}
                            >
                              <span class="mp-menu-item-label">
                                {track.name}
                                <Show when={track.lang}>
                                  <span style={{ opacity: 0.55 }}>
                                    {" "}· {track.lang}
                                  </span>
                                </Show>
                              </span>
                              <Show when={isActive()}>
                                <span class="mp-sub-badge mp-sub-badge--on">
                                  ✓
                                </span>
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>

              {/* CC button — visible when there's a subtitle source: either
                  a tmdb_id (so SUBDL can search) or in-band HLS subs. */}
              <Show when={subContext() || embeddedSubs().length > 0}>
                <div class="mp-menu-wrap">
                  <button
                    class={`mp-btn mp-cc-btn${activeSubEntry() || activeEmbeddedSubId() != null ? " mp-btn--active" : ""}${
                      zone() === "buttons" && focusedBtn() === "cc"
                        ? " mp-btn--remote-focus"
                        : ""
                    }`}
                    onClick={() => {
                      setZone("subMenu");
                      setFocusedBtn("cc");
                      const active = activeSubEntry();
                      const embId = activeEmbeddedSubId();
                      if (active) {
                        const langIdx = SUB_LANGS.findIndex(
                          (l) => l.code === active.lang,
                        );
                        setSubMenuIdx(
                          langIdx >= 0
                            ? 1 + embeddedSubs().length + langIdx
                            : 0,
                        );
                      } else if (embId != null) {
                        const i = embeddedSubs().findIndex(
                          (t) => t.id === embId,
                        );
                        setSubMenuIdx(i >= 0 ? 1 + i : 0);
                      } else {
                        setSubMenuIdx(0);
                      }
                    }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      width="20"
                      height="20"
                    >
                      <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-10 7H8v-1H6v4h2v-1h2v1c0 .55-.45 1-1 1H5c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h5c.55 0 1 .45 1 1v1zm9 0h-2v-1h-2v4h2v-1h2v1c0 .55-.45 1-1 1h-5c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h5c.55 0 1 .45 1 1v1z" />
                    </svg>
                    <span class="mp-btn-label">
                      {activeSubEntry() || activeEmbeddedSubId() != null
                        ? "CC ✓"
                        : "CC"}
                    </span>
                  </button>

                  <Show when={zone() === "subMenu"}>
                    <div class="mp-menu">
                      <div class="mp-menu-header">
                        Subtitles
                        <span class="mp-menu-hint">
                          {" "}↑↓ navigate · Enter select · ← back
                        </span>
                      </div>

                      <button
                        class={`mp-menu-item${
                          !activeSubEntry() && activeEmbeddedSubId() == null
                            ? " mp-menu-item--active"
                            : ""
                        }${subMenuIdx() === 0 ? " mp-menu-item--kbfocus" : ""}`}
                        onClick={() => {
                          selectSubtitle(null);
                          selectEmbeddedSub(null);
                          setZone("buttons");
                          setFocusedBtn("cc");
                        }}
                      >
                        <span class="mp-menu-item-label">Off</span>
                      </button>

                      {/* In-band tracks first — these come for free with
                          the stream and don't need a SUBDL roundtrip. */}
                      <Show when={embeddedSubs().length > 0}>
                        <div class="mp-menu-section-header">Stream tracks</div>
                        <For each={embeddedSubs()}>
                          {(track, i) => {
                            const isActive = () =>
                              activeEmbeddedSubId() === track.id;
                            const isFocused = () => subMenuIdx() === 1 + i();
                            return (
                              <button
                                class={`mp-menu-item${
                                  isActive() ? " mp-menu-item--active" : ""
                                }${
                                  isFocused() ? " mp-menu-item--kbfocus" : ""
                                }`}
                                onClick={() => {
                                  selectEmbeddedSub(track.id);
                                  setZone("buttons");
                                  setFocusedBtn("cc");
                                }}
                              >
                                <span class="mp-menu-item-label">
                                  {track.name}
                                </span>
                                <Show when={isActive()}>
                                  <span class="mp-sub-badge mp-sub-badge--on">
                                    ✓
                                  </span>
                                </Show>
                              </button>
                            );
                          }}
                        </For>
                      </Show>

                      <Show when={subContext()}>
                        <div class="mp-menu-section-header">Languages</div>
                        <For each={SUB_LANGS}>
                          {(lang, i) => {
                            const state = () =>
                              subLangState()[lang.code] ?? { status: "idle" };
                            const isActive = () =>
                              activeSubEntry()?.lang === lang.code;
                            const isMissing = () =>
                              state().status === "missing";
                            const isLoading = () =>
                              state().status === "loading";
                            const isFocused = () =>
                              subMenuIdx() ===
                              1 + embeddedSubs().length + i();
                            return (
                              <button
                                class={`mp-menu-item${
                                  isActive() ? " mp-menu-item--active" : ""
                                }${isMissing() ? " mp-menu-item--missing" : ""}${
                                  isFocused() ? " mp-menu-item--kbfocus" : ""
                                }`}
                                onClick={() => {
                                  selectSubtitle(lang.code);
                                  setZone("buttons");
                                  setFocusedBtn("cc");
                                }}
                              >
                                <span class="mp-menu-item-label">
                                  {lang.label}
                                </span>
                                <Show when={isLoading()}>
                                  <span class="mp-sub-spin" />
                                </Show>
                                <Show when={isMissing()}>
                                  <span class="mp-sub-badge mp-sub-badge--na">
                                    ✗
                                  </span>
                                </Show>
                                <Show
                                  when={
                                    isActive() && !isLoading() && !isMissing()
                                  }
                                >
                                  <span class="mp-sub-badge mp-sub-badge--on">
                                    ✓
                                  </span>
                                </Show>
                              </button>
                            );
                          }}
                        </For>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
