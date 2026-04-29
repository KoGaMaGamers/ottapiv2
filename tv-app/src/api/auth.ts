import { api, ApiError } from "./client";
import { authToken, clearAuth, setAuth, type AuthUser } from "../stores/auth";
import { getMe } from "./me";
import { clearUserCreds } from "../lib/userCreds";

interface LoginResponse {
  token: string;
  user_id: number;
  provider_id: number;
  is_populated: boolean;
  view_mode: "fallback" | "curated";
  is_new_user: boolean;
  sync_triggered: boolean;
  username: string;
  base_url: string;
  subscription_exp_date: string | null;
  max_connections: number | null;
  is_trial: boolean | null;
}

export interface LoginRequest {
  base_url: string;
  username: string;
  password: string;
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  const resp = await api.post<LoginResponse>("/auth/login", {
    base_url: req.base_url,
    username: req.username,
    password: req.password,
    device_type: "tv",
    preferred_output: "m3u8",
  });

  const user: AuthUser = {
    user_id: resp.user_id,
    username: resp.username,
    provider_id: resp.provider_id,
    view_mode: resp.view_mode,
    is_populated: resp.is_populated,
  };
  setAuth(resp.token, user);
  return resp;
}

/**
 * On app start, if a token survives in localStorage, verify it by hitting
 * /api/v1/me. If the server returns 401 the token is stale (expired or
 * revoked) — clear local auth so the router can route to /login. On any
 * other error (network), keep the cached token; the user can still browse
 * cached pages and we'll retry on next request.
 *
 * Resolves to the live MeResponse on success, or null when no auth.
 */
export async function bootstrap(): Promise<AuthUser | null> {
  if (!authToken()) return null;
  try {
    const me = await getMe();
    const user: AuthUser = {
      user_id: me.user_id,
      username: me.username,
      provider_id: me.provider_id,
      view_mode: me.view_mode,
      is_populated: me.is_populated,
    };
    setAuth(authToken()!, user);
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearAuth();
      return null;
    }
    // Network error etc. — keep the cached token; assume best.
    return null;
  }
}

export function logout(): void {
  clearAuth();
  // Drop the in-memory creds cache so the next user's session
  // refetches against /api/v1/me/credentials.
  clearUserCreds();
}
