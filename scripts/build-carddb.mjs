// Extracts the small slice of genshin-db TCG data this app uses into
// client/public/carddb/*.json, so neither the server nor the browser ever has to
// load genshin-db's ~60MB dataset at runtime.
//
// What genshin-db fills in (the gi-tcg static-data API is the primary source):
//   - fallback card-face art filenames, used by the service worker when the
//     primary image API is unreachable
//   - the keyword glossary and detailed reaction rules (in-game "Rules" panel)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "client", "public", "carddb");
const pkgDir = path.dirname(require.resolve("@genshin-db/tcg/package.json"));
const srcFile = path.join(pkgDir, "src", "min", "data.min.json");
const pkgVersion = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;

const stampFile = path.join(outDir, ".stamp");
if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === pkgVersion && !process.argv.includes("--force")) {
  console.log(`[carddb] up to date (@genshin-db/tcg ${pkgVersion})`);
  process.exit(0);
}

console.log(`[carddb] extracting from @genshin-db/tcg ${pkgVersion} ...`);
const all = JSON.parse(fs.readFileSync(srcFile, "utf8"));
const en = all.data.English;
if (!en?.tcgcharactercards) {
  console.error("[carddb] @genshin-db/tcg does not contain TCG data (5.2.16 was mispublished; pin 5.2.15).");
  process.exit(1);
}

// Some genshin-db filenames carry a doubled "UI_UI_" prefix; mirrors use the single form.
const normalize = (f) => (typeof f === "string" ? f.replace(/^UI_UI_/, "UI_") : undefined);

const images = {};
for (const folder of ["tcgcharactercards", "tcgactioncards", "tcgsummons"]) {
  const imgs = all.image?.[folder] ?? {};
  for (const [key, item] of Object.entries(en[folder] ?? {})) {
    const face = normalize(imgs[key]?.filename_cardface);
    if (face && item.id) images[item.id] = face;
  }
}

const stripMarkup = (s) =>
  String(s ?? "")
    .replace(/\{SPRITE_PRESET#\d+\}/g, "")
    .replace(/<\/?color[^>]*>/g, "")
    .replace(/\\n/g, "\n")
    .trim();

const keywords = Object.values(en.tcgkeywords ?? {})
  .map((k) => ({ id: k.id, name: stripMarkup(k.name), description: stripMarkup(k.description) }))
  .filter((k) => k.name && k.description)
  .sort((a, b) => a.name.localeCompare(b.name));

const rules = Object.values(en.tcgdetailedrules ?? {}).map((r) => ({
  id: r.id,
  name: r.name,
  rules: (r.rules ?? []).map((x) => ({ title: stripMarkup(x.title), content: stripMarkup(x.content) })),
}));

fs.mkdirSync(outDir, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(value));
write("images.json", images);
write("glossary.json", { keywords, rules });
fs.writeFileSync(stampFile, pkgVersion);
console.log(
  `[carddb] wrote ${Object.keys(images).length} art fallbacks, ${keywords.length} keywords, ${rules.length} rule sets`,
);
