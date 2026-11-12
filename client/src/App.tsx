import { Match, Suspense, Switch, createSignal, lazy, onCleanup } from "solid-js";
import { Home } from "./pages/Home";

// The game board and deck builder are large; load them only when needed.
const RoomPage = lazy(() => import("./pages/Room").then((m) => ({ default: m.RoomPage })));
const CpuPage = lazy(() => import("./pages/Cpu").then((m) => ({ default: m.CpuPage })));
const DeckEditor = lazy(() => import("./pages/DeckEditor").then((m) => ({ default: m.DeckEditor })));

export type Route = { page: "home" } | { page: "decks"; deckId: string | null } | { page: "room"; roomId: string } | { page: "cpu" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "room" && parts[1]) return { page: "room", roomId: parts[1].toUpperCase() };
  if (parts[0] === "cpu") return { page: "cpu" };
  if (parts[0] === "decks") return { page: "decks", deckId: parts[1] ?? null };
  return { page: "home" };
}

export const navigate = (hash: string) => {
  location.hash = hash;
};

export function App() {
  const [route, setRoute] = createSignal(parseRoute(location.hash));
  const onHash = () => setRoute(parseRoute(location.hash));
  window.addEventListener("hashchange", onHash);
  onCleanup(() => window.removeEventListener("hashchange", onHash));

  return (
    <Suspense fallback={<p class="muted center loading-page">Loading…</p>}>
      <Switch>
        <Match when={route().page === "room" && (route() as { roomId: string })}>
          {(r) => <RoomPage roomId={r().roomId} />}
        </Match>
        <Match when={route().page === "cpu"}>
          <CpuPage />
        </Match>
        <Match when={route().page === "decks" && (route() as { deckId: string | null })}>
          {(r) => <DeckEditor deckId={r().deckId} />}
        </Match>
        <Match when={true}>
          <Home />
        </Match>
      </Switch>
    </Suspense>
  );
}
