/**
 * Translator between the player's open state (movie / episode / live)
 * and the loose `PlaybackItem` shape the stores want. Lives in lib/ so
 * both the WebView player (`components/MediaPlayer.tsx`) and the
 * native bridge (`components/NativePlayerHost.tsx`) can persist
 * progress through the same code path.
 *
 * Live channels return null — we don't track resume position for live
 * (no meaningful "where I was" semantics). Callers should skip the
 * playback-store write when this returns null.
 */

import type { PlayerOpen } from "../stores/player";
import type { PlaybackItem } from "./playbackStore";

export function playbackItemFor(open: PlayerOpen): PlaybackItem | null {
  if (open.kind === "movie") {
    const m = open.movie;
    return {
      type: "movie",
      id: m.id,
      tmdb_id: m.tmdb_id,
      title: m.name,
      name: m.name,
      logo: ("cover_big" in m ? m.cover_big : null) ?? m.stream_icon,
      backdrop: m.backdrop_path,
      year: m.year,
      genres: m.genres,
    };
  }
  if (open.kind === "episode") {
    const s = open.series;
    const ep = open.episode;
    return {
      type: "series",
      _ottSeriesId: s.id,
      id: ep.id,
      tmdb_id: s.tmdb_id,
      title: s.name,
      name: s.name,
      logo: s.cover,
      backdrop: s.backdrop_path,
      season: ep.season_number,
      episode: ep.episode_num,
      genres: s.genres,
    };
  }
  return null;
}
