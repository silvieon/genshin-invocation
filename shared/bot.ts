// A lightweight computer opponent.
//
// It needs no search and no server: every action the engine offers already
// carries a `preview` of its immediate outcome (damage dealt, characters
// defeated, healing...), so the bot scores each legal action from that preview
// plus a few rules of thumb and plays the best one. A decision costs well under
// a millisecond, so it runs comfortably in the player's own browser.

import {
  ActionValidity,
  PbDamageType,
  PbDiceRequirementType,
  PbDiceType,
  type Notification,
  type PbDiceRequirement,
  type PbPlayerState,
  type PreviewData,
  type RpcRequest,
  type RpcResponse,
} from "@gi-tcg/typings";

export interface BotOptions {
  /** Pause before each decision so a human can follow the bot's moves. */
  thinkMs?: number;
  /** 0 = always the best-scored move; higher values add variety. */
  randomness?: number;
  random?: () => number;
}

export interface BotIo {
  notify(notification: Notification): void;
  rpc(request: RpcRequest): Promise<RpcResponse>;
  /** Drop any pending timers (the engine was stopped). */
  dispose(): void;
}

type Action = Extract<NonNullable<RpcRequest["request"]>, { $case: "action" }>["value"]["action"][number];

/** Element of a character, from the definition-id convention (1101 Cryo, 1201 Hydro, ... 1701 Dendro). */
export const elementOf = (characterDefinitionId: number): PbDiceType => {
  const e = Math.floor(characterDefinitionId / 100) % 10;
  return e >= 1 && e <= 7 ? (e as PbDiceType) : PbDiceType.UNSPECIFIED;
};

const diceCost = (cost: PbDiceRequirement[]) =>
  cost.reduce(
    (n, c) => (c.type === PbDiceRequirementType.ENERGY || c.type === PbDiceRequirementType.LEGEND ? n : n + c.count),
    0,
  );
const needsEnergy = (cost: PbDiceRequirement[]) => cost.some((c) => c.type === PbDiceRequirementType.ENERGY && c.count > 0);

export function createBot(who: 0 | 1, opts: BotOptions = {}): BotIo {
  const random = opts.random ?? Math.random;
  const randomness = opts.randomness ?? 0.6;
  let me: PbPlayerState | undefined;
  let opp: PbPlayerState | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const mineIds = () => new Set(me?.character.map((c) => c.id));
  const theirIds = () => new Set(opp?.character.map((c) => c.id));
  const active = () => me?.character.find((c) => c.id === me?.activeCharacterId);

  function scorePreview(preview: PreviewData[]) {
    const mine = mineIds();
    const theirs = theirIds();
    let s = 0;
    for (const p of preview) {
      const m = p.mutation;
      if (m?.$case !== "damage") continue;
      const d = m.value;
      const heal = d.damageType === PbDamageType.HEAL;
      const amount = Math.abs(d.newHealth - d.oldHealth) || (heal ? 0 : d.value);
      if (theirs.has(d.targetId)) s += heal ? -amount : amount * 1.5 + (d.causeDefeated ? 20 : 0);
      else if (mine.has(d.targetId)) s += heal ? amount * 1.2 : -amount - (d.causeDefeated ? 25 : 0);
    }
    return s;
  }

  function scoreAction(a: Action, all: Action[]): number {
    const act = a.action;
    if (!act || a.validity !== ActionValidity.VALID) return -Infinity;
    const dice = me?.dice.length ?? 0;
    const cost = diceCost(a.requiredCost);
    const canAttack = all.some((x) => x.action?.$case === "useSkill" && x.validity === ActionValidity.VALID);
    const cheapestSkill = Math.min(
      ...all.filter((x) => x.action?.$case === "useSkill").map((x) => diceCost(x.requiredCost)),
      Infinity,
    );
    const preview = scorePreview(a.preview);
    switch (act.$case) {
      case "useSkill":
        // Bursts are usually the strongest thing on the board.
        return 8 + (needsEnergy(a.requiredCost) ? 6 : 0) + preview;
      case "playCard": {
        if (act.value.willBeEffectless) return -Infinity;
        let s = (a.isFast ? 4 : 2) - cost * 0.6 + preview;
        // Don't spend the dice needed to attack this turn on a card.
        if (canAttack && dice - cost < cheapestSkill) s -= 6;
        return s;
      }
      case "switchActive": {
        const from = active();
        const to = me?.character.find((c) => c.id === act.value.characterId);
        if (!from || !to) return -1;
        // Retreat a nearly defeated character in favour of a healthy one, or switch if we can't act.
        if (from.health <= 3 && to.health >= from.health + 3) return 6 + preview;
        if (!canAttack && to.energy === to.maxEnergy && to.maxEnergy > 0) return 3 + preview;
        return -3 + preview;
      }
      case "elementalTuning": {
        // Turn a spare card into a useful die only when we can't attack otherwise.
        const el = from(active());
        if (canAttack || (me?.handCard.length ?? 0) < 4 || act.value.targetDice !== el) return -Infinity;
        return 0.5;
      }
      case "declareEnd":
        return 0;
    }
  }
  const from = (c: { definitionId: number } | undefined) => (c ? elementOf(c.definitionId) : PbDiceType.UNSPECIFIED);

  function decide(request: RpcRequest): RpcResponse["response"] {
    const r = request.request!;
    switch (r.$case) {
      case "switchHands": {
        // Mulligan expensive cards for a shot at cheaper ones.
        const removedHandIds = (me?.handCard ?? []).filter((c) => diceCost(c.definitionCost) >= 4).map((c) => c.id);
        return { $case: "switchHands", value: { removedHandIds } };
      }
      case "rerollDice": {
        // Keep Omni dice and dice matching our living characters (the active one counts double: kept unconditionally).
        const keep = new Set<PbDiceType>([PbDiceType.OMNI, from(active())]);
        for (const c of me?.character ?? []) if (!c.defeated) keep.add(elementOf(c.definitionId));
        const diceToReroll = (me?.dice ?? []).filter((d) => !keep.has(d));
        return { $case: "rerollDice", value: { diceToReroll } };
      }
      case "chooseActive": {
        // Healthiest candidate, ties broken by energy.
        const byId = new Map(me?.character.map((c) => [c.id, c]));
        const value = (id: number) => {
          const c = byId.get(id);
          return c ? c.health * 10 + c.energy : 0;
        };
        const best = [...r.value.candidateIds].sort((a, b) => value(b) - value(a))[0];
        return { $case: "chooseActive", value: { activeCharacterId: best } };
      }
      case "selectCard":
        return { $case: "selectCard", value: { selectedDefinitionId: r.value.candidateDefinitionIds[0] } };
      case "action": {
        const actions = r.value.action;
        let bestIdx = -1;
        let best = -Infinity;
        actions.forEach((a, i) => {
          const s = scoreAction(a, actions) + random() * randomness;
          if (s > best) {
            best = s;
            bestIdx = i;
          }
        });
        if (bestIdx < 0) bestIdx = actions.findIndex((a) => a.action?.$case === "declareEnd");
        if (bestIdx < 0) bestIdx = actions.findIndex((a) => a.validity === ActionValidity.VALID);
        const chosen = actions[bestIdx];
        return { $case: "action", value: { chosenActionIndex: bestIdx, usedDice: chosen.autoSelectedDice } };
      }
      default:
        throw new Error(`Bot can't answer ${(r as { $case?: string }).$case}`);
    }
  }

  return {
    notify(n) {
      if (!n.state) return;
      me = n.state.player[who];
      opp = n.state.player[1 - who];
    },
    rpc(request) {
      const response = { response: decide(request) };
      const ms = opts.thinkMs ?? 0;
      if (ms <= 0) return Promise.resolve(response);
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t);
          resolve(response);
        }, ms);
        timers.add(t);
      });
    },
    dispose() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
