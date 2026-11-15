// Process entry point (`npm start` runs the bundled copy, dist/server/main.mjs).
// Reads PORT / HOST, starts the server, and on SIGINT/SIGTERM stops every engine
// and flushes every room to disk before exiting, so a deploy or restart loses nothing.
//
// Other environment variables are read in index.ts: DATA_DIR, STATIC_DIR, ROOM_TTL_DAYS.

import { createServer, DATA_DIR, log } from "./index.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const { server, close } = await createServer();
server.listen(PORT, HOST, () => log(`Genius Invokation server on http://localhost:${PORT} (saves in ${DATA_DIR})`));

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  log(`${signal}: saving games and shutting down`);
  await close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
