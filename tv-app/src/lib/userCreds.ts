/**
 * Module-level cache for the user's xtream credentials.
 *
 * Why this exists
 * ---------------
 * The native player needs the user's `base_stream_url` / `username` /
 * `password` / `preferred_output` to build live + catchup + zap +
 * preview URLs locally (no slot allocation, no /api/v1/play round-
 * trip per channel zap). Same pattern as the legacy Capacitor app.
 *
 * Lifecycle
 * ---------
 * - First call after login: hits `/api/v1/me/credentials`, stores the
 *   result in memory, returns it.
 * - Subsequent calls: returns the cached value synchronously via the
 *   shared promise.
 * - On logout: callers should call `clearUserCreds()` so a fresh
 *   login refetches.
 *
 * NOT persisted to localStorage. The promise lives in module scope so
 * it survives route remounts within a session, dies on app reload.
 */

import { getCredentials, type UserCredentials } from "../api/me";

let pending: Promise<UserCredentials> | null = null;
let cached: UserCredentials | null = null;

export function getUserCreds(): Promise<UserCredentials> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = getCredentials()
    .then((c) => {
      cached = c;
      return c;
    })
    .catch((err) => {
      pending = null;
      throw err;
    });
  return pending;
}

/** Read cached creds synchronously. Returns null if never fetched. */
export function getUserCredsSync(): UserCredentials | null {
  return cached;
}

/** Drop the cache — call on logout. */
export function clearUserCreds(): void {
  cached = null;
  pending = null;
}
