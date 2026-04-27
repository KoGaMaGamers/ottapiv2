/**
 * Player state — global open signal that AppShell reads to mount the
 * MediaPlayer overlay on top of any page. Pages publish here when the
 * user activates a card / Play button; the player owns the keyboard
 * scope while open and clears the signal on close.
 *
 * Three kinds: movie, episode, live. The shape carries enough context
 * for the player to call the right /api/v1/play/* endpoint and (for
 * live) zap to the next/prev channel without releasing the slot.
 */

import { createSignal } from "solid-js";
import type {
  EpisodeOut,
  LiveStreamItem,
  MovieDetail,
  MovieListItem,
  SeriesDetail,
} from "../api/types";

export interface PlayerOpenMovie {
  kind: "movie";
  /** Either a list-item or a fully-resolved detail; both carry id + name. */
  movie: MovieListItem | MovieDetail;
}

export interface PlayerOpenEpisode {
  kind: "episode";
  series: SeriesDetail;
  episode: EpisodeOut;
  /** Sibling episodes for the same season — used by next/prev episode skip. */
  seasonEpisodes: EpisodeOut[];
}

export interface PlayerOpenLive {
  kind: "live";
  channel: LiveStreamItem;
  /**
   * Sibling channels in the current category, in display order. When
   * present, ↑/↓ inside the player zaps to the prev/next channel and
   * re-calls /play/live without releasing the slot.
   */
  channels?: LiveStreamItem[];
  /** Current index within `channels`. */
  index?: number;
}

export type PlayerOpen =
  | PlayerOpenMovie
  | PlayerOpenEpisode
  | PlayerOpenLive;

const [playerOpen, setPlayerOpenInternal] = createSignal<PlayerOpen | null>(
  null,
);

export { playerOpen };

export function openPlayer(value: PlayerOpen): void {
  setPlayerOpenInternal(value);
}

export function closePlayer(): void {
  setPlayerOpenInternal(null);
}

/**
 * Update the live-zap target without unmounting the player. Useful when
 * the inner player UI changes channel — the same allocation token stays
 * valid so we just swap the source.
 */
export function setLiveTarget(channel: LiveStreamItem, index: number): void {
  const cur = playerOpen();
  if (!cur || cur.kind !== "live") return;
  setPlayerOpenInternal({ ...cur, channel, index });
}
