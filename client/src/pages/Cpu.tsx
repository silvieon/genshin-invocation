import { For, Show, createSignal, onCleanup } from "solid-js";
import { DeckPicker, CharacterIcons } from "../components/DeckPicker";
import { Table } from "./Room";
import { connectLocal, newCpuGame } from "../cpu/localGame";
import { assets } from "../assets";
import {
  getCpuGame,
  getLastDeckId,
  getName,
  isCompleteDeck,
  listDecks,
  saveCpuGame,
  setLastDeckId,
  setName,
  type CpuSave,
} from "../local";
import type { DeckInput } from "../../../shared/protocol";

/** Play against the computer. Runs entirely in this browser; the server isn't involved. */
export function CpuPage() {
  const existing = getCpuGame();
  const [save, setSave] = createSignal<CpuSave | null>(existing && !existing.result ? existing : null);
  return (
    <Show when={save()} keyed fallback={<CpuSetup previous={existing} onStart={setSave} />}>
      {(s) => <CpuTable save={s} />}
    </Show>
  );
}

function CpuTable(props: { save: CpuSave }) {
  const conn = connectLocal(props.save);
  onCleanup(() => conn.dispose());
  return <Table conn={conn} roomId="CPU" seat={0} vsComputer />;
}

type Opponent = { kind: "random" } | { kind: "deck"; id: string };

function CpuSetup(props: { previous: CpuSave | null; onStart: (s: CpuSave) => void }) {
  const [name, setNameSig] = createSignal(getName());
  const [deckId, setDeckId] = createSignal<string | null>(getLastDeckId());
  const [opponent, setOpponent] = createSignal<Opponent>({ kind: "random" });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const decks = () => listDecks().filter((d) => isCompleteDeck(d.deck));

  const start = async () => {
    setError(null);
    const deck = listDecks().find((d) => d.id === deckId())?.deck;
    if (!isCompleteDeck(deck)) return setError("Pick a complete deck first.");
    setBusy(true);
    try {
      setName(name());
      const o = opponent();
      let botDeck: DeckInput | undefined;
      if (o.kind === "deck") botDeck = listDecks().find((d) => d.id === o.id)?.deck;
      else {
        const { generateRandomDeck } = await import("@gi-tcg/deck-builder");
        botDeck = await generateRandomDeck(assets());
      }
      if (!isCompleteDeck(botDeck)) throw new Error("The opponent's deck isn't complete.");
      const s = newCpuGame({ name: name(), deck: deck!, botDeck: botDeck!, botName: "Computer" });
      saveCpuGame(s);
      props.onStart(s);
    } catch (e) {
      setError((e as Error).message || "Couldn't set up the game. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="home">
      <header class="hero">
        <a href="#/" class="back-link">
          ← Home
        </a>
        <h1>Play vs Computer</h1>
        <p class="muted">Runs entirely on this device and saves after every move, so you can close the tab and pick it up later.</p>
      </header>
      <main class="home-grid">
        <section class="panel">
          <h2>You</h2>
          <label class="field">
            <span>Display name</span>
            <input value={name()} maxLength={24} placeholder="Traveler" onInput={(e) => setNameSig(e.currentTarget.value)} />
          </label>
          <h3>Your deck</h3>
          <DeckPicker
            selected={deckId()}
            onSelect={(id) => {
              setDeckId(id);
              setLastDeckId(id);
            }}
          />
        </section>
        <section class="panel">
          <h2>Opponent's deck</h2>
          <div class="deck-grid">
            <div
              role="button"
              tabindex="0"
              class="deck-tile"
              classList={{ selected: opponent().kind === "random" }}
              onClick={() => setOpponent({ kind: "random" })}
            >
              <div class="deck-name">🎲 Surprise me</div>
              <div class="muted small">A random legal deck</div>
            </div>
            <For each={decks()}>
              {(d) => (
                <div
                  role="button"
                  tabindex="0"
                  class="deck-tile"
                  classList={{ selected: opponent().kind === "deck" && (opponent() as { id: string }).id === d.id }}
                  onClick={() => setOpponent({ kind: "deck", id: d.id })}
                >
                  <CharacterIcons ids={d.deck.characters} />
                  <div class="deck-name">{d.name}</div>
                </div>
              )}
            </For>
          </div>
          <button class="btn primary big" disabled={busy()} onClick={start}>
            {busy() ? "Shuffling…" : "Start game"}
          </button>
          <Show when={props.previous?.result}>
            {(r) => (
              <p class="muted small">
                Last game: {r().winnerSeat === null ? "draw" : r().winnerSeat === 0 ? "you won" : "the computer won"}.
              </p>
            )}
          </Show>
          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>
        </section>
      </main>
    </div>
  );
}
