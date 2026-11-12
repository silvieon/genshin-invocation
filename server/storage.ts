import fs from "node:fs/promises";
import path from "node:path";
import type { DeckInput, GameResult, Seat } from "../shared/protocol.ts";

export interface SeatRecord {
  name: string;
  /** sha256 of the seat token; the token itself is only known to the player. */
  tokenHash: string;
  deck: DeckInput;
}

export interface RoomRecord {
  v: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  seats: [SeatRecord | null, SeatRecord | null];
  gameNumber: number;
  /** The seat that plays as engine player 0 (who moves first) in the current game. */
  firstSeat: Seat;
  seed: number;
  /** Last resumable engine checkpoint (output of serializeGameStateLog), or null before the first one. */
  checkpoint: unknown | null;
  round: number | null;
  result: GameResult | null;
  rematch: [boolean, boolean];
  error: string | null;
}

export interface RoomStore {
  get(id: string): Promise<RoomRecord | null>;
  put(record: RoomRecord): Promise<void>;
  delete(id: string): Promise<void>;
  /** Deletes rooms not updated within `maxAgeMs`. Returns the number removed. */
  sweep(maxAgeMs: number, keep?: (id: string) => boolean): Promise<number>;
}

const ID_RE = /^[A-Z0-9]{4,12}$/;

/**
 * One JSON file per room. Writes go to a temp file and are renamed over the
 * target, so a crash mid-write never leaves a torn save. Writes for the same
 * room are serialized and coalesced: saves requested while one is in flight
 * collapse into a single write of the newest snapshot.
 */
export class FileRoomStore implements RoomStore {
  /** Snapshot waiting to be written (taken when its write starts). */
  private readonly pending = new Map<string, string>();
  /** Tail of the write chain per room. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    // Leftover temp files from a crash are never valid saves.
    for (const f of await fs.readdir(this.dir)) {
      if (f.endsWith(".tmp")) await fs.rm(path.join(this.dir, f), { force: true });
    }
  }

  private file(id: string) {
    if (!ID_RE.test(id)) throw new Error(`invalid room id ${JSON.stringify(id)}`);
    return path.join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<RoomRecord | null> {
    if (!ID_RE.test(id)) return null;
    // Never read behind a queued write.
    await this.chains.get(id)?.catch(() => {});
    try {
      const rec = JSON.parse(await fs.readFile(this.file(id), "utf8")) as RoomRecord;
      return rec.v === 1 ? rec : null;
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  put(record: RoomRecord): Promise<void> {
    const id = record.id;
    const alreadyQueued = this.pending.has(id);
    this.pending.set(id, JSON.stringify(record));
    // A write that hasn't started yet will pick up this newer snapshot.
    if (alreadyQueued) return this.chains.get(id)!;
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => {
        const snapshot = this.pending.get(id)!;
        this.pending.delete(id);
        return this.writeAtomic(id, snapshot);
      });
    this.chains.set(id, next);
    next
      .finally(() => {
        if (this.chains.get(id) === next) this.chains.delete(id);
      })
      .catch(() => {});
    return next;
  }

  private async writeAtomic(id: string, content: string) {
    const target = this.file(id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, content, "utf8");
    // On Windows a rename can transiently fail with EPERM/EBUSY if something (AV, indexer) has the file open.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, target);
        return;
      } catch (e: any) {
        if (attempt < 5 && ["EPERM", "EBUSY", "EACCES"].includes(e?.code)) {
          await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
          continue;
        }
        await fs.rm(tmp, { force: true });
        throw e;
      }
    }
  }

  async delete(id: string) {
    await this.chains.get(id)?.catch(() => {});
    await fs.rm(this.file(id), { force: true });
  }

  async sweep(maxAgeMs: number, keep: (id: string) => boolean = () => false) {
    const now = Date.now();
    let removed = 0;
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (keep(id)) continue;
      try {
        const st = await fs.stat(path.join(this.dir, f));
        if (now - st.mtimeMs > maxAgeMs) {
          await this.delete(id);
          removed++;
        }
      } catch {
        // Ignore files that vanished concurrently.
      }
    }
    return removed;
  }
}

/** In-memory store for tests. */
export class MemoryRoomStore implements RoomStore {
  readonly map = new Map<string, string>();
  async get(id: string) {
    const v = this.map.get(id);
    return v ? (JSON.parse(v) as RoomRecord) : null;
  }
  async put(r: RoomRecord) {
    this.map.set(r.id, JSON.stringify(r));
  }
  async delete(id: string) {
    this.map.delete(id);
  }
  async sweep(maxAgeMs: number, keep: (id: string) => boolean = () => false) {
    let n = 0;
    for (const [id, v] of this.map) {
      if (!keep(id) && Date.now() - (JSON.parse(v) as RoomRecord).updatedAt > maxAgeMs) {
        this.map.delete(id);
        n++;
      }
    }
    return n;
  }
}
