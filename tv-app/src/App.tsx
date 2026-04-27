import { Router, Route, Navigate } from "@solidjs/router";
import { authToken } from "./stores/auth";
import Login from "./routes/Login";

/**
 * Top-level router shell. Routes that require auth re-route to /login when
 * `authToken()` is missing. Real screens (Home, Movies, Series, Live, Search,
 * Profile, Player) get added in the next sub-steps.
 */

function HomePlaceholder() {
  return (
    <div class="min-h-screen flex items-center justify-center text-zinc-300">
      <div class="text-center">
        <h1 class="text-3xl font-semibold mb-2">Signed in.</h1>
        <p class="text-zinc-500">
          Home screen lands once <code>focus.ts</code> is ported and
          <code> Rail / PosterCard</code> components exist.
        </p>
      </div>
    </div>
  );
}

function ProtectedHome() {
  if (!authToken()) return <Navigate href="/login" />;
  return <HomePlaceholder />;
}

function RootRedirect() {
  return <Navigate href={authToken() ? "/home" : "/login"} />;
}

export default function App() {
  return (
    <Router>
      <Route path="/" component={RootRedirect} />
      <Route path="/login" component={Login} />
      <Route path="/home" component={ProtectedHome} />
    </Router>
  );
}
