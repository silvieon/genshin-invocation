import { createRoot, createSignal, type Accessor } from "solid-js";
import { createClient, type Client } from "@gi-tcg/web-ui-core";
import { Notification, RpcRequest, RpcResponse, base64Decode, base64Encode } from "@gi-tcg/typings";
import { CloseCode, type ClientMessage, type RoomView, type Seat, type ServerMessage } from "../../shared/protocol";
import { assets } from "./assets";
import { createEventFeed } from "./eventFeed";
import type { SeatTicket } from "./local";

export type LinkState = "connecting" | "online" | "reconnecting" | "closed";

export interface ChatLine {
  seat: Seat;
  name: string;
  text: string;
  at: number;
}

export interface ActiveGame {
  /** Engine player index this browser plays as. */
  who: 0 | 1;
  gameNumber: number;
  resumed: boolean;
  /** Changes every time the server starts a fresh engine (new game or resume). */
  key: number;
  Chessboard: Client[1];
}

export interface Connection {
  link: Accessor<LinkState>;
  /** Why the connection was closed for good (set when link() === "closed"). */
  closedReason: Accessor<string | null>;
  room: Accessor<RoomView | null>;
  game: Accessor<ActiveGame | null>;
  chat: Accessor<ChatLine[]>;
  notice: Accessor<{ text: string; at: number } | null>;
  /** Plain-text log of game events. */
  log: Accessor<string[]>;
  send(msg: ClientMessage): void;
  dispose(): void;
}

/**
 * The browser side of a seat: a self-healing WebSocket to the room plus the
 * web-ui-core chessboard it drives. The board's PlayerIO is fed straight from
 * the server's notifications and RPC requests.
 */
export function connect(ticket: SeatTicket): Connection {
  const [link, setLink] = createSignal<LinkState>("connecting");
  const [closedReason, setClosedReason] = createSignal<string | null>(null);
  const [room, setRoom] = createSignal<RoomView | null>(null);
  const [game, setGame] = createSignal<ActiveGame | null>(null);
  const [chat, setChat] = createSignal<ChatLine[]>([]);
  const [notice, setNotice] = createSignal<{ text: string; at: number } | null>(null);

  const feed = createEventFeed(
    () => game()?.who ?? 0,
    () => {
      const r = room();
      return r?.players[1 - r.you]?.name ?? "Opponent";
    },
  );

  let ws: WebSocket | null = null;
  let disposed = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let gameKey = 0;
  let io: Client[0] | null = null;
  let disposeBoard: (() => void) | null = null;

  const send = (msg: ClientMessage) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const cancelRpc = () => {
    try {
      io?.cancelRpc();
    } catch {
      // nothing pending
    }
  };

  const startBoard = (who: 0 | 1, gameNumber: number, resumed: boolean) => {
    cancelRpc();
    disposeBoard?.();
    if (!resumed) feed.clear();
    createRoot((dispose) => {
      disposeBoard = dispose;
      const [clientIo, Chessboard] = createClient(who, {
        assetsManager: () => assets(),
        locale: () => "en",
        onGiveUp: () => send({ t: "giveUp" }),
      });
      io = clientIo;
      setGame({ who, gameNumber, resumed, key: ++gameKey, Chessboard });
    });
  };

  const onMessage = (msg: ServerMessage) => {
    switch (msg.t) {
      case "room":
        setRoom(msg.room);
        return;
      case "gameStart":
        startBoard(msg.who, msg.gameNumber, msg.resumed);
        return;
      case "notify": {
        const n = Notification.decode(base64Decode(msg.data));
        io?.notify(n);
        feed.push(n);
        return;
      }
      case "rpc": {
        const target = io;
        if (!target) return;
        const request = RpcRequest.decode(base64Decode(msg.data));
        Promise.resolve(target.rpc(request)).then(
          (response) => {
            // Ignore answers from a board that has since been replaced.
            if (io !== target) return;
            send({ t: "rpcResponse", id: msg.id, data: base64Encode(RpcResponse.encode(response).finish()) });
          },
          () => {
            // Cancelled (pause, resume or game end); the server will ask again if needed.
          },
        );
        return;
      }
      case "cancelRpc":
        cancelRpc();
        return;
      case "chat":
        setChat((c) => [...c.slice(-199), msg]);
        return;
      case "error":
        setNotice({ text: msg.message, at: Date.now() });
        return;
      case "pong":
        return;
    }
  };

  const open = () => {
    if (disposed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    ws = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ t: "auth", room: ticket.roomId, token: ticket.token } satisfies ClientMessage));
    };
    socket.onmessage = (ev) => {
      if (attempts !== 0 || link() !== "online") {
        attempts = 0;
        setLink("online");
      }
      try {
        onMessage(JSON.parse(ev.data));
      } catch (e) {
        console.error("Bad message from server", e);
      }
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return;
      ws = null;
      // Whatever the board was waiting for is void; the server restarts from the last checkpoint.
      cancelRpc();
      if (disposed) return;
      if (ev.code === CloseCode.Replaced) return close("This seat was opened in another tab or window.");
      if (ev.code === CloseCode.Unauthorized) return close("This room no longer exists, or this browser isn't seated in it.");
      setLink("reconnecting");
      const delay = Math.min(10_000, 500 * 2 ** attempts++) * (0.75 + Math.random() * 0.5);
      retryTimer = setTimeout(open, delay);
    };
  };

  const close = (reason: string) => {
    setClosedReason(reason);
    setLink("closed");
  };

  // Reconnect immediately when the device comes back online or the tab regains focus.
  const kick = () => {
    if (!disposed && !ws && link() === "reconnecting") {
      clearTimeout(retryTimer);
      open();
    }
  };
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", kick);

  open();

  return {
    link,
    closedReason,
    room,
    game,
    chat,
    notice,
    log: feed.lines,
    send,
    dispose() {
      disposed = true;
      clearTimeout(retryTimer);
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", kick);
      cancelRpc();
      ws?.close(1000, "left");
      ws = null;
      disposeBoard?.();
    },
  };
}
