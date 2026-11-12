// Small, failure-tolerant wrappers around localStorage (private windows and
// blocked storage must not break the app).
import type { DeckInput, Seat } from "../../shared/protocol";

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable; the app keeps working without persistence.
  }
}

// ------------------------------------------------------------------ profile

export const getName = () => readJson<string>("gi.name", "");
export const setName = (name: string) => writeJson("gi.name", name);

// -------------------------------------------------------------------- decks

export interface SavedDeck {
  id: string;
  name: string;
  deck: DeckInput;
  updatedAt: number;
}

const DECKS_KEY = "gi.decks";
export const listDecks = () => readJson<SavedDeck[]>(DECKS_KEY, []).sort((a, b) => b.updatedAt - a.updatedAt);
export function saveDeck(d: SavedDeck) {
  const all = readJson<SavedDeck[]>(DECKS_KEY, []).filter((x) => x.id !== d.id);
  all.push({ ...d, updatedAt: Date.now() });
  writeJson(DECKS_KEY, all);
}
export function deleteDeck(id: string) {
  writeJson(
    DECKS_KEY,
    readJson<SavedDeck[]>(DECKS_KEY, []).filter((x) => x.id !== id),
  );
}
export const getLastDeckId = () => readJson<string | null>("gi.lastDeck", null);
export const setLastDeckId = (id: string) => writeJson("gi.lastDeck", id);

export const isCompleteDeck = (d: DeckInput | undefined | null) =>
  !!d && d.characters.length === 3 && d.cards.length === 30;

// ------------------------------------------------------------ room seats

/** Seat credentials for rooms this browser has created or joined. */
export interface SeatTicket {
  roomId: string;
  seat: Seat;
  token: string;
  joinedAt: number;
}

const TICKETS_KEY = "gi.tickets";
export const listTickets = () =>
  readJson<SeatTicket[]>(TICKETS_KEY, []).sort((a, b) => b.joinedAt - a.joinedAt);
export const getTicket = (roomId: string) => listTickets().find((t) => t.roomId === roomId.toUpperCase());
export function saveTicket(t: SeatTicket) {
  const all = listTickets().filter((x) => x.roomId !== t.roomId);
  all.unshift(t);
  writeJson(TICKETS_KEY, all.slice(0, 30));
}
export function forgetTicket(roomId: string) {
  writeJson(
    TICKETS_KEY,
    listTickets().filter((t) => t.roomId !== roomId),
  );
}

// ---------------------------------------------------------------- settings

export type RotationSetting = "auto" | 0 | 90 | 270;
export const getRotation = () => readJson<RotationSetting>("gi.rotation", "auto");
export const setRotation = (r: RotationSetting) => writeJson("gi.rotation", r);

// ------------------------------------------------------ vs computer (local)

/** A game against the computer, run and saved entirely in this browser. */
export interface CpuSave {
  v: 1;
  name: string;
  botName: string;
  deck: DeckInput;
  botDeck: DeckInput;
  gameNumber: number;
  /** Engine player index of the human (0 moves first). */
  humanWho: 0 | 1;
  seed: number;
  /** Serialized engine checkpoint of the game in progress. */
  checkpoint: unknown;
  round: number | null;
  /** Seat 0 is the human, seat 1 the computer. */
  result: { winnerSeat: Seat | null; reason: "victory" | "surrender" | "draw" | "error"; at: number } | null;
  error: string | null;
  updatedAt: number;
}

const CPU_KEY = "gi.cpu";
export const getCpuGame = () => readJson<CpuSave | null>(CPU_KEY, null);
export const saveCpuGame = (s: CpuSave) => writeJson(CPU_KEY, s);
export function clearCpuGame() {
  try {
    localStorage.removeItem(CPU_KEY);
  } catch {}
}
