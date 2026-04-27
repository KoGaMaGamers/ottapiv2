import { api } from "./client";
import { setAuth, type AuthUser } from "../stores/auth";

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
