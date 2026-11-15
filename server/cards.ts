// Card data on the server: the engine's card pool (from @gi-tcg/data), the
// version it corresponds to, and deck validation so a room can never be
// created with a deck the engine can't run.

import getData from "@gi-tcg/data";
import { CURRENT_VERSION, type GameData } from "@gi-tcg/core";
import type { DeckInput } from "../shared/protocol.ts";

/** Game version whose card pool the engine implements (e.g. "v7.1.0"). */
export const ENGINE_VERSION: string = CURRENT_VERSION;

let cached: GameData | null = null;

/** Engine card data, loaded once per process and shared (read-only) by every game. */
export function gameData(): GameData {
  return (cached ??= getData());
}

/** Entity types that are action cards (as opposed to statuses, summons, etc. the engine also defines). */
const PLAYABLE_TYPES = new Set(["eventCard", "equipment", "support"]);

export const DECK_CHARACTERS = 3;
export const DECK_CARDS = 30;
export const MAX_COPIES = 2;

/**
 * Structural deck validation against what the engine actually implements.
 * Card-specific constraints (talent cards needing their character, element
 * resonance requirements...) are enforced by the deck builder on the client;
 * the engine itself tolerates them.
 */
export function validateDeck(input: unknown): { ok: true; deck: DeckInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Deck is missing." };
  const { characters, cards } = input as Record<string, unknown>;
  const isIdList = (v: unknown): v is number[] =>
    Array.isArray(v) && v.every((x) => Number.isSafeInteger(x) && (x as number) > 0);
  if (!isIdList(characters) || !isIdList(cards)) return { ok: false, error: "Deck must list character and card ids." };

  const data = gameData();
  if (characters.length !== DECK_CHARACTERS) return { ok: false, error: `A deck needs exactly ${DECK_CHARACTERS} characters.` };
  if (new Set(characters).size !== characters.length) return { ok: false, error: "Characters in a deck must be different." };
  for (const id of characters) {
    if (!data.characters.has(id)) return { ok: false, error: `Character ${id} is not playable in this version.` };
  }

  if (cards.length !== DECK_CARDS) return { ok: false, error: `A deck needs exactly ${DECK_CARDS} action cards.` };
  const counts = new Map<number, number>();
  for (const id of cards) {
    // Note: the engine's `obtainable` flag is not a deckability check (e.g. v6.4 "Blessing" cards are
    // deckable but flagged unobtainable), so any implemented action card is accepted, as in the deck builder.
    const def = data.entities.get(id);
    if (!def || !PLAYABLE_TYPES.has(def.type)) {
      return { ok: false, error: `Card ${id} is not playable in this version.` };
    }
    const n = (counts.get(id) ?? 0) + 1;
    if (n > MAX_COPIES) return { ok: false, error: `At most ${MAX_COPIES} copies of a card are allowed.` };
    counts.set(id, n);
  }
  return { ok: true, deck: { characters: [...characters], cards: [...cards] } };
}

/** A legal deck built from the engine's card pool; used by tests and the smoke script. */
export function sampleDeck(offset = 0): DeckInput {
  const data = gameData();
  const characters = [...data.characters.values()].slice(offset * 3, offset * 3 + 3).map((c) => c.id);
  const pool = [...data.entities.values()]
    .filter(
      (e: any) =>
        e.obtainable && e.type === "eventCard" && !e.tags.some((t: string) => ["talent", "legend", "food"].includes(t)),
    )
    .slice(0, 15)
    .map((e) => e.id);
  return { characters, cards: [...pool, ...pool] };
}
