import { createSignal, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ApiError } from "../api/client";
import { login } from "../api/auth";

/**
 * Placeholder Login screen — exists primarily to verify the dev tunnel
 * (Vite proxy → live backend → MySQL). Real layout / focus integration
 * lands once `lib/focus.ts` is ported.
 */
export default function Login() {
  const navigate = useNavigate();
  const [host, setHost] = createSignal("http://r656.vip");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const resp = await login({
        base_url: host(),
        username: username(),
        password: password(),
      });
      navigate(`/home?welcome=${resp.is_new_user ? 1 : 0}`);
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="min-h-screen flex items-center justify-center px-6">
      <form
        onSubmit={onSubmit}
        class="w-full max-w-md rounded-xl bg-zinc-900/80 backdrop-blur p-8 ring-1 ring-zinc-800"
      >
        <h1 class="text-2xl font-semibold mb-1">OTT TV</h1>
        <p class="text-zinc-400 text-sm mb-6">Sign in with your IPTV credentials.</p>

        <label class="block text-xs text-zinc-400 mb-1">Host</label>
        <input
          class="w-full mb-4 rounded-md bg-zinc-800 px-3 py-2 ring-1 ring-zinc-700 focus:ring-2 focus:ring-violet-500 outline-none"
          value={host()}
          onInput={(e) => setHost(e.currentTarget.value)}
          autocomplete="off"
        />

        <label class="block text-xs text-zinc-400 mb-1">Username</label>
        <input
          class="w-full mb-4 rounded-md bg-zinc-800 px-3 py-2 ring-1 ring-zinc-700 focus:ring-2 focus:ring-violet-500 outline-none"
          value={username()}
          onInput={(e) => setUsername(e.currentTarget.value)}
          autocomplete="username"
        />

        <label class="block text-xs text-zinc-400 mb-1">Password</label>
        <input
          type="password"
          class="w-full mb-6 rounded-md bg-zinc-800 px-3 py-2 ring-1 ring-zinc-700 focus:ring-2 focus:ring-violet-500 outline-none"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          autocomplete="current-password"
        />

        <button
          type="submit"
          disabled={submitting()}
          class="w-full rounded-md bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:cursor-not-allowed py-2 font-medium transition-colors"
        >
          {submitting() ? "Signing in…" : "Sign in"}
        </button>

        <Show when={error()}>
          {(msg) => (
            <p class="mt-4 text-sm text-rose-400 break-words">{msg()}</p>
          )}
        </Show>
      </form>
    </div>
  );
}
