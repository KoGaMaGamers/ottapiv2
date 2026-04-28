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
    throw new ApiError(resp.status, formatErrorDetail(parsed, resp.status));
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
};

/**
 * Coerce whatever shape the backend returned for an error into a
 * single human-readable string. The trickiest case is FastAPI's 422
 * — it returns `{ detail: [{ loc: [...], msg: "..." }, ...] }`, an
 * array that previously stringified to "[object Object]" because the
 * caller just dropped it into a template literal.
 */
function formatErrorDetail(parsed: unknown, status: number): string {
  if (typeof parsed === "string" && parsed) return parsed;
  if (parsed && typeof parsed === "object") {
    const detail = (parsed as { detail?: unknown }).detail;
    if (Array.isArray(detail)) {
      // Pydantic validation errors: each entry is { loc, msg, type }.
      // Show "field: msg" so the user can see *which* field is wrong.
      return detail
        .map((e) => {
          if (e && typeof e === "object") {
            const loc = Array.isArray((e as { loc?: unknown }).loc)
              ? ((e as { loc: unknown[] }).loc.slice(1) as unknown[])
                  .map(String)
                  .join(".")
              : "";
            const msg =
              (e as { msg?: string }).msg ?? JSON.stringify(e);
            return loc ? `${loc}: ${msg}` : msg;
          }
          return String(e);
        })
        .join("; ");
    }
    if (typeof detail === "string") return detail;
    if (detail != null) return JSON.stringify(detail);
  }
  return `HTTP ${status}`;
}
