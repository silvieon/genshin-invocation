// End-to-end tests of online rooms against a real server instance on a random
// port: create/join over HTTP, play over WebSockets with scripted clients,
// disconnect mid-game (engine must stop, game must be saved), reconnect and
// resume, restart the server and resume from disk, rematch, and bad input.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import {
  ActionValidity,
  Notification,
  RpcRequest,
  RpcResponse,
  base64Decode,
  base64Encode,
} from "@gi-tcg/typings";
import { createServer } from "../index.ts";
import { sampleDeck } from "../cards.ts";
import type { JoinResult, RoomView, ServerMessage } from "../../shared/protocol.ts";

type Server = Awaited<ReturnType<typeof createServer>>;

async function startServer(dataDir: string) {
  const srv = await createServer({ dataDir, staticDir: null, quiet: true });
  await new Promise<void>((r) => srv.server.listen(0, "127.0.0.1", () => r()));
  const port = (srv.server.address() as AddressInfo).port;
  return { ...srv, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

async function post(base: string, p: string, body: unknown) {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

/**
 * Minimal automated player speaking the real wire protocol: it uses a skill
 * when it can, otherwise ends its round; defaults for every other prompt.
 */
class Bot {
  ws!: WebSocket;
  room: RoomView | null = null;
  messages: ServerMessage[] = [];
  notifications = 0;
  rpcs = 0;
  /** When set, answers this many action RPCs with garbage first. */
  sabotage = 0;
  /** Stop answering RPCs (simulates a player thinking). */
  paused = false;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  closed = new Promise<number>(() => {});

  constructor(
    readonly url: string,
    readonly join: JoinResult,
  ) {}

  connect() {
    this.ws = new WebSocket(this.url);
    this.closed = new Promise((r) => this.ws.on("close", (code) => r(code)));
    this.ws.on("open", () => this.ws.send(JSON.stringify({ t: "auth", room: this.join.roomId, token: this.join.token })));
    this.ws.on("message", (raw) => this.onMessage(JSON.parse(raw.toString())));
    return this;
  }

  private onMessage(m: ServerMessage) {
    this.messages.push(m);
    if (m.t === "room") this.room = m.room;
    if (m.t === "notify") {
      Notification.decode(base64Decode(m.data)); // must decode cleanly
      this.notifications++;
    }
    if (m.t === "rpc" && !this.paused) this.answer(m.id, RpcRequest.decode(base64Decode(m.data)));
    this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
  }

  answer(id: number, req: RpcRequest) {
    this.rpcs++;
    const r = req.request!;
    let res: RpcResponse["response"];
    switch (r.$case) {
      case "switchHands":
        res = { $case: "switchHands", value: { removedHandIds: [] } };
        break;
      case "rerollDice":
        res = { $case: "rerollDice", value: { diceToReroll: [] } };
        break;
      case "chooseActive":
        res = { $case: "chooseActive", value: { activeCharacterId: r.value.candidateIds[0] } };
        break;
      case "selectCard":
        res = { $case: "selectCard", value: { selectedDefinitionId: r.value.candidateDefinitionIds[0] } };
        break;
      case "action": {
        if (this.sabotage > 0) {
          this.sabotage--;
          res = { $case: "action", value: { chosenActionIndex: 9999, usedDice: [] } };
          break;
        }
        const actions = r.value.action;
        let idx = actions.findIndex((a) => a.action?.$case === "useSkill" && a.validity === ActionValidity.VALID);
        if (idx < 0) idx = actions.findIndex((a) => a.action?.$case === "declareEnd");
        res = { $case: "action", value: { chosenActionIndex: idx, usedDice: actions[idx].autoSelectedDice } };
        break;
      }
    }
    this.send({ t: "rpcResponse", id, data: base64Encode(RpcResponse.encode({ response: res }).finish()) });
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolves with the first matching message, looking at history first unless `fresh`. */
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 15_000, fresh = false): Promise<ServerMessage> {
    const hit = fresh ? undefined : this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  /** Resolves once the latest room view satisfies `pred` (now or on a later update). */
  waitRoom(pred: (r: RoomView) => boolean, timeoutMs?: number) {
    if (this.room && pred(this.room)) return Promise.resolve(this.room);
    return this.waitFor((m) => m.t === "room" && pred(m.room), timeoutMs, true).then((m) => (m as { room: RoomView }).room);
  }

  clear() {
    this.messages = [];
  }

  async close() {
    this.ws.close();
    await this.closed;
  }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gi-rooms-"));
const readRecord = (dir: string, id: string) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
/** Saves are asynchronous; poll until the record on disk satisfies `pred`. */
async function eventuallyOnDisk(dir: string, id: string, pred: (rec: any) => boolean, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const rec = readRecord(dir, id);
      if (pred(rec)) return rec;
    } catch {}
    if (Date.now() > until) throw new Error("record on disk never reached expected state");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setupRoom(s: { base: string }) {
  const a = await post(s.base, "/api/rooms", { name: "Aether", deck: sampleDeck(0) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await post(s.base, `/api/rooms/${a.body.roomId}/join`, { name: "Lumine", deck: sampleDeck(1) });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  return [a.body as JoinResult, b.body as JoinResult] as const;
}

test("rejects bad decks and unknown rooms", async () => {
  const s = await startServer(tmpDir());
  try {
    const bad = await post(s.base, "/api/rooms", { name: "x", deck: { characters: [1101], cards: [] } });
    assert.equal(bad.status, 400);
    const missing = await post(s.base, "/api/rooms/ZZZZZZ/join", { name: "x", deck: sampleDeck(0) });
    assert.equal(missing.status, 404);
    const [host] = await setupRoom(s);
    const full = await post(s.base, `/api/rooms/${host.roomId}/join`, { name: "x", deck: sampleDeck(0) });
    assert.equal(full.status, 409);
    const info = await (await fetch(`${s.base}/api/rooms/${host.roomId.toLowerCase()}`)).json();
    assert.equal(info.host, "Aether");
    assert.equal(info.status, "paused");
    // Wrong token is refused.
    const intruder = new Bot(s.wsUrl, { ...host, token: "nope" }).connect();
    assert.equal(await intruder.closed, 4003);
  } finally {
    await s.close();
  }
});

test("engine runs only while both players are connected, and resumes from the saved checkpoint", async () => {
  const dir = tmpDir();
  let s: Server & { base: string; wsUrl: string } = await startServer(dir);
  try {
    const [hostJoin, guestJoin] = await setupRoom(s);
    const id = hostJoin.roomId;

    const host = new Bot(s.wsUrl, hostJoin).connect();
    await host.waitRoom((r) => r.players[0]?.connected === true);
    assert.equal(s.rooms.runningGames, 0, "no engine with one player");
    assert.equal(host.room!.status, "paused");

    // Second player arrives: the engine starts and play proceeds.
    host.paused = true; // let the game sit at the first prompt
    const guest = new Bot(s.wsUrl, guestJoin).connect();
    const start = (await host.waitFor((m) => m.t === "gameStart")) as Extract<ServerMessage, { t: "gameStart" }>;
    assert.equal(start.resumed, false);
    await host.waitRoom((r) => r.status === "playing");
    assert.equal(s.rooms.runningGames, 1);

    // Let both play for a bit, so a few checkpoints are written.
    host.paused = false;
    // Answer the RPC that arrived while paused.
    const pendingRpc = host.messages.filter((m) => m.t === "rpc").at(-1) as Extract<ServerMessage, { t: "rpc" }> | undefined;
    if (pendingRpc) host.answer(pendingRpc.id, RpcRequest.decode(base64Decode(pendingRpc.data)));
    await host.waitRoom((r) => (r.round ?? 0) >= 2);
    await new Promise((r) => setTimeout(r, 100));

    // Guest leaves: engine is torn down immediately, the save stays.
    await guest.close();
    await host.waitRoom((r) => r.status === "paused" && r.players[1]?.connected === false);
    assert.equal(s.rooms.runningGames, 0, "engine freed when a player leaves");
    assert.ok(host.messages.some((m) => m.t === "cancelRpc"));
    const saved = await eventuallyOnDisk(dir, id, (r) => r.checkpoint && r.round >= 2);
    const savedRound = saved.round;
    assert.ok(savedRound >= 2);

    // Host leaves too: nothing about the room remains in memory.
    await host.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.rooms.liveRooms, 0, "room evicted from memory when empty");

    // Restart the whole server; both come back and the game continues where it was.
    await s.close();
    s = await startServer(dir);
    const host2 = new Bot(s.wsUrl, hostJoin).connect();
    const guest2 = new Bot(s.wsUrl, guestJoin).connect();
    const resumed = (await guest2.waitFor((m) => m.t === "gameStart")) as Extract<ServerMessage, { t: "gameStart" }>;
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.who, start.who === 0 ? 1 : 0, "seats keep their engine side across resume");
    await host2.waitFor((m) => m.t === "notify");
    const firstRoom = await host2.waitRoom((r) => r.status === "playing");
    assert.ok((firstRoom.round ?? 0) >= savedRound, "resumed at or after the saved round");

    // Play to the end.
    const done = await host2.waitRoom((r) => r.status === "finished", 60_000);
    assert.ok(done.result);
    assert.notEqual(done.result!.reason, "error");
    assert.equal(s.rooms.runningGames, 0);
    await eventuallyOnDisk(dir, id, (r) => r.checkpoint === null && r.result);

    // Rematch needs both players.
    host2.clear();
    host2.send({ t: "rematch" });
    await host2.waitRoom((r) => r.players[0]?.wantsRematch === true);
    assert.equal(s.rooms.runningGames, 0);
    guest2.send({ t: "rematch" });
    const g2 = (await host2.waitFor((m) => m.t === "gameStart")) as Extract<ServerMessage, { t: "gameStart" }>;
    assert.equal(g2.gameNumber, 2);
    assert.equal(g2.resumed, false);

    // Surrender ends it with the other seat winning.
    host2.send({ t: "giveUp" });
    const end = await guest2.waitRoom((r) => r.gameNumber === 2 && r.status === "finished");
    assert.equal(end.result!.reason, "surrender");
    assert.equal(end.result!.winnerSeat, 1);

    await host2.close();
    await guest2.close();
  } finally {
    await s.close();
  }
});

test("an invalid move is asked again instead of losing the game", async () => {
  const s = await startServer(tmpDir());
  try {
    const [hostJoin, guestJoin] = await setupRoom(s);
    const host = new Bot(s.wsUrl, hostJoin);
    const guest = new Bot(s.wsUrl, guestJoin);
    host.sabotage = 2;
    guest.sabotage = 2;
    host.connect();
    guest.connect();
    await host.waitFor((m) => m.t === "error" && /Invalid move/.test(m.message));
    await host.waitRoom((r) => (r.round ?? 0) >= 2);
    assert.equal(host.room!.status, "playing");
    assert.equal(host.room!.result, null);
    await host.close();
    await guest.close();
  } finally {
    await s.close();
  }
});

test("a second tab takes over the seat", async () => {
  const s = await startServer(tmpDir());
  try {
    const [hostJoin] = await setupRoom(s);
    const tab1 = new Bot(s.wsUrl, hostJoin).connect();
    await tab1.waitRoom((r) => r.players[0]?.connected === true);
    const tab2 = new Bot(s.wsUrl, hostJoin).connect();
    assert.equal(await tab1.closed, 4001);
    await tab2.waitRoom((r) => r.players[0]?.connected === true);
    await tab2.close();
  } finally {
    await s.close();
  }
});

test("accepts decks with v6.4 Blessing cards (flagged unobtainable in engine data)", async () => {
  const s = await startServer(tmpDir());
  try {
    const deck = { characters: [2101, 1418, 1204], cards: [312005,331005,333028,332060,333027,322025,321013,321022,311303,332023,322015,311102,332004,312202,312020,321023,330004,311207,312039,313007,332025,332031,321020,312032,333009,331302,333012,311307,322028,332002] };
    const r = await post(s.base, "/api/rooms", { name: "x", deck });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  } finally {
    await s.close();
  }
});
