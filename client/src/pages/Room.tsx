import { For, Match, Show, Switch, createEffect, createSignal, onCleanup } from "solid-js";
import { fetchValue } from "../async";
import { Dynamic } from "solid-js/web";
import { joinRoom, roomInfo } from "../api";
import { connect, type Connection } from "../connection";
import { DeckPicker } from "../components/DeckPicker";
import { Glossary } from "../components/Glossary";
import { Chat } from "../components/Chat";
import {
  getLastDeckId,
  getName,
  getRotation,
  getTicket,
  isCompleteDeck,
  listDecks,
  saveTicket,
  setLastDeckId,
  setName,
  setRotation,
  type RotationSetting,
  type SeatTicket,
} from "../local";
import { navigate } from "../App";
import type { RoomView, Seat } from "../../../shared/protocol";

export function RoomPage(props: { roomId: string }) {
  const [ticket, setTicket] = createSignal<SeatTicket | undefined>(getTicket(props.roomId));
  return (
    <Show when={ticket()} keyed fallback={<JoinRoom roomId={props.roomId} onJoined={setTicket} />}>
      {(t) => <OnlineTable ticket={t} />}
    </Show>
  );
}

// ------------------------------------------------------------------- join

function JoinRoom(props: { roomId: string; onJoined: (t: SeatTicket) => void }) {
  const info = fetchValue(() => roomInfo(props.roomId));
  const [name, setNameSig] = createSignal(getName());
  const [deckId, setDeckId] = createSignal<string | null>(getLastDeckId());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const join = async () => {
    setError(null);
    const deck = listDecks().find((d) => d.id === deckId())?.deck;
    if (!isCompleteDeck(deck)) return setError("Pick a complete deck first.");
    setBusy(true);
    try {
      setName(name());
      const r = await joinRoom(props.roomId, name(), deck!);
      const t = { ...r, joinedAt: Date.now() };
      saveTicket(t);
      props.onJoined(t);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="home">
      <header class="hero">
        <a href="#/" class="back-link">
          ← Home
        </a>
        <h1>Room {props.roomId}</h1>
      </header>
      <main class="home-grid single">
        <section class="panel">
          <Switch>
            <Match when={info.loading()}>
              <p class="muted">Looking up the room…</p>
            </Match>
            <Match when={info.error()}>
              <p class="error">{info.error()!.message}</p>
            </Match>
            <Match when={info() === null}>
              <p>This room doesn't exist or has expired.</p>
              <button class="btn" onClick={() => navigate("#/")}>
                Back home
              </button>
            </Match>
            <Match when={info()?.guest}>
              <p>
                This room is full ({info()!.host} vs {info()!.guest}).
              </p>
              <p class="muted small">If you were seated here, open it from the browser you joined with.</p>
            </Match>
            <Match when={info()}>
              <h2>{info()!.host} invited you to a duel</h2>
              <label class="field">
                <span>Display name</span>
                <input value={name()} maxLength={24} placeholder="Traveler" onInput={(e) => setNameSig(e.currentTarget.value)} />
              </label>
              <h3>Deck</h3>
              <DeckPicker
                selected={deckId()}
                onSelect={(id) => {
                  setDeckId(id);
                  setLastDeckId(id);
                }}
              />
              <button class="btn primary big" disabled={busy()} onClick={join}>
                {busy() ? "Joining…" : "Take a seat"}
              </button>
              <Show when={error()}>
                <p class="error">{error()}</p>
              </Show>
            </Match>
          </Switch>
        </section>
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ table

type Drawer = "chat" | "rules" | "log" | null;

function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [vp, setVp] = createSignal(read());
  const on = () => setVp(read());
  window.addEventListener("resize", on);
  window.addEventListener("orientationchange", on);
  onCleanup(() => {
    window.removeEventListener("resize", on);
    window.removeEventListener("orientationchange", on);
  });
  return vp;
}

function OnlineTable(props: { ticket: SeatTicket }) {
  const conn = connect(props.ticket);
  onCleanup(() => conn.dispose());
  return <Table conn={conn} roomId={props.ticket.roomId} seat={props.ticket.seat} />;
}

/** The game table. Online rooms and games against the computer share it; only the connection differs. */
export function Table(props: { conn: Connection; roomId: string; seat: Seat; vsComputer?: boolean }) {
  const conn = props.conn;

  const [drawer, setDrawer] = createSignal<Drawer>(null);
  const [unread, setUnread] = createSignal(0);
  const [rotationSetting, setRotationSetting] = createSignal<RotationSetting>(getRotation());
  const [copied, setCopied] = createSignal(false);
  const [toast, setToast] = createSignal<string | null>(null);
  const vp = useViewport();

  const room = () => conn.room();
  const me = () => room()?.players[props.seat] ?? null;
  const opp = () => room()?.players[1 - props.seat] ?? null;
  const rotation = () => {
    const r = rotationSetting();
    if (r !== "auto") return r;
    // Portrait phones: turn the landscape board sideways so it uses the whole screen.
    return vp().h > vp().w * 1.15 && vp().w < 900 ? 90 : 0;
  };

  createEffect(() => {
    const n = conn.chat().length;
    if (n && drawer() !== "chat") setUnread((u) => u + 1);
  });
  createEffect(() => {
    const n = conn.notice();
    if (!n) return;
    setToast(n.text);
    const t = setTimeout(() => setToast((cur) => (cur === n.text ? null : cur)), 4000);
    onCleanup(() => clearTimeout(t));
  });

  const inviteUrl = () => `${location.origin}${location.pathname}#/room/${props.roomId}`;
  const share = async () => {
    const url = inviteUrl();
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      navigator.share({ title: "Genius Invokation duel", url }).catch(() => {});
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt("Invite link:", url);
    }
  };

  const cycleRotation = () => {
    const order: RotationSetting[] = ["auto", 0, 90, 270];
    const next = order[(order.indexOf(rotationSetting()) + 1) % order.length];
    setRotationSetting(next);
    setRotation(next);
  };

  const giveUp = () => {
    if (confirm(`Forfeit this game? ${props.vsComputer ? "The computer" : "Your opponent"} will be awarded the win.`)) conn.send({ t: "giveUp" });
  };

  const resultText = (r: RoomView) => {
    const res = r.result!;
    if (res.winnerSeat === null) return "Draw";
    const won = res.winnerSeat === r.you;
    const how = res.reason === "surrender" ? (won ? " — opponent forfeited" : " — you forfeited") : "";
    return (won ? "Victory" : "Defeat") + how;
  };

  const RematchButton = () => (
    <Show when={room()?.result}>
      <button class="btn primary" disabled={me()?.wantsRematch || !opp()?.connected} onClick={() => conn.send({ t: "rematch" })}>
        {me()?.wantsRematch ? "Waiting for opponent…" : opp()?.wantsRematch ? "Accept rematch" : "Rematch"}
      </button>
      <Show when={!opp()?.connected}>
        <p class="muted small">Your opponent left the room.</p>
      </Show>
    </Show>
  );

  const toggleDrawer = (d: Exclude<Drawer, null>) => {
    setDrawer((cur) => (cur === d ? null : d));
    if (d === "chat") setUnread(0);
  };

  return (
    <div class="table" classList={{ "drawer-open": !!drawer() }}>
      <header class="topbar">
        <button class="btn ghost" onClick={() => navigate("#/")} aria-label="Leave room" title="Leave (the game is saved)">
          ←
        </button>
        <Show when={!props.vsComputer} fallback={<span class="room-code">vs Computer</span>}>
          <button class="room-code" onClick={share} title="Copy invite link">
            {props.roomId}
            <span class="small">{copied() ? " copied!" : " · invite"}</span>
          </button>
        </Show>
        <div class="players">
          <span class="player" classList={{ online: !!me()?.connected }}>
            <i class="dot" />
            {me()?.name ?? "You"}
          </span>
          <span class="muted">vs</span>
          <span class="player" classList={{ online: !!opp()?.connected }}>
            <i class="dot" />
            {opp()?.name ?? "…"}
          </span>
        </div>
        <Show when={(room()?.round ?? 0) >= 1 && room()?.status !== "finished"}>
          <span class="muted small hide-sm">Round {room()!.round}</span>
        </Show>
        <button class="feed-line" onClick={() => toggleDrawer("log")} title="Game log">
          {conn.log().at(-1)?.trim() ?? ""}
        </button>
        <button class="btn ghost" onClick={cycleRotation} title="Rotate board">
          ⟳ <span class="small">{rotationSetting() === "auto" ? "auto" : `${rotationSetting()}°`}</span>
        </button>
        <button class="btn ghost" onClick={() => toggleDrawer("rules")} classList={{ active: drawer() === "rules" }}>
          Rules
        </button>
        <Show when={!props.vsComputer}>
          <button class="btn ghost" onClick={() => toggleDrawer("chat")} classList={{ active: drawer() === "chat" }}>
            Chat
            <Show when={unread() > 0}>
              <span class="badge">{unread()}</span>
            </Show>
          </button>
        </Show>
      </header>

      <Show when={conn.link() === "reconnecting" || conn.link() === "connecting"}>
        <div class="banner">{conn.link() === "connecting" ? "Connecting…" : "Connection lost — reconnecting…"}</div>
      </Show>
      <Show when={toast()}>
        <div class="toast">{toast()}</div>
      </Show>

      <main class="board-area">
        <Show when={conn.game()} keyed>
          {(g) => (
            <Dynamic
              component={g.Chessboard}
              class="board"
              autoHeight={false}
              rotation={rotation()}
              myPlayerInfo={{ name: me()?.name }}
              oppPlayerInfo={{ name: opp()?.name }}
              gameEndExtra={
                <div class="game-end-extra">
                  <RematchButton />
                </div>
              }
            />
          )}
        </Show>

        <Show when={overlayFor(conn, room())}>
          {(kind) => (
            <div class="overlay">
              <div class="panel overlay-card">
                <Switch>
                  <Match when={kind() === "closed"}>
                    <h2>Disconnected</h2>
                    <p>{conn.closedReason()}</p>
                    <button class="btn" onClick={() => navigate("#/")}>
                      Back home
                    </button>
                  </Match>
                  <Match when={kind() === "loading"}>
                    <p class="muted">{props.vsComputer ? "Setting up the table…" : "Joining the table…"}</p>
                  </Match>
                  <Match when={kind() === "open"}>
                    <h2>Waiting for an opponent</h2>
                    <p>Send this link to the person you want to play:</p>
                    <div class="invite">
                      <code>{inviteUrl()}</code>
                      <button class="btn primary" onClick={share}>
                        {copied() ? "Copied!" : "Copy link"}
                      </button>
                    </div>
                    <p class="muted small">You can close this tab — the room stays open for two weeks.</p>
                  </Match>
                  <Match when={kind() === "paused"}>
                    <h2>Waiting for {opp()?.name ?? "your opponent"}</h2>
                    <Show
                      when={room()?.round != null}
                      fallback={<p>The game starts as soon as both players are at the table.</p>}
                    >
                      <p>
                        The game is saved{room()!.round ? ` (round ${room()!.round})` : ""} and picks up right where it
                        left off when {opp()?.name ?? "they"} reconnect{opp()?.name ? "s" : ""}.
                      </p>
                    </Show>
                    <div class="row wrap center">
                      <button class="btn ghost" onClick={share}>
                        {copied() ? "Copied!" : "Copy invite link"}
                      </button>
                      <Show when={room()?.round != null}>
                        <button class="btn ghost danger" onClick={giveUp}>
                          Forfeit
                        </button>
                      </Show>
                    </div>
                  </Match>
                  <Match when={kind() === "error"}>
                    <h2>The game hit a problem</h2>
                    <p class="muted small">{room()!.error}</p>
                    <p>It was saved just before. You can resume from that point.</p>
                    <div class="row wrap center">
                      <button class="btn primary" onClick={() => conn.send({ t: "retry" })}>
                        Resume
                      </button>
                      <button class="btn ghost danger" onClick={giveUp}>
                        Forfeit
                      </button>
                    </div>
                  </Match>
                  <Match when={kind() === "finished"}>
                    <h2>{resultText(room()!)}</h2>
                    <RematchButton />
                  </Match>
                </Switch>
              </div>
            </div>
          )}
        </Show>
      </main>

      <aside class="drawer" classList={{ open: !!drawer() }} aria-hidden={!drawer()}>
        <div class="drawer-head">
          <b>{drawer() === "chat" ? "Chat" : drawer() === "log" ? "Game log" : "Rules & keywords"}</b>
          <button class="btn ghost" onClick={() => setDrawer(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div class="drawer-body">
          <Show when={drawer() === "chat"}>
            <Chat
              lines={conn.chat()}
              you={props.seat}
              onSend={(text) => conn.send({ t: "chat", text })}
              disabled={conn.link() !== "online"}
            />
          </Show>
          <Show when={drawer() === "rules"}>
            <Glossary />
          </Show>
          <Show when={drawer() === "log"}>
            <ul class="log">
              <For each={conn.log()} fallback={<li class="muted">Nothing yet.</li>}>
                {(line) => <li classList={{ round: line.startsWith("—") }}>{line}</li>}
              </For>
            </ul>
          </Show>
        </div>
      </aside>
    </div>
  );
}

/** Which blocking overlay (if any) to show over the board. */
function overlayFor(conn: Connection, room: RoomView | null) {
  if (conn.link() === "closed") return "closed" as const;
  if (!room) return "loading" as const;
  if (room.status === "open") return "open" as const;
  if (room.error && room.status !== "playing") return "error" as const;
  if (room.status === "paused") return "paused" as const;
  // With a board on screen, the board shows its own game-over screen (with our rematch button).
  if (room.status === "finished" && !conn.game()) return "finished" as const;
  return null;
}
