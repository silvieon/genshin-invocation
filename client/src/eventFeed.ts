// The battle log: engine notifications turned into readable lines, in the
// spirit of Pokémon Showdown's battle log.
//
// Every notification carries a list of mutations (what changed). An action
// (skill, card, switch, end of round...) starts a new *group*; the damage,
// healing, reactions, summons and statuses it causes are added to that group
// as effect lines. The side panel shows every line; the on-board callouts show
// the latest group (see components/BattleLog.tsx).

import { createSignal, type Accessor } from "solid-js";
import {
  PbDamageType,
  PbEntityArea,
  PbPhaseType,
  PbPlayerFlag,
  PbReactionType,
  PbRemoveEntityReason,
  PbResetDiceReason,
  PbSwitchActiveFromAction,
  type Notification,
} from "@gi-tcg/typings";
import { assets } from "./assets";

export type LogKind =
  /** "Round 3" */
  | "round"
  /** Phase changes and other game-level news. */
  | "phase"
  /** Something a player did (or chose). Starts a new group. */
  | "action"
  /** A consequence of the current group's action. */
  | "effect"
  /** Game over. */
  | "end";

export interface LogEntry {
  id: number;
  /** Lines with the same group belong to one action and its consequences. */
  group: number;
  kind: LogKind;
  /** Whose doing (action) or who was affected (effect); null for neutral lines. */
  side: "me" | "opp" | null;
  text: string;
  /** Element of the damage or aura, lowercase ("pyro", "physical", "heal"...), for colouring. */
  element?: string;
  /** Elemental reaction name, if one happened ("Melt"). */
  reaction?: string;
  defeated?: boolean;
  /**
   * Log-only: setup and bookkeeping (draws, rolls, mulligans, round headers)
   * that isn't worth a callout, and would cover the board's own choice screens.
   */
  quiet?: boolean;
}

export interface EventFeed {
  lines: Accessor<LogEntry[]>;
  push(n: Notification): void;
  clear(): void;
}

const MAX_LINES = 400;

/** "SWIRL_PYRO" → "Swirl (Pyro)", "ELECTRO_CHARGED" → "Electro-Charged". */
function reactionName(r: PbReactionType): string {
  const raw = PbReactionType[r] ?? "";
  const words = raw.toLowerCase().split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  if (words[0] === "Swirl" || words[0] === "Crystallize") return `${words[0]} (${words.slice(1).join(" ")})`;
  if (raw === "ELECTRO_CHARGED") return "Electro-Charged";
  return words.join(" ");
}

const elementName = (t: PbDamageType) =>
  t === PbDamageType.PHYSICAL ? "Physical" : (PbDamageType[t] ?? "").charAt(0) + (PbDamageType[t] ?? "").slice(1).toLowerCase();

const nameOf = (defId: number | undefined): string | undefined => {
  if (!defId) return undefined;
  try {
    return assets().getNameSync(defId) ?? undefined;
  } catch {
    return undefined;
  }
};
const name = (defId: number | undefined) => nameOf(defId) ?? `#${defId ?? "?"}`;

/** Character definition ids are 4 digits (1101...); summons, statuses and cards are longer. */
const isCharacterDef = (defId: number) => defId > 1000 && defId < 10000;

type Mutation = NonNullable<Notification["mutation"][number]["mutation"]>;

/** A player's own move (skill, card, tuning, switch): starts a new log group. */
function startsAction(m: Mutation): boolean {
  switch (m.$case) {
    case "skillUsed":
      return !m.value.triggeredOn || m.value.triggeredOn === "initiative";
    case "removeEntity":
      return [PbRemoveEntityReason.EVENT_CARD_PLAYED, PbRemoveEntityReason.EVENT_CARD_PLAY_NO_EFFECT, PbRemoveEntityReason.ELEMENTAL_TUNING].includes(m.value.reason);
    case "moveEntity":
      return m.value.fromWhere === PbEntityArea.HAND && (m.value.toWhere === PbEntityArea.CHARACTER || m.value.toWhere === PbEntityArea.SUPPORT);
    case "switchActive":
      return m.value.fromAction !== PbSwitchActiveFromAction.NONE && !m.value.viaSkillDefinitionId;
    default:
      return false;
  }
}
const isConsequence = (m: Mutation) =>
  m.$case === "damage" || m.$case === "applyAura" || m.$case === "createEntity" || (m.$case === "removeEntity" && !startsAction(m));

/**
 * The engine sometimes reports an action's consequences before the action
 * itself (a skill's status is created, then "skill used"), and the winner
 * before the final blow. Put the cause first and the result last, so each
 * effect lands under the action that caused it.
 */
function inStoryOrder(n: Notification): Mutation[] {
  const list = n.mutation.map((e) => e.mutation).filter((m): m is Mutation => !!m);
  const action = list.findIndex(startsAction);
  const firstEffect = list.findIndex(isConsequence);
  if (action > 0 && firstEffect >= 0 && firstEffect < action) {
    const [m] = list.splice(action, 1);
    list.splice(firstEffect, 0, m);
  }
  const winner = list.findIndex((m) => m.$case === "setWinner");
  if (winner >= 0) list.push(...list.splice(winner, 1));
  return list;
}

/** `who` is this browser's engine player index; `oppName` labels the other side. */
export function createEventFeed(who: () => 0 | 1, oppName: () => string): EventFeed {
  const [lines, setLines] = createSignal<LogEntry[]>([]);
  let nextId = 1;
  let group = 0;
  let round = 0;
  /** Players who already rerolled this round: their post-reroll dice reset isn't a new roll. */
  const rerolled = new Set<number>();
  /** Engine entity id → owner, for characters (from the latest full state). */
  const owner = new Map<number, number>();
  /** Engine entity id → definition id, for characters. */
  const defOf = new Map<number, number>();

  const side = (w: number) => (w === who() ? ("me" as const) : ("opp" as const));
  /** "You" / "Computer" */
  const player = (w: number) => (w === who() ? "You" : oppName());
  /** "Your" / "Computer's" */
  const whose = (w: number) => (w === who() ? "Your" : `${oppName()}'s`);
  /** "your Xiangling" / "Computer's Xiangling" (owner looked up by entity id). */
  const character = (entityId: number, defId: number) => {
    const w = owner.get(entityId);
    const n = name(defId);
    return w === undefined ? n : `${w === who() ? "your" : `${oppName()}'s`} ${n}`;
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const describe = (n: Notification): Omit<LogEntry, "id">[] => {
    const out: Omit<LogEntry, "id">[] = [];
    const add = (e: Omit<LogEntry, "id" | "group">) => {
      if (e.kind !== "effect") group++;
      // Everything before the first round (draws, mulligans, first picks) is setup.
      out.push({ ...e, group, quiet: e.quiet || round === 0 });
    };

    if (n.state) {
      for (const w of [0, 1]) {
        for (const c of n.state.player[w]?.character ?? []) {
          owner.set(c.id, w);
          defOf.set(c.id, c.definitionId);
        }
      }
      if (n.state.roundNumber !== round && n.state.roundNumber > 0) {
        round = n.state.roundNumber;
        rerolled.clear();
        add({ kind: "round", side: null, text: `Round ${round}`, quiet: true });
      }
    }

    // Cards drawn in this notification, per player (summarised as one line).
    const drawn = [0, 0];

    for (const m of inStoryOrder(n)) {
      switch (m.$case) {
        case "changePhase":
          // Re-sent unchanged after every turn; only real transitions are news.
          if (!m.value.hasChange) break;
          if (m.value.newPhase === PbPhaseType.ACTION) add({ kind: "phase", side: null, text: "Action phase", quiet: true });
          else if (m.value.newPhase === PbPhaseType.END) add({ kind: "phase", side: null, text: "End phase" });
          break;
        case "resetDice":
          if (m.value.reason === PbResetDiceReason.ROLL && !rerolled.has(m.value.who)) {
            add({ kind: "action", side: side(m.value.who), text: `${player(m.value.who)} rolled ${m.value.dice.length} dice`, quiet: true });
          }
          break;
        case "rerollDone": {
          // The engine reports the real count only to the player who rerolled.
          rerolled.add(m.value.who);
          const w = m.value.who;
          const text =
            w !== who() ? `${oppName()} rerolled dice` : m.value.count ? `You rerolled ${m.value.count} ${m.value.count === 1 ? "die" : "dice"}` : "You kept your dice";
          add({ kind: "action", side: side(w), text, quiet: true });
          break;
        }
        case "switchHandsDone":
          add({
            kind: "action",
            side: side(m.value.who),
            text: m.value.count
              ? `${player(m.value.who)} shuffled ${m.value.count} card${m.value.count === 1 ? "" : "s"} back and redrew`
              : `${player(m.value.who)} kept ${m.value.who === who() ? "your" : "their"} hand`,
          });
          break;
        case "chooseActiveDone":
          add({ kind: "action", side: side(m.value.who), text: `${player(m.value.who)} sent out ${name(m.value.characterDefinitionId)}` });
          break;
        case "switchActive": {
          // Choosing a character (start of game, after a defeat) is already logged by chooseActiveDone.
          if (m.value.fromAction === PbSwitchActiveFromAction.NONE) break;
          const w = m.value.who;
          if (m.value.viaSkillDefinitionId) {
            add({ kind: "effect", side: side(w), text: `${whose(w)} active character is now ${name(m.value.characterDefinitionId)}` });
          } else {
            add({ kind: "action", side: side(w), text: `${player(w)} switched to ${name(m.value.characterDefinitionId)}` });
          }
          break;
        }
        case "skillUsed": {
          const v = m.value;
          // Skills the player chose start a group; passives and triggers are detail.
          if (!v.triggeredOn || v.triggeredOn === "initiative") {
            add({ kind: "action", side: side(v.who), text: `${whose(v.who)} ${name(v.callerDefinitionId)} used ${name(v.skillDefinitionId)}` });
          }
          break;
        }
        case "damage": {
          const d = m.value;
          const target = cap(character(d.targetId, d.targetDefinitionId));
          const targetSide = owner.has(d.targetId) ? side(owner.get(d.targetId)!) : null;
          if (d.damageType === PbDamageType.HEAL) {
            const healed = d.newHealth - d.oldHealth;
            if (healed > 0) add({ kind: "effect", side: targetSide, text: `${target} healed ${healed} HP`, element: "heal" });
            break;
          }
          // Damage from a summon or status (not the acting character) names its source.
          const src = d.sourceDefinitionId && !isCharacterDef(d.sourceDefinitionId) ? nameOf(d.sourceDefinitionId) : undefined;
          const reaction = d.reactionType ? reactionName(d.reactionType) : undefined;
          add({
            kind: "effect",
            side: targetSide,
            text: `${target} took ${d.value} ${elementName(d.damageType)} damage${src ? ` from ${src}` : ""}`,
            element: elementName(d.damageType).toLowerCase(),
            reaction,
            defeated: d.causeDefeated,
          });
          if (d.causeDefeated) add({ kind: "effect", side: targetSide, text: `${target} was defeated!`, defeated: true });
          break;
        }
        case "applyAura": {
          // Element applied without damage (damage lines already cover the rest).
          const a = m.value;
          if (!a.reactionType && a.newAura === a.oldAura) break;
          const target = cap(character(a.targetId, a.targetDefinitionId));
          const targetSide = owner.has(a.targetId) ? side(owner.get(a.targetId)!) : null;
          add({
            kind: "effect",
            side: targetSide,
            text: a.reactionType ? `Reaction on ${character(a.targetId, a.targetDefinitionId)}` : `${target} is affected by ${elementName(a.elementType)}`,
            element: elementName(a.elementType).toLowerCase(),
            reaction: a.reactionType ? reactionName(a.reactionType) : undefined,
          });
          break;
        }
        case "createEntity": {
          const v = m.value;
          const n2 = nameOf(v.entity?.definitionId);
          if (!n2) break;
          if (v.where === PbEntityArea.SUMMON) add({ kind: "effect", side: side(v.who), text: `${player(v.who)} summoned ${n2}` });
          else if (v.where === PbEntityArea.COMBAT_STATUS) add({ kind: "effect", side: side(v.who), text: `${whose(v.who)} side gained ${n2}` });
          else if (v.where === PbEntityArea.CHARACTER && v.masterCharacterId && defOf.has(v.masterCharacterId)) {
            const master = cap(character(v.masterCharacterId, defOf.get(v.masterCharacterId)!));
            add({ kind: "effect", side: side(v.who), text: `${master} gained ${n2}` });
          }
          break;
        }
        case "removeEntity": {
          const v = m.value;
          if (v.reason === PbRemoveEntityReason.EVENT_CARD_PLAYED || v.reason === PbRemoveEntityReason.EVENT_CARD_PLAY_NO_EFFECT) {
            const none = v.reason === PbRemoveEntityReason.EVENT_CARD_PLAY_NO_EFFECT ? " (no effect)" : "";
            add({ kind: "action", side: side(v.who), text: `${player(v.who)} played ${name(v.entity?.definitionId)}${none}` });
          } else if (v.reason === PbRemoveEntityReason.ELEMENTAL_TUNING) {
            add({ kind: "action", side: side(v.who), text: `${player(v.who)} tuned a card into a die` });
          } else if (v.where === PbEntityArea.SUMMON) {
            const n2 = nameOf(v.entity?.definitionId);
            if (n2) add({ kind: "effect", side: side(v.who), text: `${whose(v.who)} ${n2} left the field` });
          }
          break;
        }
        case "moveEntity": {
          const v = m.value;
          // Equipment and supports leave the hand when played.
          if (v.fromWhere === PbEntityArea.HAND && (v.toWhere === PbEntityArea.CHARACTER || v.toWhere === PbEntityArea.SUPPORT)) {
            add({ kind: "action", side: side(v.fromWho), text: `${player(v.fromWho)} played ${name(v.entity?.definitionId)}` });
          } else if (v.fromWhere === PbEntityArea.PILE && v.toWhere === PbEntityArea.HAND) {
            drawn[v.toWho]++;
          }
          break;
        }
        case "setPlayerFlag":
          if (m.value.flagName === PbPlayerFlag.DECLARED_END && m.value.flagValue) {
            const w = m.value.who;
            add({ kind: "action", side: side(w), text: w === who() ? "You ended your round" : `${oppName()} ended their round` });
          }
          break;
        case "setWinner":
          add({
            kind: "end",
            side: null,
            text: m.value.winner == null ? "Game over: draw" : m.value.winner === who() ? "Game over: you win!" : `Game over: ${oppName()} wins`,
          });
          break;
      }
    }

    for (const w of [0, 1]) {
      if (drawn[w]) add({ kind: "effect", side: side(w), text: `${player(w)} drew ${drawn[w]} card${drawn[w] === 1 ? "" : "s"}`, quiet: true });
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
        for (const e of add) {
          const last = next.at(-1);
          if (last && last.text === e.text && last.kind === e.kind) continue;
          next.push({ ...e, id: nextId++ });
        }
        return next.slice(-MAX_LINES);
      });
    },
    clear() {
      round = 0;
      group = 0;
      rerolled.clear();
      owner.clear();
      defOf.clear();
      setLines([]);
    },
  };
}
