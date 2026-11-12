// Plain-text game log built from engine notifications. With board effects off,
// this is how shuffles, rolls, skills and damage are reported instead of
// animations.

import { createSignal, type Accessor } from "solid-js";
import {
  PbDamageType,
  PbEntityArea,
  PbPhaseType,
  PbReactionType,
  PbRemoveEntityReason,
  PbResetDiceReason,
  PbSwitchActiveFromAction,
  type Notification,
} from "@gi-tcg/typings";
import { assets } from "./assets";

export interface EventFeed {
  lines: Accessor<string[]>;
  push(n: Notification): void;
  clear(): void;
}

const MAX_LINES = 200;

const title = (s: string | undefined) =>
  (s ?? "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const name = (defId: number | undefined) => {
  if (!defId) return "?";
  try {
    return assets().getNameSync(defId) ?? `#${defId}`;
  } catch {
    return `#${defId}`;
  }
};

/** `who` is this browser's engine player index; `oppName` labels the other side. */
export function createEventFeed(who: () => 0 | 1, oppName: () => string): EventFeed {
  const [lines, setLines] = createSignal<string[]>([]);
  const player = (w: number) => (w === who() ? "You" : oppName());
  let round = 0;
  /** Players who already rerolled this round: their post-reroll dice reset isn't a new roll. */
  const rerolled = new Set<number>();

  const describe = (n: Notification): string[] => {
    const out: string[] = [];
    if (n.state && n.state.roundNumber !== round && n.state.roundNumber > 0) {
      round = n.state.roundNumber;
      rerolled.clear();
      out.push(`— Round ${round} —`);
    }
    for (const em of n.mutation) {
      const m = em.mutation;
      if (!m) continue;
      switch (m.$case) {
        case "changePhase":
          // Re-sent unchanged after every turn; only real transitions are news.
          if (!m.value.hasChange) break;
          if (m.value.newPhase === PbPhaseType.ACTION) out.push("Action phase");
          else if (m.value.newPhase === PbPhaseType.END) out.push("End phase");
          break;
        case "resetDice":
          if (m.value.reason === PbResetDiceReason.ROLL && !rerolled.has(m.value.who)) out.push(`${player(m.value.who)} rolled ${m.value.dice.length} dice`);
          break;
        case "rerollDone":
          rerolled.add(m.value.who);
          out.push(`${player(m.value.who)} rerolled dice`);
          break;
        case "switchHandsDone":
          out.push(
            m.value.count
              ? `${player(m.value.who)} shuffled ${m.value.count} card${m.value.count === 1 ? "" : "s"} back and redrew`
              : `${player(m.value.who)} kept ${m.value.who === who() ? "your" : "their"} hand`,
          );
          break;
        case "chooseActiveDone":
          out.push(`${player(m.value.who)} chose ${name(m.value.characterDefinitionId)}`);
          break;
        case "switchActive":
          // Choosing a character (start of game, after a defeat) is already logged by chooseActiveDone.
          if (m.value.fromAction === PbSwitchActiveFromAction.NONE) break;
          out.push(`${player(m.value.who)} switched to ${name(m.value.characterDefinitionId)}`);
          break;
        case "skillUsed":
          // Skills the player chose (not passives triggered by game events).
          if (!m.value.triggeredOn || m.value.triggeredOn === "initiative") {
            out.push(`${player(m.value.who)}: ${name(m.value.callerDefinitionId)} used ${name(m.value.skillDefinitionId)}`);
          }
          break;
        case "damage": {
          const d = m.value;
          if (d.damageType === PbDamageType.HEAL) {
            const healed = d.newHealth - d.oldHealth;
            if (healed > 0) out.push(`  ${name(d.targetDefinitionId)} healed ${healed}`);
            break;
          }
          const type = d.damageType === PbDamageType.PHYSICAL ? "Physical" : title(PbDamageType[d.damageType]);
          const reaction = d.reactionType ? ` (${title(PbReactionType[d.reactionType])})` : "";
          const defeated = d.causeDefeated ? " — defeated!" : "";
          out.push(`  ${d.value} ${type} dmg to ${name(d.targetDefinitionId)}${reaction}${defeated}`);
          break;
        }
        case "removeEntity":
          if (m.value.reason === PbRemoveEntityReason.EVENT_CARD_PLAYED) {
            out.push(`${player(m.value.who)} played ${name(m.value.entity?.definitionId)}`);
          } else if (m.value.reason === PbRemoveEntityReason.ELEMENTAL_TUNING) {
            out.push(`${player(m.value.who)} tuned a card into a die`);
          }
          break;
        case "moveEntity":
          // Equipment and supports leave the hand when played.
          if (m.value.fromWhere === PbEntityArea.HAND && (m.value.toWhere === PbEntityArea.CHARACTER || m.value.toWhere === PbEntityArea.SUPPORT)) {
            out.push(`${player(m.value.fromWho)} played ${name(m.value.entity?.definitionId)}`);
          }
          break;
        case "setWinner":
          out.push(m.value.winner == null ? "Game over: draw" : `Game over: ${player(m.value.winner) === "You" ? "you win" : `${oppName()} wins`}`);
          break;
      }
    }
    return out;
  };

  return {
    lines,
    push(n) {
      const add = describe(n);
      if (!add.length) return;
      setLines((l) => {
        const next = [...l];
        // The same event can arrive in consecutive notifications; show it once.
        for (const line of add) if (next.at(-1) !== line) next.push(line);
        return next.slice(-MAX_LINES);
      });
    },
    clear() {
      round = 0;
      setLines([]);
    },
  };
}
