// How the battle log (eventFeed.ts) is shown:
//   - BattleLog: the full scrolling list, Showdown style. Lives in a side column
//     on wide screens and in the "Log" drawer on narrow ones.
//   - Callouts: the latest action and its effects, shown briefly over the middle
//     of the board, so you can see what just happened without looking away.

import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { LogEntry } from "../eventFeed";

/** One log line: side colour, element colour on damage, reaction badge. */
function Line(props: { e: LogEntry }) {
  return (
    <div
      class={`log-line ${props.e.kind}`}
      classList={{ me: props.e.side === "me", opp: props.e.side === "opp", defeated: !!props.e.defeated }}
      data-element={props.e.element}
    >
      <span class="log-text">{props.e.text}</span>
      <Show when={props.e.reaction}>
        <span class="reaction">{props.e.reaction}</span>
      </Show>
    </div>
  );
}

/** The full log, kept scrolled to the newest line unless you've scrolled up to read. */
export function BattleLog(props: { lines: LogEntry[] }) {
  let el!: HTMLDivElement;
  let pinned = true;
  const onScroll = () => {
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  createEffect(
    on(
      () => props.lines.length,
      () => queueMicrotask(() => el && pinned && (el.scrollTop = el.scrollHeight)),
    ),
  );
  return (
    <div class="battle-log" ref={el} onScroll={onScroll}>
      <For each={props.lines} fallback={<p class="muted small">Nothing has happened yet.</p>}>
        {(e) => <Line e={e} />}
      </For>
    </div>
  );
}

/** How long a callout stays up after its last line arrives. */
const CALLOUT_MS = 2600;

/** The newest group of lines, floated over the board for a couple of seconds. */
export function Callouts(props: { lines: LogEntry[] }) {
  const [shown, setShown] = createSignal<LogEntry[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => props.lines.at(-1)?.id,
      (id) => {
        if (id === undefined) return setShown([]);
        const last = props.lines.at(-1)!;
        // The latest group, at most 5 lines (a big turn can cause many effects).
        const group = props.lines.filter((l) => l.group === last.group && !l.quiet).slice(-5);
        if (!group.length) return;
        setShown(group);
        clearTimeout(timer);
        timer = setTimeout(() => setShown([]), CALLOUT_MS);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return (
    <Show when={shown().length > 0}>
      <div class="callouts" aria-live="polite">
        <For each={shown()}>{(e) => <Line e={e} />}</For>
      </div>
    </Show>
  );
}
