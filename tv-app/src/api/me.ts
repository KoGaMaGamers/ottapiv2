import { api } from "./client";
import type { MeResponse } from "./types";

/**
 * GET /api/v1/me — current user + provider summary.
 *
 * Used on app boot to verify the bearer token is still valid (catches
 * the case where the token was revoked or the user changed providers
 * since the localStorage hydration). A 401 here means we should clear
 * auth state and bounce to /login.
 */
export function getMe(): Promise<MeResponse> {
  return api.get<MeResponse>("/api/v1/me");
}
