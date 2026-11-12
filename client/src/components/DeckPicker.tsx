import { For, Show, createSignal } from "solid-js";
import { assets } from "../assets";
import { isCompleteDeck, listDecks, saveDeck, type SavedDeck } from "../local";
import { navigate } from "../App";

export function CharacterIcons(props: { ids: number[]; size?: "sm" | "md" }) {
  return (
    <div class={`char-icons ${props.size ?? "md"}`}>
      <For each={props.ids}>
        {(id) => (
          <img
            src={assets().getImageUrlSync(id, { type: "icon", thumbnail: true })}
            alt={assets().getNameSync(id) ?? ""}
            title={assets().getNameSync(id) ?? ""}
            loading="lazy"
          />
        )}
      </For>
    </div>
  );
}

const newId = () => Math.random().toString(36).slice(2, 10);

export function DeckPicker(props: { selected: string | null; onSelect: (id: string) => void }) {
  const [decks, setDecks] = createSignal<SavedDeck[]>(listDecks());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const addRandom = async () => {
    setBusy(true);
    setError(null);
    try {
      const { generateRandomDeck } = await import("@gi-tcg/deck-builder");
      const deck = await generateRandomDeck(assets());
      const names = deck.characters.map((c) => assets().getNameSync(c) ?? "?");
      const d: SavedDeck = { id: newId(), name: `Random: ${names.join(" / ")}`, deck, updatedAt: Date.now() };
      saveDeck(d);
      setDecks(listDecks());
      props.onSelect(d.id);
    } catch {
      setError("Couldn't load the card pool. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  const importCode = () => {
    const code = prompt("Paste a deck share code:")?.trim();
    if (!code) return;
    try {
      const deck = assets().decode(code);
      if (!isCompleteDeck(deck)) throw new Error();
      const d: SavedDeck = { id: newId(), name: "Imported deck", deck, updatedAt: Date.now() };
      saveDeck(d);
      setDecks(listDecks());
      props.onSelect(d.id);
    } catch {
      setError("That share code isn't a complete deck.");
    }
  };

  return (
    <div class="deck-picker">
      <div class="deck-grid">
        <For each={decks()}>
          {(d) => (
            <div
              role="button"
              tabindex="0"
              class="deck-tile"
              classList={{ selected: props.selected === d.id, incomplete: !isCompleteDeck(d.deck) }}
              onClick={() => props.onSelect(d.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && props.onSelect(d.id)}
            >
              <CharacterIcons ids={d.deck.characters} />
              <div class="deck-name">{d.name}</div>
              <Show when={!isCompleteDeck(d.deck)}>
                <div class="deck-warn">
                  Incomplete ({d.deck.characters.length}/3 · {d.deck.cards.length}/30)
                </div>
              </Show>
              <button
                class="link-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`#/decks/${d.id}`);
                }}
              >
                Edit
              </button>
            </div>
          )}
        </For>
        <Show when={decks().length === 0}>
          <p class="muted">No decks yet. Build one, or grab a random legal deck to jump straight in.</p>
        </Show>
      </div>
      <div class="row wrap">
        <button class="btn" onClick={() => navigate("#/decks/new")}>
          New deck
        </button>
        <button class="btn" disabled={busy()} onClick={addRandom}>
          {busy() ? "Shuffling…" : "Random deck"}
        </button>
        <button class="btn ghost" onClick={importCode}>
          Import code
        </button>
      </div>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </div>
  );
}
