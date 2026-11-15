// Bundles the server with esbuild.
//
// @gi-tcg/core ships `using` declarations (explicit resource management),
// which Node 22 cannot parse yet; esbuild lowers them, so bundling lets the
// server run on any Node >= 22.
//
//   node scripts/build-server.mjs           -> dist/server/main.mjs
//   node scripts/build-server.mjs --watch   -> rebuild on change
//   node scripts/build-server.mjs --test    -> bundle server/test/*.test.ts and run them
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  // Bundle everything except packages with native/optional deps that are fine to resolve at runtime.
  external: ["ws", "bufferutil", "utf-8-validate"],
  // Some bundled CJS deps call require(); give ESM output a real one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
  absWorkingDir: root,
};

if (args.has("--test")) {
  const testDir = path.join(root, "server", "test");
  const entries = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(testDir, f));
  const outdir = path.join(root, ".tmp", "test");
  fs.rmSync(outdir, { recursive: true, force: true });
  await esbuild.build({ ...common, entryPoints: entries, outdir, outExtension: { ".js": ".mjs" } });
  const files = fs.readdirSync(outdir).filter((f) => f.endsWith(".mjs")).map((f) => path.join(outdir, f));
  const child = spawn(process.execPath, ["--enable-source-maps", "--test", "--test-concurrency=1", "--test-timeout=90000", "--test-reporter=spec", ...files], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const opts = { ...common, entryPoints: [path.join(root, "server", "main.ts")], outfile: path.join(root, "dist", "server", "main.mjs") };
  if (args.has("--watch")) {
    const ctx = await esbuild.context({
      ...opts,
      plugins: [{ name: "notify", setup: (b) => b.onEnd((r) => console.log(`[server] built${r.errors.length ? " with errors" : ""}`)) }],
    });
    await ctx.watch();
  } else {
    await esbuild.build(opts);
    console.log("[server] built dist/server/main.mjs");
  }
}
