// Rooms: the server's game logic, independent of HTTP and WebSockets.
//
// A room has two seats. Each seat is claimed with a name and deck and gets a
// secret token (stored only as a hash) that the browser keeps and later uses to
// reconnect to that seat. index.ts translates HTTP requests and socket
// messages into calls on RoomManager; RoomManager decides when to start, pause,
// resume or finish the engine (session.ts) and saves through a RoomStore.

import crypto from "node:crypto";
import {
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  type ClientMessage,
  type JoinResult,
  type PublicRoomInfo,
  type RoomStatus,
  type RoomView,
  type Seat,
  type ServerMessage,
} from "../shared/protocol.ts";
import { validateDeck } from "./cards.ts";
import { GameSession, seatOfWho, whoOfSeat } from "./session.ts";
import type { RoomRecord, RoomStore } from "./storage.ts";

/** One player's live socket, abstracted so rooms don't depend on the ws library (tests can fake it). */
export interface Connection {
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** An error meant for the player; index.ts turns it into an HTTP response with this status. */
export class RoomError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A room loaded into memory: its saved record plus whatever is live right now. */
interface LiveRoom {
  record: RoomRecord;
  conns: [Connection | null, Connection | null];
  session: GameSession | null;
  lastChatAt: [number, number];
}

/** No 0/O or 1/I, so codes survive being read aloud or retyped. */
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_ID_LENGTH = 6;
const CHAT_COOLDOWN_MS = 400;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const tokenMatches = (token: string, hash: string) => {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const cleanName = (name: unknown) => {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return s.slice(0, MAX_NAME_LENGTH) || "Traveler";
};
const randomSeed = () => crypto.randomInt(0, 2 ** 31 - 1);
const randomSeat = (): Seat => crypto.randomInt(0, 2) as Seat;

/**
 * Owns every room. A room lives on disk (RoomStore) and is only held in memory
 * while at least one player is connected; the engine (GameSession) only runs
 * while *both* are. Every resumable engine checkpoint is persisted, so players
 * can drop and come back later, or the server can restart, without losing more
 * than the decision in progress.
 */
export class RoomManager {
  private readonly live = new Map<string, LiveRoom>();
  private readonly loading = new Map<string, Promise<LiveRoom | null>>();

  constructor(
    private readonly store: RoomStore,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Number of engines currently running; exposed for health checks and tests. */
  get runningGames() {
    let n = 0;
    for (const r of this.live.values()) if (r.session?.running) n++;
    return n;
  }
  get liveRooms() {
    return this.live.size;
  }
  isLive(id: string) {
    return this.live.has(id);
  }

  // ---------------------------------------------------------------- HTTP API

  /** New room with the creator in seat 0. The returned token is the only copy; the server keeps its hash. */
  async create(name: unknown, deck: unknown): Promise<JoinResult> {
    const v = validateDeck(deck);
    if (!v.ok) throw new RoomError(400, v.error);
    let id: string;
    do {
      id = Array.from({ length: ROOM_ID_LENGTH }, () => ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)]).join("");
    } while (this.live.has(id) || (await this.store.get(id)));
    const token = crypto.randomBytes(24).toString("base64url");
    const now = Date.now();
    const record: RoomRecord = {
      v: 1,
      id,
      createdAt: now,
      updatedAt: now,
      seats: [{ name: cleanName(name), tokenHash: hashToken(token), deck: v.deck }, null],
      gameNumber: 1,
      firstSeat: randomSeat(),
      seed: randomSeed(),
      checkpoint: null,
      round: null,
      result: null,
      rematch: [false, false],
      error: null,
    };
    await this.store.put(record);
    this.log(`room ${id} created`);
    return { roomId: id, seat: 0, token };
  }

  /** Claim seat 1. The game starts later, once both players have a socket open. */
  async join(id: string, name: unknown, deck: unknown): Promise<JoinResult> {
    const v = validateDeck(deck);
    if (!v.ok) throw new RoomError(400, v.error);
    const room = await this.acquire(id);
    if (!room) throw new RoomError(404, "Room not found. It may have expired.");
    try {
      if (room.record.seats[1]) throw new RoomError(409, "This room already has two players.");
      const token = crypto.randomBytes(24).toString("base64url");
      room.record.seats[1] = { name: cleanName(name), tokenHash: hashToken(token), deck: v.deck };
      await this.persist(room);
      this.broadcastRoom(room);
      this.log(`room ${id} joined`);
      return { roomId: id, seat: 1, token };
    } finally {
      this.releaseIfIdle(room);
    }
  }

  /** What anyone with the room code may see (no tokens, no decks). */
  async info(id: string): Promise<PublicRoomInfo | null> {
    const room = this.live.get(id);
    const record = room?.record ?? (await this.store.get(id));
    if (!record) return null;
    return {
      id: record.id,
      status: room ? this.status(room) : this.statusOf(record, false),
      host: record.seats[0]?.name ?? null,
      guest: record.seats[1]?.name ?? null,
    };
  }

  // ----------------------------------------------------------- connections

  /** Attach an authenticated socket to its seat. Returns the seat, or null if the credentials are bad. */
  async connect(id: string, token: string, conn: Connection): Promise<Seat | null> {
    const room = await this.acquire(id);
    if (!room) return null;
    const seat = ([0, 1] as const).find((s) => {
      const rec = room.record.seats[s];
      return rec && typeof token === "string" && tokenMatches(token, rec.tokenHash);
    });
    if (seat === undefined) {
      this.releaseIfIdle(room);
      return null;
    }
    const previous = room.conns[seat];
    room.conns[seat] = conn;
    if (previous) previous.close(4001, "Opened in another tab");
    this.log(`room ${id}: seat ${seat} connected`);
    this.maybeStart(room);
    this.broadcastRoom(room);
    return seat;
  }

  /** A socket closed. If it was the seat's current one, pause the game (stop the engine) and maybe unload the room. */
  disconnect(id: string, seat: Seat, conn: Connection) {
    const room = this.live.get(id);
    if (!room || room.conns[seat] !== conn) return;
    room.conns[seat] = null;
    this.log(`room ${id}: seat ${seat} disconnected`);
    if (room.session) {
      // Free the engine immediately; the last checkpoint is already on disk.
      room.session.stop();
      room.session = null;
      this.log(`room ${id}: engine stopped, game saved at round ${room.record.round ?? 0}`);
    }
    room.record.rematch[seat] = false;
    void this.persist(room);
    this.broadcastRoom(room);
    this.releaseIfIdle(room);
  }

  /** A message from an authenticated seat. Messages from a socket that has since been replaced are dropped. */
  handleMessage(id: string, seat: Seat, conn: Connection, msg: ClientMessage) {
    const room = this.live.get(id);
    if (!room || room.conns[seat] !== conn) return;
    switch (msg.t) {
      case "auth":
        return;
      case "ping":
        conn.send({ t: "pong" });
        return;
      case "rpcResponse":
        if (typeof msg.id === "number" && typeof msg.data === "string") {
          room.session?.handleRpcResponse(seat, msg.id, msg.data);
        }
        return;
      case "giveUp":
        this.giveUp(room, seat);
        return;
      case "rematch":
        if (!room.record.result) return;
        room.record.rematch[seat] = true;
        if (room.record.rematch[0] && room.record.rematch[1]) this.newGame(room);
        else this.broadcastRoom(room);
        return;
      case "retry":
        if (!room.record.error) return;
        room.record.error = null;
        this.maybeStart(room);
        this.broadcastRoom(room);
        return;
      case "chat": {
        const text = typeof msg.text === "string" ? msg.text.trim().slice(0, MAX_CHAT_LENGTH) : "";
        const now = Date.now();
        if (!text || now - room.lastChatAt[seat] < CHAT_COOLDOWN_MS) return;
        room.lastChatAt[seat] = now;
        const out: ServerMessage = { t: "chat", seat, name: room.record.seats[seat]!.name, text, at: now };
        for (const c of room.conns) c?.send(out);
        return;
      }
    }
  }

  /** Stop every engine and flush every live room; used on shutdown. */
  async shutdown() {
    const rooms = [...this.live.values()];
    for (const room of rooms) {
      room.session?.stop();
      room.session = null;
      for (const c of room.conns) c?.close(1012, "Server restarting");
    }
    await Promise.all(rooms.map((r) => this.persist(r)));
    this.live.clear();
  }

  // -------------------------------------------------------------- internals

  /** Load a room into memory (once, even if several requests ask at the same moment). */
  private async acquire(id: string): Promise<LiveRoom | null> {
    id = String(id).toUpperCase();
    const existing = this.live.get(id);
    if (existing) return existing;
    let p = this.loading.get(id);
    if (!p) {
      p = this.store
        .get(id)
        .then((record) => {
          if (!record) return null;
          const room: LiveRoom = { record, conns: [null, null], session: null, lastChatAt: [0, 0] };
          this.live.set(id, room);
          return room;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  /** Drop a room from memory once nobody is connected; it stays on disk. */
  private releaseIfIdle(room: LiveRoom) {
    if (!room.conns[0] && !room.conns[1] && !room.session && this.live.get(room.record.id) === room) {
      this.live.delete(room.record.id);
    }
  }

  private persist(room: LiveRoom) {
    room.record.updatedAt = Date.now();
    return this.store.put(room.record).catch((e) => this.log(`room ${room.record.id}: save failed: ${e}`));
  }

  private status(room: LiveRoom): RoomStatus {
    return this.statusOf(room.record, !!room.session?.running);
  }

  private statusOf(record: RoomRecord, running: boolean): RoomStatus {
    if (!record.seats[1]) return "open";
    if (running) return "playing";
    if (record.result) return "finished";
    return "paused";
  }

  /** The room as one particular seat sees it (sent as a `room` message on every change). */
  private view(room: LiveRoom, you: Seat): RoomView {
    const { record } = room;
    const player = (s: Seat) =>
      record.seats[s]
        ? { name: record.seats[s]!.name, connected: !!room.conns[s], wantsRematch: record.rematch[s] }
        : null;
    return {
      id: record.id,
      status: this.status(room),
      you,
      players: [player(0), player(1)],
      whoOfSeat: [whoOfSeat(record, 0), whoOfSeat(record, 1)],
      gameNumber: record.gameNumber,
      round: record.result ? null : record.round,
      result: record.result,
      error: record.error,
    };
  }

  private broadcastRoom(room: LiveRoom) {
    for (const s of [0, 1] as const) room.conns[s]?.send({ t: "room", room: this.view(room, s) });
  }

  /**
   * Start (or resume from the checkpoint) the engine if, and only if, both
   * players are connected and the game isn't over or broken. The hooks keep the
   * record on disk in step with the engine.
   */
  private maybeStart(room: LiveRoom) {
    const { record } = room;
    if (room.session || !room.conns[0] || !room.conns[1] || !record.seats[1] || record.result || record.error) return;
    const session = new GameSession({
      record,
      send: (seat, msg) => room.conns[seat]?.send(msg),
      log: (m) => this.log(`room ${record.id}: ${m}`),
      hooks: {
        checkpoint: (serialized, round) => {
          if (room.session !== session) return;
          const roundChanged = record.round !== round;
          record.checkpoint = serialized;
          record.round = round;
          void this.persist(room);
          if (roundChanged) this.broadcastRoom(room);
        },
        finished: (winner, surrenderedBy) => {
          if (room.session !== session) return;
          room.session = null;
          record.result = {
            winnerSeat: winner === null ? null : seatOfWho(record, winner),
            reason: surrenderedBy !== null ? "surrender" : winner === null ? "draw" : "victory",
            at: Date.now(),
          };
          record.checkpoint = null;
          record.round = null;
          this.log(`room ${record.id}: game ${record.gameNumber} finished (${record.result.reason})`);
          void this.persist(room);
          this.broadcastRoom(room);
          this.releaseIfIdle(room);
        },
        failed: (error) => {
          if (room.session !== session) return;
          room.session = null;
          record.error = error.message || "Engine error";
          this.log(`room ${record.id}: engine error: ${error.stack ?? error.message}`);
          void this.persist(room);
          for (const c of room.conns) c?.send({ t: "cancelRpc" });
          this.broadcastRoom(room);
          this.releaseIfIdle(room);
        },
      },
    });
    room.session = session;
    try {
      session.start();
      this.log(`room ${record.id}: engine started (${session.resumed ? `resumed at round ${record.round}` : "new game"})`);
    } catch (e) {
      room.session = null;
      record.error = e instanceof Error ? e.message : String(e);
      this.log(`room ${record.id}: failed to start engine: ${record.error}`);
      void this.persist(room);
    }
  }

  private giveUp(room: LiveRoom, seat: Seat) {
    const { record } = room;
    if (record.result || !record.seats[1]) return;
    if (room.session?.running) {
      room.session.giveUp(seat);
      return;
    }
    // No engine running (opponent offline, or engine error): conclude directly.
    room.session = null;
    record.result = { winnerSeat: (1 - seat) as Seat, reason: "surrender", at: Date.now() };
    record.checkpoint = null;
    record.round = null;
    record.error = null;
    void this.persist(room);
    this.broadcastRoom(room);
  }

  /** Both players asked for a rematch: same decks, new seed, first player re-drawn. */
  private newGame(room: LiveRoom) {
    const { record } = room;
    record.gameNumber++;
    record.firstSeat = randomSeat();
    record.seed = randomSeed();
    record.checkpoint = null;
    record.round = null;
    record.result = null;
    record.error = null;
    record.rematch = [false, false];
    void this.persist(room);
    this.maybeStart(room);
    this.broadcastRoom(room);
  }
}
