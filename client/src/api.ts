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

export const roomInfo = (roomId: string) =>
  request<PublicRoomInfo>("GET", `/api/rooms/${encodeURIComponent(roomId)}`).catch((e: Error) => {
    if (/not found/i.test(e.message)) return null;
    throw e;
  });
