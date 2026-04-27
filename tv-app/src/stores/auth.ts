/**
 * Auth signal — module-global, persisted to localStorage.
 *
 * The bearer token (issued by `POST /auth/login`) plus the user-info
 * payload returned alongside it. Components read these via `authToken()`
 * and `authUser()`; the API client reads `authToken()` to attach the
 * `Authorization: Bearer …` header.
 */

import { createSignal } from "solid-js";

const TOKEN_KEY = "ott_token_v1";
const USER_KEY = "ott_user_v1";

export interface AuthUser {
  user_id: number;
  username: string;
  provider_id: number;
  view_mode: "fallback" | "curated";
  is_populated: boolean;
}

function loadInitialToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function loadInitialUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

const [token, setToken] = createSignal<string | null>(loadInitialToken());
const [user, setUser] = createSignal<AuthUser | null>(loadInitialUser());

export const authToken = token;
export const authUser = user;

export function setAuth(newToken: string, newUser: AuthUser): void {
  try {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
  } catch {
    /* ignore */
  }
  setToken(newToken);
  setUser(newUser);
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  setToken(null);
  setUser(null);
}
