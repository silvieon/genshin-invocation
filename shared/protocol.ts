// Wire protocol shared by server and client.
//
// Game traffic (notifications, RPC requests/responses) is carried as base64
// encoded protobuf messages from @gi-tcg/typings, wrapped in a small JSON
// envelope. Everything else is plain JSON.

export interface DeckInput {
  characters: number[];
  cards: number[];
}

export type Seat = 0 | 1;

export type RoomStatus =
  /** Waiting for the second player to join the room. */
  | "open"
  /** Both seats are taken, but at least one player is offline; the game is saved on disk. */
  | "paused"
  /** Both players are connected and the game engine is running. */
  | "playing"
  /** The game ended; the result is stored and players may ask for a rematch. */
  | "finished";

export interface PlayerView {
  name: string;
  connected: boolean;
  wantsRematch: boolean;
}

export interface RoomView {
  id: string;
  status: RoomStatus;
  /** The seat of the player receiving this view. */
  you: Seat;
  players: [PlayerView | null, PlayerView | null];
  /** Engine-side player index (0 moves first) for each seat in the current game. */
  whoOfSeat: [0 | 1, 0 | 1];
  gameNumber: number;
  /** Round number of the last saved checkpoint, if a game is in progress. */
  round: number | null;
  result: GameResult | null;
  /** Set when the engine failed; the game can be resumed from the last checkpoint. */
  error: string | null;
}

export interface GameResult {
  /** Winning seat, or null for a draw. */
  winnerSeat: Seat | null;
  reason: "victory" | "surrender" | "draw" | "error";
  at: number;
}

export interface PublicRoomInfo {
  id: string;
  status: RoomStatus;
  host: string | null;
  guest: string | null;
}

export interface JoinResult {
  roomId: string;
  seat: Seat;
  token: string;
}

export type ClientMessage =
  /** Must be the first message on a socket. */
  | { t: "auth"; room: string; token: string }
  | { t: "rpcResponse"; id: number; data: string }
  | { t: "giveUp" }
  | { t: "rematch" }
  | { t: "retry" }
  | { t: "chat"; text: string }
  | { t: "ping" };

export type ServerMessage =
  | { t: "room"; room: RoomView }
  /** Engine notification (protobuf `Notification`, base64). */
  | { t: "notify"; data: string }
  /** Engine RPC request (protobuf `Request`, base64); answer with `rpcResponse`. */
  | { t: "rpc"; id: number; data: string }
  /** Any outstanding RPC is void (the game was paused or restarted). */
  | { t: "cancelRpc" }
  /** A fresh engine instance started (new game or resume from checkpoint). */
  | { t: "gameStart"; who: 0 | 1; resumed: boolean; gameNumber: number }
  | { t: "chat"; seat: Seat; name: string; text: string; at: number }
  | { t: "error"; message: string }
  | { t: "pong" };

/** WebSocket close codes used by the server. */
export const CloseCode = {
  /** Another connection took over this seat (e.g. a second tab). */
  Replaced: 4001,
  /** Room missing or token invalid. */
  Unauthorized: 4003,
  /** Room expired and was deleted. */
  Gone: 4004,
} as const;

export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_NAME_LENGTH = 24;
export const MAX_CHAT_LENGTH = 300;
