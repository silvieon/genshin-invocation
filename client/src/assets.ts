import { AssetsManager } from "@gi-tcg/assets-manager";
import { createResource } from "solid-js";
import { readJson, writeJson } from "./local";

const VERSION_KEY = "gi.engineVersion";

/**
 * The server reports the game version its rules engine implements; card data and
 * art are requested for exactly that version so the deck builder never offers a
 * card the engine can't play.
 */
async function loadEngineVersion(): Promise<string> {
  const cached = readJson<string | null>(VERSION_KEY, null);
  const fresh = fetch("/api/meta")
    .then((r) => r.json())
    .then((m: { version: string }) => {
      writeJson(VERSION_KEY, m.version);
      return m.version;
    });
  if (cached) {
    // Use the cached value for an instant start; a changed version applies on next load.
    fresh.catch(() => {});
    return cached;
  }
  return fresh;
}

const [engineVersion] = createResource(loadEngineVersion);
export { engineVersion };

let manager: AssetsManager | null = null;
let managerVersion: string | null = null;

export function assets(): AssetsManager {
  const version = engineVersion() ?? "latest";
  if (!manager || managerVersion !== version) {
    manager = new AssetsManager({ language: "EN", version });
    managerVersion = version;
  }
  return manager;
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
