// Card names, images and deck share-codes. These come from the gi-tcg static
// data service (static-data.piovium.org) straight to the browser; our server
// only says which card-pool version to ask for. Also loads the rules glossary
// built from genshin-db (scripts/build-carddb.mjs).

import { AssetsManager } from "@gi-tcg/assets-manager";
import { createSignal } from "solid-js";
import { getImageQuality, readJson, writeJson } from "./local";

const VERSION_KEY = "gi.engineVersion";

/**
 * The server reports the game version its rules engine implements; card data and
 * art are requested for exactly that version so the deck builder never offers a
 * card the engine can't play.
 */
const [engineVersion, setEngineVersion] = createSignal<string | null>(readJson<string | null>(VERSION_KEY, null));
/** Engine card-pool version: the cached value immediately (no blank wait), refreshed from the server. */
export { engineVersion };
const fetchedVersion: Promise<string> = fetch("/api/meta")
  .then((r) => r.json())
  .then((m: { version: string }) => {
    writeJson(VERSION_KEY, m.version);
    // A changed version applies on the next page load, so nothing re-renders mid-session.
    if (!engineVersion()) setEngineVersion(m.version);
    return m.version;
  });
fetchedVersion.catch(() => {});

/**
 * The card-pool version, waiting for the server only on a first visit. Anything
 * that picks cards (random decks) must use this rather than assets() directly,
 * or it could pick from a newer pool than the engine implements.
 */
export async function readyAssets(): Promise<AssetsManager> {
  if (!engineVersion()) await fetchedVersion;
  return assets();
}

let manager: AssetsManager | null = null;
let managerVersion: string | null = null;

/** The shared assets manager for the current card-pool version (created on first use). */
export function assets(): AssetsManager {
  const version = engineVersion() ?? "latest";
  if (!manager || managerVersion !== version) {
    manager = withImageQuality(new AssetsManager({ language: "EN", version }));
    managerVersion = version;
  }
  return manager;
}

/**
 * The board and deck builder always ask for thumbnails (80×137 card faces), which
 * look blurry at the size the board draws them. In high quality, serve the full
 * art (420×720) instead. It's ~70 KB a card, downloaded once per device and then
 * cached by the service worker.
 */
function withImageQuality(m: AssetsManager): AssetsManager {
  type ImageFn = (id: number, opts?: { type?: "cardFace" | "icon" | "unspecified"; thumbnail?: boolean }) => any;
  for (const key of ["getImage", "getImageUrl", "getImageUrlSync"] as const) {
    const original = (m[key] as ImageFn).bind(m);
    (m as unknown as Record<string, ImageFn>)[key] = (id, opts = {}) =>
      original(id, getImageQuality() === "high" ? { ...opts, thumbnail: false } : opts);
  }
  return m;
}

/** Drop cached image URLs so a quality change applies to the next board or deck view. */
export function resetAssets() {
  manager = null;
}

export interface Glossary {
  keywords: { id: number; name: string; description: string }[];
  rules: { id: number; name: string; rules: { title: string; content: string }[] }[];
}

let glossary: Promise<Glossary> | null = null;
/** Keyword and reaction-rule glossary extracted from genshin-db at build time. */
export function loadGlossary(): Promise<Glossary> {
  return (glossary ??= fetch("/carddb/glossary.json").then((r) => {
    if (!r.ok) throw new Error("Glossary unavailable");
    return r.json();
  }));
}
