// Play against the computer entirely in this browser: the same rules engine
// the server uses runs here, with the heuristic bot from shared/bot.ts as the
// opponent. No server involvement at all; the game is checkpointed to
// localStorage after every action so a reload or closed tab resumes it.

import { createRoot, createSignal } from "solid-js";
import { Game, deserializeGameStateLog, serializeGameStateLog, type GameState } from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import { createClient, type Client } from "@gi-tcg/web-ui-core";
import { createBot, type BotIo } from "../../../shared/bot";
import type { ClientMessage, DeckInput, RoomView } from "../../../shared/protocol";
import type { ActiveGame, ChatLine, Connection, LinkState } from "../connection";
import { assets } from "../assets";
import { createEventFeed } from "../eventFeed";
import { getEffects, saveCpuGame, type CpuSave } from "../local";

// The engine's card definitions, built on first use (it's sizeable, and only this page needs it).
let data: ReturnType<typeof getData> | null = null;
const gameData = () => (data ??= getData());

/** Card or character ids in a deck that the bundled engine doesn't implement. */
export function unsupportedCards(deck: DeckInput): number[] {
  const d = gameData();
  return [
    ...deck.characters.filter((id) => !d.characters.has(id)),
    ...deck.cards.filter((id) => !d.entities.has(id)),
  ];
}

/** Computer's pause per decision, by board-effects mode (animations take part of the time in Full). */
const BOT_PACE_MS = { off: 900, fast: 1100, full: 1300 } as const;

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

/** A not-yet-started game: who moves first is a coin flip, and the seed fixes shuffles and dice. */
export function newCpuGame(base: Pick<CpuSave, "name" | "deck" | "botDeck" | "botName">, gameNumber = 1): CpuSave {
  return {
    v: 1,
    ...base,
    gameNumber,
    humanWho: Math.random() < 0.5 ? 0 : 1,
    seed: randomSeed(),
    checkpoint: null,
    round: null,
    result: null,
    error: null,
    updatedAt: Date.now(),
  };
}

/**
 * A Connection (see connection.ts) whose "server" is this tab: it plays the
 * room role the server would, so the table UI works unchanged. The human is
 * always seat 0 and the computer seat 1; `humanWho` says which engine player
 * the human is.
 */
export function connectLocal(initial: CpuSave): Connection {
  let save = initial;
  const [link] = createSignal<LinkState>("online");
  const [closedReason] = createSignal<string | null>(null);
  const [room, setRoom] = createSignal<RoomView | null>(null);
  const [game, setGame] = createSignal<ActiveGame | null>(null);
  const [chat] = createSignal<ChatLine[]>([]);
  const [notice, setNotice] = createSignal<{ text: string; at: number } | null>(null);

  const feed = createEventFeed(() => save.humanWho, () => save.botName);

  let engine: Game | null = null;
  let bot: BotIo | null = null;
  let io: Client[0] | null = null;
  let disposeBoard: (() => void) | null = null;
  let generation = 0;
  let surrendered = false;
  let disposed = false;

  /** Update the save in localStorage and tell the UI. */
  const persist = (patch: Partial<CpuSave>) => {
    save = { ...save, ...patch, updatedAt: Date.now() };
    saveCpuGame(save);
    publish();
  };

  /** Present the local game as a RoomView, the same shape the server sends for online rooms. */
  const publish = () => {
    const status = save.result ? "finished" : engine ? "playing" : "paused";
    setRoom({
      id: "CPU",
      status,
      you: 0,
      players: [
        { name: save.name || "You", connected: true, wantsRematch: false },
        { name: save.botName, connected: true, wantsRematch: false },
      ],
      whoOfSeat: [save.humanWho, (1 - save.humanWho) as 0 | 1],
      gameNumber: save.gameNumber,
      round: save.round,
      result: save.result,
      error: save.error,
    });
  };

  /** Abandon the running engine. Bumping `generation` makes any late callbacks from it no-ops. */
  const stop = () => {
    generation++;
    bot?.dispose();
    bot = null;
    try {
      io?.cancelRpc();
    } catch {}
    try {
      engine?.terminate();
    } catch {}
    engine = null;
  };

  /** Start the engine from the checkpoint (or from scratch), with the board as one player and the bot as the other. */
  const start = () => {
    stop();
    const gen = generation;
    const humanWho = save.humanWho;
    const botWho = (1 - humanWho) as 0 | 1;
    let state: GameState;
    try {
      if (save.checkpoint) {
        const log = deserializeGameStateLog(gameData(), save.checkpoint as Parameters<typeof deserializeGameStateLog>[1]);
        const last = log.at(-1);
        if (!last) throw new Error("Saved game is empty");
        state = last.state;
      } else {
        const decks = (humanWho === 0 ? [save.deck, save.botDeck] : [save.botDeck, save.deck]) as [DeckInput, DeckInput];
        state = Game.createInitialState({ data: gameData(), decks, randomSeed: save.seed });
      }
    } catch (e) {
      persist({ error: `Couldn't load the saved game: ${(e as Error).message}` });
      return;
    }

    disposeBoard?.();
    if (!save.checkpoint) feed.clear();
    createRoot((dispose) => {
      disposeBoard = dispose;
      const [clientIo, Chessboard] = createClient(humanWho, {
        assetsManager: () => assets(),
        locale: () => "en",
        onGiveUp: () => giveUp(),
      });
      io = clientIo;
      setGame({ who: humanWho, gameNumber: save.gameNumber, resumed: !!save.checkpoint, key: gen, Chessboard });
    });

    const g = new Game(state, { errorLevel: "toleratePreview" });
    engine = g;
    surrendered = false;
    // Pause before each of the computer's moves, long enough to read the callout
    // of what just happened before the next thing happens.
    bot = createBot(botWho, { thinkMs: BOT_PACE_MS[getEffects()], randomness: 0.6 });
    const board = io!;
    g.players[humanWho].io = {
      notify: (n) => {
        if (gen !== generation) return;
        board.notify(n);
        feed.push(n);
      },
      rpc: (req) => Promise.resolve(board.rpc(req)),
    };
    g.players[botWho].io = bot;
    g.onPause = async (s, _m, canResume) => {
      if (!canResume || gen !== generation) return;
      persist({ checkpoint: serializeGameStateLog([{ state: s, canResume: true }]), round: s.roundNumber, error: null });
    };
    publish();

    g.start().then(
      (winner) => {
        if (gen !== generation) return;
        engine = null;
        persist({
          checkpoint: null,
          result: {
            winnerSeat: winner === null ? null : winner === humanWho ? 0 : 1,
            reason: surrendered ? "surrender" : winner === null ? "draw" : "victory",
            at: Date.now(),
          },
        });
      },
      (err: unknown) => {
        if (gen !== generation) return;
        console.error("Engine error", err);
        engine = null;
        persist({ error: err instanceof Error ? err.message : String(err) });
      },
    );
  };

  const giveUp = () => {
    if (engine) {
      surrendered = true;
      engine.giveUp(save.humanWho);
    } else if (!save.result) {
      // Engine not running (e.g. after an error): conclude directly.
      stop();
      persist({ checkpoint: null, result: { winnerSeat: 1, reason: "surrender", at: Date.now() } });
    }
  };

  /** The same messages the table sends to the server, handled locally. */
  const send = (msg: ClientMessage) => {
    if (disposed) return;
    switch (msg.t) {
      case "giveUp":
        return giveUp();
      case "rematch":
        stop();
        save = newCpuGame(save, save.gameNumber + 1);
        saveCpuGame(save);
        return start();
      case "retry":
        return start();
      case "chat":
        return setNotice({ text: "The computer doesn't chat.", at: Date.now() });
    }
  };

  publish();
  if (!save.result && !save.error) start();

  return {
    link,
    closedReason,
    room,
    game,
    chat,
    notice,
    log: feed.lines,
    send,
    dispose() {
      disposed = true;
      stop();
      disposeBoard?.();
    },
  };
}
