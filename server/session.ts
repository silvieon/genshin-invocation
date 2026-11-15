// The bridge between one running gi-tcg engine and two WebSockets.
//
// The engine talks to each player through a PlayerIO: `notify` (state updates,
// fire-and-forget) and `rpc` (a question the player must answer: pick an
// action, reroll, choose a character...). Here both are encoded as protobuf,
// sent as `notify` / `rpc` messages, and the browser's `rpcResponse` resolves
// the engine's waiting promise. Seats (room order) and "who" (engine order,
// 0 moves first) are different: helpers below convert between them.

import {
  Game,
  serializeGameStateLog,
  deserializeGameStateLog,
  type GameState,
  type PlayerIO,
} from "@gi-tcg/core";
import {
  ActionValidity,
  Notification,
  RpcRequest,
  RpcResponse,
  base64Decode,
  base64Encode,
} from "@gi-tcg/typings";
import { gameData } from "./cards.ts";
import type { RoomRecord } from "./storage.ts";
import type { Seat, ServerMessage } from "../shared/protocol.ts";

export interface SessionHooks {
  /** A resumable checkpoint was reached (start of every phase step, i.e. after every action). */
  checkpoint(serialized: unknown, round: number): void;
  /** The game ended normally. `winner` is an engine player index. */
  finished(winner: 0 | 1 | null, surrenderedBy: Seat | null): void;
  /** The engine threw. The last checkpoint is still valid. */
  failed(error: Error): void;
}

export interface SessionOptions {
  record: RoomRecord;
  send(seat: Seat, msg: ServerMessage): void;
  hooks: SessionHooks;
  log?: (msg: string) => void;
}

interface PendingRpc {
  who: 0 | 1;
  request: RpcRequest;
  resolve(res: RpcResponse): void;
}

/** Engine player index for a seat in the room's current game. */
export const whoOfSeat = (record: Pick<RoomRecord, "firstSeat">, seat: Seat): 0 | 1 =>
  seat === record.firstSeat ? 0 : 1;
export const seatOfWho = (record: Pick<RoomRecord, "firstSeat">, who: 0 | 1): Seat =>
  (who === 0 ? record.firstSeat : 1 - record.firstSeat) as Seat;

/**
 * One running game: the single authoritative engine instance for a room.
 *
 * A session only exists while both players are connected. Stopping it drops the
 * engine entirely; the room keeps the last checkpoint and a later session
 * resumes from it. Outstanding RPC promises are simply abandoned on stop, so the
 * engine's main loop is left suspended and garbage-collected with the session.
 */
export class GameSession {
  private game: Game | null = null;
  private stopped = false;
  private nextRpcId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private surrenderedBy: Seat | null = null;
  readonly resumed: boolean;

  constructor(private readonly opts: SessionOptions) {
    this.resumed = opts.record.checkpoint != null;
  }

  get running() {
    return this.game !== null && !this.stopped;
  }

  /** Build the engine from the checkpoint (or a fresh state), wire its IO, and run it in the background. */
  start() {
    const { record } = this.opts;
    const data = gameData();
    let state: GameState;
    if (record.checkpoint) {
      const log = deserializeGameStateLog(data, record.checkpoint as Parameters<typeof deserializeGameStateLog>[1]);
      const last = log.at(-1);
      if (!last) throw new Error("Saved game is empty");
      state = last.state;
    } else {
      const deckOf = (who: 0 | 1) => record.seats[seatOfWho(record, who)]!.deck;
      state = Game.createInitialState({ data, decks: [deckOf(0), deckOf(1)], randomSeed: record.seed });
    }

    const game = new Game(state, { errorLevel: "toleratePreview" });
    this.game = game;
    game.onPause = async (s, _mutations, canResume) => {
      if (!canResume || this.stopped) return;
      this.opts.hooks.checkpoint(serializeGameStateLog([{ state: s, canResume: true }]), s.roundNumber);
    };
    game.onIoError = (e) => this.opts.log?.(`io error from player ${e.who}: ${e.message}`);
    game.players[0].io = this.createIo(0);
    game.players[1].io = this.createIo(1);

    for (const seat of [0, 1] as const) {
      this.opts.send(seat, {
        t: "gameStart",
        who: whoOfSeat(record, seat),
        resumed: this.resumed,
        gameNumber: record.gameNumber,
      });
    }

    game.start().then(
      (winner) => {
        if (this.stopped) return;
        this.stopped = true;
        this.pending.clear();
        this.opts.hooks.finished(winner, this.surrenderedBy);
      },
      (err: unknown) => {
        if (this.stopped) return;
        this.stopped = true;
        this.pending.clear();
        this.opts.hooks.failed(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  /** Tear down the engine. Safe to call more than once. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.pending.clear();
    try {
      this.game?.terminate();
    } catch {
      // terminate() on an already-finished game is harmless.
    }
    for (const seat of [0, 1] as const) this.opts.send(seat, { t: "cancelRpc" });
  }

  giveUp(seat: Seat) {
    if (!this.running) return;
    this.surrenderedBy = seat;
    this.game!.giveUp(whoOfSeat(this.opts.record, seat));
  }

  /** Answer to an RPC sent to `seat`. Invalid answers are re-asked instead of forfeiting the game. */
  handleRpcResponse(seat: Seat, id: number, data: string) {
    const p = this.pending.get(id);
    if (!p || this.stopped) return;
    if (p.who !== whoOfSeat(this.opts.record, seat)) return;
    let res: RpcResponse;
    try {
      res = RpcResponse.decode(base64Decode(data));
    } catch {
      this.reask(id, p, "Malformed response");
      return;
    }
    const problem = checkResponse(p.request, res);
    if (problem) {
      this.reask(id, p, problem);
      return;
    }
    this.pending.delete(id);
    p.resolve(res);
  }

  /** Tell the player what was wrong and send the same question again under a new id. */
  private reask(id: number, p: PendingRpc, why: string) {
    this.opts.log?.(`rejected response from player ${p.who}: ${why}`);
    this.pending.delete(id);
    const seat = seatOfWho(this.opts.record, p.who);
    this.opts.send(seat, { t: "error", message: `Invalid move (${why}). Please choose again.` });
    this.sendRpc(p);
  }

  private sendRpc(p: PendingRpc) {
    const id = this.nextRpcId++;
    this.pending.set(id, p);
    this.opts.send(seatOfWho(this.opts.record, p.who), {
      t: "rpc",
      id,
      data: base64Encode(RpcRequest.encode(p.request).finish()),
    });
  }

  /** The PlayerIO the engine uses for one player: forwards everything to that player's seat. */
  private createIo(who: 0 | 1): PlayerIO {
    const seat = seatOfWho(this.opts.record, who);
    return {
      notify: (notification) => {
        if (this.stopped) return;
        this.opts.send(seat, { t: "notify", data: base64Encode(Notification.encode(notification).finish()) });
      },
      rpc: (request) =>
        new Promise<RpcResponse>((resolve) => {
          // After stop() the promise is intentionally never settled (see class doc).
          if (this.stopped) return;
          this.sendRpc({ who, request, resolve });
        }),
    };
  }
}

/** Cheap sanity checks so a buggy or tampered client gets asked again rather than losing by engine error. */
export function checkResponse(req: RpcRequest, res: RpcResponse): string | null {
  const q = req.request;
  const a = res.response;
  if (!q || !a) return "Empty message";
  if (q.$case !== a.$case) return `Expected ${q.$case}, got ${a.$case}`;
  switch (q.$case) {
    case "action": {
      const { chosenActionIndex } = (a as Extract<typeof a, { $case: "action" }>).value;
      const action = q.value.action[chosenActionIndex];
      if (!action) return "No such action";
      if (action.validity !== ActionValidity.VALID) return "That action is not available";
      return null;
    }
    case "chooseActive": {
      const { activeCharacterId } = (a as Extract<typeof a, { $case: "chooseActive" }>).value;
      return q.value.candidateIds.includes(activeCharacterId) ? null : "Not a valid character";
    }
    case "selectCard": {
      const { selectedDefinitionId } = (a as Extract<typeof a, { $case: "selectCard" }>).value;
      return q.value.candidateDefinitionIds.includes(selectedDefinitionId) ? null : "Not a valid card";
    }
    default:
      return null;
  }
}
