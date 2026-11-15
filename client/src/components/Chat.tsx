// In-room chat (online rooms only). Messages are relayed by the server and
// never stored, so they're gone after a reload.

import { For, createEffect, createSignal, on } from "solid-js";
import type { ChatLine } from "../connection";
import type { Seat } from "../../../shared/protocol";
import { MAX_CHAT_LENGTH } from "../../../shared/protocol";

export function Chat(props: { lines: ChatLine[]; you: Seat; onSend: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = createSignal("");
  let list!: HTMLDivElement;
  // Keep the newest message in view.
  createEffect(
    on(
      () => props.lines.length,
      () => queueMicrotask(() => list && (list.scrollTop = list.scrollHeight)),
    ),
  );
  const submit = (e: Event) => {
    e.preventDefault();
    const t = text().trim();
    if (!t) return;
    props.onSend(t);
    setText("");
  };
  return (
    <div class="chat">
      <div class="chat-lines" ref={list}>
        <For each={props.lines} fallback={<p class="muted small">Say hi! Messages aren't saved.</p>}>
          {(l) => (
            <p classList={{ mine: l.seat === props.you }}>
              <b>{l.name}</b> {l.text}
            </p>
          )}
        </For>
      </div>
      <form class="row" onSubmit={submit}>
        <input
          class="grow"
          value={text()}
          maxLength={MAX_CHAT_LENGTH}
          placeholder="Message"
          onInput={(e) => setText(e.currentTarget.value)}
          disabled={props.disabled}
          aria-label="Chat message"
        />
        <button class="btn" type="submit" disabled={props.disabled}>
          Send
        </button>
      </form>
    </div>
  );
}
