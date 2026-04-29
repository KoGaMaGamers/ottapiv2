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

/**
 * GET /api/v1/me/credentials — user's xtream credentials.
 *
 * Used by the native player on Android to build live / catchup /
 * preview / zap URLs client-side (no slot allocation, no /play
 * round-trip per zap). Same security profile as login itself —
 * password reaches JS memory only and is forwarded to the native
 * plugin via channelData. Never persisted to localStorage.
 */
export interface UserCredentials {
  base_stream_url: string;
  username: string;
  password: string;
  preferred_output: string;
}

export function getCredentials(): Promise<UserCredentials> {
  return api.get<UserCredentials>("/api/v1/me/credentials");
}
