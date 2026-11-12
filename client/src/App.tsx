import { Match, Show, Switch, createSignal, onCleanup } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Home } from "./pages/Home";

// The game board and deck builder are large, so they're split out of the first
// load, then prefetched while the browser is idle so navigating doesn't wait.
//
// Deliberately no <Suspense> anywhere above the pages: the board and deck builder
// load card art through resources, and under a Suspense boundary every image
// still downloading would blank the whole screen. Without one, images simply
// fill in where they belong while the rest of the UI stays put.
type RoomModule = typeof import("./pages/Room");
type CpuModule = typeof import("./pages/Cpu");
type DecksModule = typeof import("./pages/DeckEditor");

const loaders = {
  room: () => import("./pages/Room"),
  cpu: () => import("./pages/Cpu"),
  decks: () => import("./pages/DeckEditor"),
};
const [mods, setMods] = createSignal<{ room?: RoomModule; cpu?: CpuModule; decks?: DecksModule }>({});
function load<K extends keyof typeof loaders>(key: K) {
  return loaders[key]().then((m) => {
    setMods((cur) => (cur[key] ? cur : { ...cur, [key]: m }));
    return m;
  });
}

const idle = (fn: () => void) =>
  "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500);
idle(() => {
  for (const key of Object.keys(loaders) as (keyof typeof loaders)[]) load(key).catch(() => {});
});

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
  const [route, setRoute] = createSignal<Route>(parseRoute(location.hash));
  const [pending, setPending] = createSignal(false);

  // Switch pages only once the next page's code is loaded, so the current page stays on screen meanwhile.
  let seq = 0;
  const go = async (next: Route) => {
    const n = ++seq;
    if (next.page !== "home" && !mods()[next.page]) {
      setPending(true);
      try {
        await load(next.page);
      } catch {
        // Offline and not cached: fall through; the page shows its own placeholder.
      }
      setPending(false);
    }
    if (n === seq) setRoute(next);
  };
  const onHash = () => void go(parseRoute(location.hash));
  window.addEventListener("hashchange", onHash);
  onCleanup(() => window.removeEventListener("hashchange", onHash));
  // A deep link straight to a split-out page: start fetching it right away.
  const first = route();
  if (first.page !== "home") load(first.page).catch(() => {});

  const waiting = () => <p class="muted center loading-page">Loading…</p>;
  return (
    <>
      <Show when={pending()}>
        <div class="route-progress" />
      </Show>
      <Switch>
        <Match when={route().page === "room" && (route() as { roomId: string })}>
          {(r) => (
            <Show when={mods().room} fallback={waiting()}>
              {(m) => <Dynamic component={m().RoomPage} roomId={r().roomId} />}
            </Show>
          )}
        </Match>
        <Match when={route().page === "cpu"}>
          <Show when={mods().cpu} fallback={waiting()}>
            {(m) => <Dynamic component={m().CpuPage} />}
          </Show>
        </Match>
        <Match when={route().page === "decks" && (route() as { deckId: string | null })}>
          {(r) => (
            <Show when={mods().decks} fallback={waiting()}>
              {(m) => <Dynamic component={m().DeckEditor} deckId={r().deckId} />}
            </Show>
          )}
        </Match>
        <Match when={true}>
          <Home />
        </Match>
      </Switch>
    </>
  );
}
