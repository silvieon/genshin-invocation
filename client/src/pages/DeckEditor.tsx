import { Show, createSignal } from "solid-js";
import { DeckBuilder } from "@gi-tcg/deck-builder";
import type { Deck } from "@gi-tcg/typings";
import { assets, engineVersion } from "../assets";
import { deleteDeck, isCompleteDeck, listDecks, saveDeck, setLastDeckId, type SavedDeck } from "../local";
import { navigate } from "../App";

export function DeckEditor(props: { deckId: string | null }) {
  const existing = props.deckId && props.deckId !== "new" ? listDecks().find((d) => d.id === props.deckId) : undefined;
  const id = existing?.id ?? Math.random().toString(36).slice(2, 10);
  const [name, setName] = createSignal(existing?.name ?? "New deck");
  const [deck, setDeck] = createSignal<Deck>(existing?.deck ?? { characters: [], cards: [] });
  const [message, setMessage] = createSignal<string | null>(null);
  const flash = (m: string) => {
    setMessage(m);
    setTimeout(() => setMessage((cur) => (cur === m ? null : cur)), 2500);
  };

  const save = () => {
    const d: SavedDeck = { id, name: name().trim() || "Untitled deck", deck: deck(), updatedAt: Date.now() };
    saveDeck(d);
    if (isCompleteDeck(d.deck)) setLastDeckId(id);
    navigate("#/");
  };

  const copyCode = async () => {
    if (!isCompleteDeck(deck())) return flash("Finish the deck first (3 characters, 30 cards).");
    const code = assets().encode(deck());
    try {
      await navigator.clipboard.writeText(code);
      flash("Share code copied.");
    } catch {
      prompt("Share code:", code);
    }
  };

  const importCode = () => {
    const code = prompt("Paste a deck share code:")?.trim();
    if (!code) return;
    try {
      setDeck(assets().decode(code));
      flash("Deck imported.");
    } catch {
      flash("That share code couldn't be read.");
    }
  };

  const remove = () => {
    if (existing && confirm(`Delete “${existing.name}”?`)) {
      deleteDeck(existing.id);
      navigate("#/");
    }
  };

  return (
    <div class="editor">
      <header class="topbar">
        <button class="btn ghost" onClick={() => navigate("#/")} aria-label="Back">
          ←
        </button>
        <input
          class="deck-title"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          maxLength={40}
          aria-label="Deck name"
        />
        <span class="counter" classList={{ ok: isCompleteDeck(deck()) }}>
          {deck().characters.length}/3 · {deck().cards.length}/30
        </span>
        <div class="spacer" />
        <button class="btn ghost" onClick={importCode}>
          Import
        </button>
        <button class="btn ghost" onClick={copyCode}>
          Share code
        </button>
        <Show when={existing}>
          <button class="btn ghost danger" onClick={remove}>
            Delete
          </button>
        </Show>
        <button class="btn primary" onClick={save}>
          Save
        </button>
      </header>
      <Show when={message()}>
        <div class="toast">{message()}</div>
      </Show>
      <div class="builder-host">
        <Show when={!engineVersion.loading} fallback={<p class="muted center">Loading card pool…</p>}>
          <DeckBuilder
            class="builder"
            assetsManager={assets()}
            version={engineVersion()}
            locale="en"
            deck={deck()}
            onChangeDeck={setDeck}
          />
        </Show>
      </div>
    </div>
  );
}
