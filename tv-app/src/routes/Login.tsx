import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ApiError } from "../api/client";
import { login } from "../api/auth";
import { useNavigationScope } from "../lib/navigation";

/**
 * Login form with D-pad navigation through the 4 focusable elements
 * (host, username, password, submit). Up/Down arrows move the
 * `focused` index; an effect calls .focus() on the corresponding DOM
 * element so the on-screen keyboard / IME / desktop keyboard receives
 * input naturally.
 *
 * The scope is registered at the default priority (0). Modals or the
 * player overlay would push higher priorities and supersede us.
 */

const FIELD_COUNT = 4;

export default function Login() {
  const navigate = useNavigate();
  const [host, setHost] = createSignal("http://r656.vip");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [focused, setFocused] = createSignal(0);

  const { isScopeOwner } = useNavigationScope("login", { priority: 0 });

  const refs: (HTMLElement | undefined)[] = new Array(FIELD_COUNT);

  // Sync the DOM focus with the `focused` index whenever it changes.
  createEffect(() => {
    const el = refs[focused()];
    if (el) el.focus();
  });

  function onKey(e: KeyboardEvent) {
    if (!isScopeOwner()) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((i) => Math.min(i + 1, FIELD_COUNT - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((i) => Math.max(i - 1, 0));
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKey);
    // Fall through the createEffect → focuses element 0
  });
  onCleanup(() => window.removeEventListener("keydown", onKey));

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({
        base_url: host(),
        username: username(),
        password: password(),
      });
      navigate("/home");
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // Focus-ring class — only painted on the currently-focused element.
  const focusRing = (idx: number) =>
    focused() === idx
      ? "ring-2 ring-violet-400"
      : "ring-1 ring-zinc-700";

  return (
    <div class="min-h-screen flex items-center justify-center px-6">
      <form
        onSubmit={onSubmit}
        class="w-full max-w-md rounded-xl bg-zinc-900/80 backdrop-blur p-8 ring-1 ring-zinc-800"
      >
        <h1 class="text-2xl font-semibold mb-1">OTT TV</h1>
        <p class="text-zinc-400 text-sm mb-6">
          Sign in with your IPTV credentials.
        </p>

        <label class="block text-xs text-zinc-400 mb-1">Host</label>
        <input
          ref={(el) => (refs[0] = el)}
          class={`w-full mb-4 rounded-md bg-zinc-800 px-3 py-2 outline-none transition-colors ${focusRing(0)}`}
          value={host()}
          onInput={(e) => setHost(e.currentTarget.value)}
          autocomplete="off"
        />

        <label class="block text-xs text-zinc-400 mb-1">Username</label>
        <input
          ref={(el) => (refs[1] = el)}
          class={`w-full mb-4 rounded-md bg-zinc-800 px-3 py-2 outline-none transition-colors ${focusRing(1)}`}
          value={username()}
          onInput={(e) => setUsername(e.currentTarget.value)}
          autocomplete="username"
        />

        <label class="block text-xs text-zinc-400 mb-1">Password</label>
        <input
          ref={(el) => (refs[2] = el)}
          type="password"
          class={`w-full mb-6 rounded-md bg-zinc-800 px-3 py-2 outline-none transition-colors ${focusRing(2)}`}
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
          autocomplete="current-password"
        />

        <button
          ref={(el) => (refs[3] = el)}
          type="submit"
          disabled={submitting()}
          class={`w-full rounded-md py-2 font-medium transition-colors outline-none ${
            submitting()
              ? "bg-zinc-700 cursor-not-allowed"
              : "bg-violet-600 hover:bg-violet-500"
          } ${focusRing(3)}`}
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
