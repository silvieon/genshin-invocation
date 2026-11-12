import { For, Show, createSignal } from "solid-js";
import { fetchValue } from "../async";
import { DeckPicker } from "../components/DeckPicker";
import { createRoom, roomInfo } from "../api";
import {
  forgetTicket,
  getCpuGame,
  getImageQuality,
  setImageQuality,
  type ImageQuality,
  getEffects,
  setEffects,
  type EffectsMode,
  getLastDeckId,
  getName,
  isCompleteDeck,
  listDecks,
  listTickets,
  saveTicket,
  setLastDeckId,
  setName,
} from "../local";
import { navigate } from "../App";
import { resetAssets } from "../assets";
import type { PublicRoomInfo } from "../../../shared/protocol";

const STATUS_LABEL: Record<PublicRoomInfo["status"], string> = {
  open: "Waiting for opponent",
  paused: "Saved · resumes when both are here",
  playing: "In progress",
  finished: "Finished",
};

export function Home() {
  const [name, setNameSig] = createSignal(getName());
  const [deckId, setDeckId] = createSignal<string | null>(getLastDeckId());
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [tickets, setTickets] = createSignal(listTickets());
  const cpu = getCpuGame();
  const cpuInProgress = !!cpu && !cpu.result;

  const selectedDeck = () => listDecks().find((d) => d.id === deckId())?.deck;

  const chooseDeck = (id: string) => {
    setDeckId(id);
    setLastDeckId(id);
  };

  const create = async () => {
    setError(null);
    const deck = selectedDeck();
    if (!isCompleteDeck(deck)) return setError("Pick a complete deck first.");
    setBusy(true);
    try {
      setName(name());
      const r = await createRoom(name(), deck!);
      saveTicket({ ...r, joinedAt: Date.now() });
      navigate(`#/room/${r.roomId}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const join = (e: Event) => {
    e.preventDefault();
    const id = code()
      .trim()
      .replace(/^.*#\/room\//, "")
      .toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(id)) return setError("Room codes look like ABC123.");
    setName(name());
    navigate(`#/room/${id}`);
  };

  return (
    <div class="home">
      <header class="hero">
        <h1>Genius Invokation</h1>
        <p class="muted">Play the TCG with a friend or against the computer, from any device. Games save automatically.</p>
      </header>

      <main class="home-grid">
        <section class="panel">
          <h2>You</h2>
          <label class="field">
            <span>Display name</span>
            <input
              value={name()}
              maxLength={24}
              placeholder="Traveler"
              onInput={(e) => setNameSig(e.currentTarget.value)}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </label>
          <h3>Deck</h3>
          <DeckPicker selected={deckId()} onSelect={chooseDeck} />
          <label class="field inline">
            <span>Card art</span>
            <select
              value={getImageQuality()}
              onChange={(e) => {
                setImageQuality(e.currentTarget.value as ImageQuality);
                resetAssets();
                location.reload();
              }}
            >
              <option value="high">High resolution (~70 KB/card, cached)</option>
              <option value="saver">Data saver (thumbnails)</option>
            </select>
          </label>
          <label class="field">
            <span>Board effects</span>
            <select
              value={getEffects()}
              onChange={(e) => {
                setEffects(e.currentTarget.value as EffectsMode);
                location.reload();
              }}
            >
              <option value="fast">Fast animations (recommended)</option>
              <option value="off">Off: instant, events as text only</option>
              <option value="full">Full-length animations</option>
            </select>
          </label>
        </section>

        <section class="panel">
          <h2>Play</h2>
          <button class="btn primary big" disabled={busy()} onClick={create}>
            {busy() ? "Creating…" : "Create a room"}
          </button>
          <p class="muted small">You'll get a link to send to your opponent.</p>
          <form class="row" onSubmit={join}>
            <input
              class="grow"
              placeholder="Room code or invite link"
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
              aria-label="Room code"
            />
            <button class="btn" type="submit">
              Join
            </button>
          </form>
          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>

          <h3>Solo</h3>
          <button class="btn big" onClick={() => navigate("#/cpu")}>
            {cpuInProgress ? `Continue vs Computer${cpu!.round ? ` (round ${cpu!.round})` : ""}` : "Play vs Computer"}
          </button>
          <p class="muted small">Runs on your device — no opponent or connection needed once loaded.</p>

          <Show when={tickets().length > 0}>
            <h3>Your rooms</h3>
            <ul class="room-list">
              <For each={tickets()}>
                {(t) => {
                  const info = fetchValue(() => roomInfo(t.roomId).catch(() => undefined));
                  return (
                    <li>
                      <a href={`#/room/${t.roomId}`} class="room-link">
                        <span class="code">{t.roomId}</span>
                        <span class="vs">
                          <Show when={info()} fallback={<span class="muted">{info() === null ? "Expired" : "…"}</span>}>
                            {(i) => (
                              <>
                                {i().host ?? "?"} vs {i().guest ?? "—"}
                              </>
                            )}
                          </Show>
                        </span>
                        <Show when={info()}>{(i) => <span class="status">{STATUS_LABEL[i().status]}</span>}</Show>
                      </a>
                      <button
                        class="link-btn"
                        aria-label={`Forget room ${t.roomId}`}
                        onClick={() => {
                          forgetTicket(t.roomId);
                          setTickets(listTickets());
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </section>
      </main>
      <footer class="footer muted small">
        Rules engine and card data by the open-source{" "}
        <a href="https://github.com/piovium/genius-invokation" target="_blank" rel="noreferrer">
          gi-tcg
        </a>{" "}
        project; glossary from{" "}
        <a href="https://github.com/theBowja/genshin-db" target="_blank" rel="noreferrer">
          genshin-db
        </a>
        . Card art © HoYoverse. Fan project, not affiliated with HoYoverse.
      </footer>
    </div>
  );
}
