import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { CloseCode, MAX_MESSAGE_BYTES, type ClientMessage, type Seat, type ServerMessage } from "../shared/protocol.ts";
import { FileRoomStore } from "./storage.ts";
import { RoomError, RoomManager, type Connection } from "./rooms.ts";
import { ENGINE_VERSION, gameData } from "./cards.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from source (server/) and from the bundle (dist/server/).
const projectRoot = fs.existsSync(path.join(here, "..", "package.json")) ? path.join(here, "..") : path.join(here, "..", "..");

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(projectRoot, "data", "rooms"));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? path.join(projectRoot, "dist", "client"));
const ROOM_TTL_DAYS = Number(process.env.ROOM_TTL_DAYS ?? 14);
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 25_000;

export const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

export async function createServer(opts: { dataDir?: string; staticDir?: string | null; quiet?: boolean } = {}) {
  const logger = opts.quiet ? () => {} : log;
  const store = new FileRoomStore(opts.dataDir ?? DATA_DIR);
  await store.init();
  const rooms = new RoomManager(store, logger);
  gameData(); // warm the card data so the first game starts instantly
  const staticDir = opts.staticDir === undefined ? STATIC_DIR : opts.staticDir;

  const sweep = async () => {
    const n = await store.sweep(ROOM_TTL_DAYS * 86_400_000, (id) => rooms.isLive(id)).catch(() => 0);
    if (n) logger(`expired ${n} idle room(s)`);
  };
  void sweep();
  const sweepTimer = setInterval(sweep, 6 * 3_600_000);
  sweepTimer.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, rooms);
      if (staticDir) return serveStatic(staticDir, url.pathname, res);
      res.writeHead(404).end();
    } catch (e) {
      if (e instanceof RoomError) return json(res, e.status, { error: e.message });
      logger(`http error: ${e instanceof Error ? e.stack : e}`);
      if (!res.headersSent) json(res, 500, { error: "Internal server error" });
    }
  });

  // ------------------------------------------------------------- WebSockets
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();
  let heartbeat: NodeJS.Timeout | null = null;
  // Only tick while somebody is connected, so an idle server does no work at all.
  const syncHeartbeat = () => {
    if (wss.clients.size > 0 && !heartbeat) {
      heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
          if (alive.get(ws) === false) {
            ws.terminate();
            continue;
          }
          alive.set(ws, false);
          ws.ping();
        }
      }, HEARTBEAT_MS);
    } else if (wss.clients.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://local");
    if (pathname !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    syncHeartbeat();

    const conn: Connection = {
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    let bound: { roomId: string; seat: Seat } | null = null;
    let authing = false;
    const authTimer = setTimeout(() => !bound && ws.close(CloseCode.Unauthorized, "Authentication timeout"), AUTH_TIMEOUT_MS);

    ws.on("message", async (raw, isBinary) => {
      if (isBinary) return;
      let msg: ClientMessage | null = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (!bound) {
        if (msg.t !== "auth" || authing) return;
        authing = true;
        const roomId = String(msg.room ?? "").toUpperCase();
        const seat = await rooms.connect(roomId, String(msg.token ?? ""), conn).catch(() => null);
        clearTimeout(authTimer);
        if (seat === null) return ws.close(CloseCode.Unauthorized, "Unknown room or seat");
        if (ws.readyState !== ws.OPEN) return rooms.disconnect(roomId, seat, conn);
        bound = { roomId, seat };
        return;
      }
      rooms.handleMessage(bound.roomId, bound.seat, conn, msg);
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (bound) rooms.disconnect(bound.roomId, bound.seat, conn);
      syncHeartbeat();
    });
    ws.on("error", () => ws.terminate());
  });

  const close = async () => {
    clearInterval(sweepTimer);
    if (heartbeat) clearInterval(heartbeat);
    await rooms.shutdown();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  };

  return { server, rooms, close };
}

// ------------------------------------------------------------------- HTTP API

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, rooms: RoomManager) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  if (req.method === "GET" && parts[1] === "health") {
    return json(res, 200, { ok: true, liveRooms: rooms.liveRooms, runningGames: rooms.runningGames });
  }
  if (req.method === "GET" && parts[1] === "meta") {
    return json(res, 200, { version: ENGINE_VERSION });
  }
  if (parts[1] !== "rooms") return json(res, 404, { error: "Not found" });

  if (req.method === "POST" && parts.length === 2) {
    const body = await readJson(req);
    return json(res, 201, await rooms.create(body.name, body.deck));
  }
  const id = String(parts[2] ?? "").toUpperCase();
  if (req.method === "GET" && parts.length === 3) {
    const info = await rooms.info(id);
    return info ? json(res, 200, info) : json(res, 404, { error: "Room not found. It may have expired." });
  }
  if (req.method === "POST" && parts.length === 4 && parts[3] === "join") {
    const body = await readJson(req);
    return json(res, 200, await rooms.join(id, body.name, body.deck));
  }
  return json(res, 404, { error: "Not found" });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new RoomError(413, "Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new RoomError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// --------------------------------------------------------------- static files

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(dir: string, pathname: string, res: http.ServerResponse) {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return res.writeHead(400).end();
  }
  let file = path.join(dir, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(dir)) return res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, "index.html");
  if (!fs.existsSync(file)) return res.writeHead(404, { "content-type": "text/plain" }).end("Client not built. Run `npm run build`.");
  const ext = path.extname(file);
  const immutable = rel.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(file).pipe(res);
}
