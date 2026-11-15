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

### Display settings (home page)

- **Card art:** high resolution (420×720 card faces, the default) or data saver (80×137 thumbnails). Either way each image downloads once per device.
- **Board effects:** *Fast* (default) runs the board's animations at about a third of their length (at most 300 ms each). The board waits for its animations before showing the next event, so this speeds up play itself. *Off* makes everything instant. *Full* keeps the original timings.

- **Battle log:** like Pokémon Showdown's, every action and what it caused (damage by element, reactions, defeats, heals, summons, statuses, cards played, switches, draws) is written to a scrolling log. On wide screens it sits in a column beside the board, and **Log** in the top bar hides or shows it. On narrow screens **Log** opens it as a drawer. Each action and its effects also pop up briefly in the middle of the board, so you can follow the play without looking away. Against the computer, it pauses about a second before each move so there's time to read what happened.

Pages never blank out while waiting on the network: there is no page-wide loading screen. Data and card art fill in where they belong, and page code is prefetched while the browser is idle.

The board rotates automatically for portrait phones (⟳ button to override). The table also has **Chat** and a searchable **Rules & keywords** glossary.

## Architecture: client and server

The rules engine (`@gi-tcg/core`) is a plain TypeScript library that runs anywhere JavaScript runs. It talks to each player through a `PlayerIO` with two calls:

- **`notify(notification)`**: "here is what changed", fire and forget. The board animates it.
- **`rpc(request) → response`**: "your move". Pick an action, choose which dice to reroll, which cards to swap back, which character goes in. The engine waits for the answer.

The whole design comes down to **where the engine runs and what sits on the other end of each `PlayerIO`.**

```
ONLINE ROOM: the engine runs on the server; both browsers only render and answer
┌─ browser A ──────────────┐                 ┌─ server (one Node process) ──────────────┐
│ Table  (pages/Room.tsx)  │                 │ index.ts    HTTP API · /ws · static files│
│  └ board (web-ui-core)   │   WebSocket     │ rooms.ts    seats, tokens, start/pause   │
│      ▲ notify │ rpc      │◄──────────────► │ session.ts  Game ◄─ PlayerIO per seat    │
│ connection.ts  connect() │ JSON + base64   │ storage.ts  data/rooms/<CODE>.json       │
└──────────────────────────┘    protobuf     └──────────────────────────────────────────┘
┌─ browser B ──────────────┐                        ▲
│ same as A                │◄───────────────────────┘
└──────────────────────────┘

VS COMPUTER: the engine runs in the browser; the server only served the page
┌─ browser ───────────────────────────────────────────────────────────┐
│ Table (pages/Room.tsx)                                              │
│  └ board (web-ui-core) ◄── PlayerIO ── Game ── PlayerIO ──► bot.ts  │
│ cpu/localGame.ts  connectLocal()          checkpoint → localStorage │
└─────────────────────────────────────────────────────────────────────┘
```

### What the server owns

- **The truth for online games.** Only the server's engine decides what happens. A browser can only answer the questions it's asked; a malformed or illegal answer is asked again (`session.ts`, `checkResponse`) rather than trusted.
- **Seats.** Creating or joining a room returns a random **seat token**. The browser keeps it in localStorage and the server stores only its hash. The first WebSocket message must present it (`{t:"auth"}`), which is how a returning player gets their seat back from any tab, after any disconnect.
- **Saving.** After every action the engine pauses at a resumable point, and the server serializes the state (~7 KB) into the room's JSON file. A room file is the whole room: seats, decks, seed, checkpoint and result. Restarting the server loses nothing.
- **Compute only while it's needed.** A room is in memory only while someone is connected, and its engine runs only while *both* players are. When either leaves, the engine is discarded and the game waits on disk. When both are back, a new engine resumes from the checkpoint and each browser gets a fresh board, which the first notification brings up to date.

### What the client owns

- **All rendering and input.** The board (`@gi-tcg/web-ui-core`) and deck builder (`@gi-tcg/deck-builder`) are gi-tcg's own UI components. Our code wraps them in pages, a top bar, overlays and drawers.
- **Everything personal.** Decks, display name, settings, seat tokens and the vs-computer save are kept in this browser's localStorage (`local.ts`). The server never sees a deck until it's used to sit down.
- **Card data and art.** These go directly from the gi-tcg static-data service to the browser and are cached by the service worker. The server only says which card-pool version its engine implements (`/api/meta`), so the client never offers a card the engine can't play.
- **Games against the computer, entirely.** The same engine package and the bot run in the tab. The server isn't contacted after the page loads.

### How they fit together

**`shared/` is the contract.** `protocol.ts` defines every message in both directions and the `RoomView` that describes a room's state. Game traffic is the engine's own protobuf messages (`@gi-tcg/typings`), base64-encoded inside small JSON envelopes. Both sides import this one file, so they can't drift apart.

**The table doesn't know where its game lives.** `pages/Room.tsx`'s `Table` takes a `Connection`: signals for the room, the board, chat and the event log, plus `send()`. There are two implementations:

| | `connect()` (`connection.ts`) | `connectLocal()` (`cpu/localGame.ts`) |
| --- | --- | --- |
| Engine runs | on the server | in this tab |
| Board's `PlayerIO` fed by | WebSocket messages `notify` / `rpc` | the engine directly |
| Opponent | the other browser, via the server | `shared/bot.ts` |
| `RoomView` comes from | the server's `room` messages | built locally to the same shape |
| `send({t:"giveUp" / "rematch" / "retry"})` | sent to the server | handled locally |
| Saved to | `data/rooms/<CODE>.json` on the server | `localStorage["gi.cpu"]` |

**The lifecycle of an online move:**
1. The engine needs a decision from player 0 and calls `rpc()` on that player's `PlayerIO` (`session.ts`).
2. The server encodes the request and sends `{t:"rpc", id, data}` to that seat's socket.
3. `connection.ts` decodes it and hands it to the board, which shows the choices.
4. The player clicks. The board resolves, and the browser sends back `{t:"rpcResponse", id, data}`.
5. The server checks the answer and resolves the engine's promise. The engine applies the move and `notify()`s both players.
6. The engine reaches its next resumable pause, and `rooms.ts` writes the checkpoint to disk.

If a socket drops anywhere in that sequence, the server sends `cancelRpc`, stops the engine, and keeps the step 6 checkpoint from the previous move. Nothing half-done is ever saved.

**Seat vs `who`.** A *seat* is your place in the room: 0 created it, 1 joined. *`who`* is the engine's player index, and player 0 moves first. Who goes first is re-drawn every game, so the two are mapped per game (`whoOfSeat` / `seatOfWho` in `session.ts`, sent to the client as `RoomView.whoOfSeat`).

## Project layout

```
client/                         the browser app (SolidJS, built by Vite into dist/client)
  index.html                    page shell; loads src/main.tsx
  public/
    sw.js                       service worker: caches card art forever, falls back to a mirror,
                                patches a few broken board-decoration URLs
    manifest.webmanifest        installable-app metadata
    favicon.svg
    carddb/                     (generated at build) glossary + art filenames from genshin-db
  src/
    main.tsx                    entry: stylesheets, board-effects setting, mount <App/>, register sw
    App.tsx                     hash router; lazy-loads and idle-prefetches the heavy pages;
                                keeps the current page up until the next one's code is ready
    connection.ts               Connection interface + connect(): online seat over a WebSocket,
                                auto-reconnect, feeds the board's notify/rpc
    cpu/localGame.ts            connectLocal(): vs-computer game run in the tab (engine + bot),
                                checkpointed to localStorage; deck validation for it
    api.ts                      HTTP calls: create room, join room, room info
    assets.ts                   card names/art/share-codes (static-data service), pinned to the
                                engine's card-pool version; high-res art switch; glossary loader
    local.ts                    everything kept in localStorage: name, decks, seat tokens,
                                settings, the vs-computer save
    eventFeed.ts                turns engine notifications into the battle log (grouped, typed lines)
    effects.ts                  board-effects setting (Fast/Off/Full): rescales the board's animations
    async.ts                    fetchValue(): load data without blanking the page
    styles.css                  all of our own styling
    pages/
      Home.tsx                  landing page: name, deck, settings, create/join, vs computer, your rooms
      Room.tsx                  #/room/<code>: join form, and Table (the game screen used by both modes)
      Cpu.tsx                   #/cpu: vs-computer setup, then Table with a local connection
      DeckEditor.tsx            #/decks/<id>: gi-tcg deck builder + share codes
    components/
      DeckPicker.tsx            saved-deck list with New / Random / Import
      Chat.tsx                  in-room chat drawer
      Glossary.tsx              searchable rules & keywords drawer
      BattleLog.tsx             the scrolling battle log, and the on-board callouts of the latest action

server/                         the game server (Node; bundled by esbuild into dist/server)
  main.ts                       process entry: listen on PORT, save everything on SIGINT/SIGTERM
  index.ts                      HTTP API, /ws WebSocket (auth handshake, heartbeats), static files
  rooms.ts                      RoomManager: seats and tokens, connect/disconnect, when to
                                start/stop the engine, rematch, forfeit, chat
  session.ts                    GameSession: one engine instance and its two PlayerIOs over sockets;
                                re-asks invalid answers; emits checkpoints
  storage.ts                    RoomRecord (the saved room) and FileRoomStore (atomic JSON files)
  cards.ts                      engine card data, its version, deck validation
  test/rooms.test.ts            end-to-end: real server, real sockets, disconnect/resume/restart
  test/bot.test.ts              the bot plays full games legally and beats a naive opponent

shared/                         imported by both sides
  protocol.ts                   every client↔server message and the RoomView/room-info shapes
  bot.ts                        the computer opponent (a PlayerIO); used by the browser and tests

scripts/
  dev.mjs                       `npm run dev`: server with rebuild-on-change + Vite with hot reload
  build-server.mjs              esbuild bundle of the server (and of the tests for `npm test`)
  build-carddb.mjs              extracts the small slice of genshin-db the client needs

vite.config.ts                  client build; dev proxy of /api and /ws to the server
Dockerfile, fly.toml            container image and Fly.io config (see Deploying)
```

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
