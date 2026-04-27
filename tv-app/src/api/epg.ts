import { api } from "./client";
import type { EpgResponse } from "./types";

/**
 * GET /api/v1/live/{id}/epg?limit=N
 *
 * Short EPG for a live channel — pass-through to the provider's
 * get_short_epg, with a 5-minute backend-side TTL cache (per-user) to
 * keep adjacent-channel pre-fetches from hammering the provider.
 *
 * Empty responses aren't cached so they self-heal on the next call.
 */
export function fetchShortEpg(
  liveId: number,
  limit: number = 4,
): Promise<EpgResponse> {
  return api.get<EpgResponse>(
    `/api/v1/live/${liveId}/epg?limit=${limit}`,
  );
}
