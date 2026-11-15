// Development: rebuilds + restarts the server on change, and runs Vite with HMR.
// Open http://localhost:5173 (Vite proxies /api and /ws to the game server).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const run = (name, args) => {
  const child = spawn(node, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (line) => (line ? `[${name}] ${line}\n` : "");
  child.stdout.on("data", (d) => process.stdout.write(String(d).split(/\r?\n/).map(prefix).join("")));
  child.stderr.on("data", (d) => process.stderr.write(String(d).split(/\r?\n/).map(prefix).join("")));
  return child;
};

await new Promise((resolve, reject) =>
  run("setup", ["scripts/build-carddb.mjs"]).on("exit", (c) => (c === 0 ? resolve() : reject(new Error("carddb failed")))),
);

const bundle = path.join(root, "dist", "server", "main.mjs");
fs.rmSync(bundle, { force: true });
const children = [run("build", ["scripts/build-server.mjs", "--watch"])];
// Start the server once the first bundle exists; --watch restarts it on every rebuild.
while (!fs.existsSync(bundle)) await new Promise((r) => setTimeout(r, 200));
children.push(run("server", ["--enable-source-maps", "--watch", bundle]));
children.push(run("vite", [path.join(root, "node_modules", "vite", "bin", "vite.js")]));

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
