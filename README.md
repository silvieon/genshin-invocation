# genshin-invocation

Web client player for Genshin Impact's Genius Invokation TCG: two players on two machines play one authoritative game on a server, Pokémon Showdown style.

## Quick start

```sh
npm install
npm run dev        # http://localhost:5173 (Vite + hot reload; game server on :8787)
```

Production:

```sh
npm run build      # card db extract + client bundle + server bundle
npm start          # http://localhost:8787 serves the app, API and WebSocket
npm test           # integration tests (real WebSockets, real engine) + computer-opponent games
```

Requires Node 22+.

## How it plays

1. Pick a name and a deck. Build one in the full deck builder, import a share code, or click **Random deck**.
2. **Create a room** and send the invite link (or the 6-character code) to your opponent.
3. When both players are at the table, the server starts the game engine. Every action is a server-validated RPC; the browser only renders.
4. If either player leaves (closes the tab, loses wifi, puts the phone to sleep), the engine is shut down immediately and the game waits on disk. When both are back, it resumes from the last checkpoint. Checkpoints are taken after every action.
5. After the game: **Rematch** (both must agree; the first player is re-randomised) or go home. Rooms idle for 14 days are deleted.

### Versus the computer

**Play vs Computer** on the home page runs the whole game in the browser: the same `@gi-tcg/core` engine the server uses, plus a heuristic opponent (`shared/bot.ts`). The server does no work for these games. Each legal action the engine offers carries a preview of its immediate result (damage, defeats, heals), so the bot scores every action from that preview plus a few rules of thumb (save dice for attacks, use bursts, retreat badly hurt characters, sensible rerolls and mulligans). A decision takes well under a millisecond. The game saves to `localStorage` after every action, so closing the tab and coming back resumes it. The engine chunk (~210 KB gzipped) is only downloaded when this mode is opened.

The board rotates automatically for portrait phones (⟳ button to override). The table also has **Chat** and a searchable **Rules & keywords** glossary.

## Architecture

```
browser (SolidJS)                              server (Node, one process)
┌──────────────────────────┐   WebSocket   ┌───────────────────────────────────────────┐
│ @gi-tcg/web-ui-core board│◄────────────► │ RoomManager                               │
│  io.notify / io.rpc      │  JSON + b64   │  ├─ room record on disk (data/rooms/*.json)│
│ @gi-tcg/deck-builder     │   protobuf    │  └─ GameSession  ◄─ only while BOTH online │
│ service worker: card art │               │       @gi-tcg/core Game + @gi-tcg/data     │
└──────────────────────────┘               └───────────────────────────────────────────┘
```

- **`server/session.ts`**: one `Game` per room, the single source of truth. Each player's `PlayerIO` forwards engine notifications and RPC requests over the socket. Malformed or illegal answers are asked again instead of forfeiting the game. Every resumable engine pause (`onPause` with `canResume`) is serialized with `serializeGameStateLog`, about 7 KB and under 1 ms.
- **`server/rooms.ts`**: room lifecycle. A room is held in memory only while someone is connected, and the engine only runs while *both* are. An idle server holds nothing and runs no timers apart from a 6-hourly expiry sweep.
- **`server/storage.ts`**: one JSON file per room, written atomically (temp file + rename), with saves coalesced per room.
- **`server/index.ts`**: HTTP API (`POST /api/rooms`, `POST /api/rooms/:id/join`, `GET /api/rooms/:id`, `/api/meta`, `/api/health`), the `/ws` socket (first message authenticates with the seat token), and static file serving. Players are identified by a random seat token kept in their browser's localStorage, and the server stores only its hash.
- **`client/`**: SolidJS + Vite. The Room and deck-editor pages are lazy-loaded.

## Data sources

| Source | Used for |
| --- | --- |
| [`@gi-tcg/core`](https://github.com/piovium/genius-invokation) + `@gi-tcg/data` | Rules engine and every card's behaviour (v7.1.0 card pool) |
| gi-tcg static-data API (via `@gi-tcg/assets-manager`) | Card names, text and official card art, pinned to the engine's version so the deck builder only offers playable cards |
| [`@genshin-db/tcg`](https://github.com/theBowja/genshin-db) | Fills gaps: the keyword/reaction-rules glossary, and card-face filenames the service worker uses to fetch the same art from a mirror if the primary image API is down |

genshin-db's dataset is about 60 MB, so it is never loaded at runtime: `scripts/build-carddb.mjs` extracts the ~120 KB this app needs into `client/public/carddb/` at build time.

The service worker (`client/public/sw.js`) caches card art permanently after the first view, so each device downloads each image once. It also works around a few misnamed board-decoration URLs in web-ui-core 0.21.

## Deploying to the public internet

The production server is one Node process that serves the app, the API and the WebSocket on a single port. Anywhere that can run a Docker container (or Node 22), keep a small persistent disk, and pass WebSockets through will work. Players just open the URL; there is nothing to install.

**Fly.io (scales to zero when idle):** `Dockerfile` and `fly.toml` are included.

```sh
fly launch --copy-config --no-deploy   # pick a unique app name / region
fly volumes create gi_data --size 1    # saved games live here
fly deploy
```

`auto_stop_machines` stops the server when nobody is connected and starts it again on the next visit (a couple of seconds' cold start), so an idle deployment costs next to nothing. Saved games survive because they're on the volume. Run a single machine: rooms live in one process.

**Your own PC, free:** run `npm run build && npm start`, then expose port 8787 with a tunnel, e.g. `cloudflared tunnel --url http://localhost:8787` (prints a public https URL). It only works while the PC is on.

**Any VPS:** `docker build -t gi . && docker run -d -p 80:8080 -v gi-data:/data gi`, then put HTTPS in front (Caddy, nginx, or Cloudflare) and forward WebSocket upgrades on `/ws`.

## Configuration

| Env var | Default | |
| --- | --- | --- |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `./data/rooms` | where saved games live; back this up/persist it in deployment |
| `ROOM_TTL_DAYS` | `14` | rooms untouched this long are deleted |

Behind a reverse proxy, forward WebSocket upgrades on `/ws`. `STATIC_DIR` overrides where the built client is served from.

## Notes / gotchas

- `@gi-tcg/core` uses `using` declarations, which Node 22 can't parse, so the server is bundled with esbuild (`scripts/build-server.mjs`), which lowers them. That is also why tests run from a bundle rather than through `tsx`.
- `@genshin-db/tcg` is pinned to **5.2.15**: 5.2.16 was published with the non-TCG dataset in it.
- The `@gi-tcg/*` packages move in lockstep and are pinned to the same exact version. Upgrading them updates the playable card pool.

Card art © HoYoverse. Fan project, not affiliated with HoYoverse.
