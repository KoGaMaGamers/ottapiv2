import { api } from "./client";
import type { HeartbeatResponse, PlayResponse, StreamKind } from "./types";

/**
 * The play endpoints are idempotent within the allocation TTL: an owner
 * who already holds a valid lock gets the SAME allocation_token back, just
 * with a new stream URL for the new content. This is critical for live-TV
 * channel zapping — switching channels must NOT release the slot, otherwise
 * each zap rotates to a different donor (the gap the owner flagged from
 * the legacy app).
 *
 * The contract:
 *   - Channel zap → call playLive(newId) again (no release in between)
 *   - VOD switch  → call playMovie(newId) again
 *   - Player exit → release(token)
 */

export function playMovie(movieId: number): Promise<PlayResponse> {
  return api.post<PlayResponse>(`/api/v1/play/movie/${movieId}`);
}

export function playLive(liveId: number): Promise<PlayResponse> {
  return api.post<PlayResponse>(`/api/v1/play/live/${liveId}`);
}

export function playEpisode(episodeId: number): Promise<PlayResponse> {
  return api.post<PlayResponse>(`/api/v1/play/episode/${episodeId}`);
}

export interface HeartbeatBody {
  allocation_token: string;
  is_streaming: boolean;
  stream_kind?: StreamKind;
  stream_ref?: string;
}

export function heartbeat(body: HeartbeatBody): Promise<HeartbeatResponse> {
  return api.post<HeartbeatResponse>("/api/v1/play/heartbeat", body);
}

export function release(allocation_token: string): Promise<{ released: boolean }> {
  return api.post<{ released: boolean }>("/api/v1/play/release", {
    allocation_token,
  });
}
