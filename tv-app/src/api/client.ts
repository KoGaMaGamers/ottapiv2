/**
 * Backend HTTP client.
 *
 * Dev: VITE_API_BASE is unset → relative paths, Vite dev proxy forwards to
 *      https://ottapi.smartbunker.fr (see `vite.config.ts`).
 * Tauri APK build: VITE_API_BASE is set to the public hostname so requests
 *      go directly without a proxy.
 *
 * The bearer token is held in a Solid signal (see `stores/auth.ts`) and
 * attached automatically. Errors are normalised to the backend's
 * `{ detail: string }` shape; non-JSON responses surface as
 * `ApiError("HTTP <status>")`.
 */

import { authToken } from "../stores/auth";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function joinUrl(path: string): string {
  if (!BASE) return path;
  if (path.startsWith("http")) return path;
  return BASE.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(joinUrl(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (resp.status === 204) return undefined as T;

  const text = await resp.text();
  let parsed: any = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!resp.ok) {
    const detail =
      (parsed && typeof parsed === "object" && parsed.detail) ||
      (typeof parsed === "string" && parsed) ||
      `HTTP ${resp.status}`;
    throw new ApiError(resp.status, detail);
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
};
