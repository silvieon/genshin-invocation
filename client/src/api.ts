// The client side of the server's HTTP API (rooms only; live play goes over
// the WebSocket in connection.ts). Errors become Error objects whose message
// is safe to show the player.

import type { DeckInput, JoinResult, PublicRoomInfo } from "../../shared/protocol";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const createRoom = (name: string, deck: DeckInput) => request<JoinResult>("POST", "/api/rooms", { name, deck });

export const joinRoom = (roomId: string, name: string, deck: DeckInput) =>
  request<JoinResult>("POST", `/api/rooms/${encodeURIComponent(roomId)}/join`, { name, deck });

/** Public room info, or null if the room doesn't exist (any other failure throws). */
export const roomInfo = (roomId: string) =>
  request<PublicRoomInfo>("GET", `/api/rooms/${encodeURIComponent(roomId)}`).catch((e: Error) => {
    if (/not found/i.test(e.message)) return null;
    throw e;
  });
