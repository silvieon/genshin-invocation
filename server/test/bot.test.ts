import { test } from "node:test";
import assert from "node:assert/strict";
import { Game, type PlayerIO } from "@gi-tcg/core";
import { ActionValidity, type RpcRequest, type RpcResponse } from "@gi-tcg/typings";
import { createBot } from "../../shared/bot.ts";
import { gameData, sampleDeck } from "../cards.ts";

/** The simplest possible opponent: attack if possible, else end the round. */
function naive(): PlayerIO {
  return {
    notify() {},
    async rpc(req: RpcRequest): Promise<RpcResponse> {
      const r = req.request!;
      switch (r.$case) {
        case "switchHands":
          return { response: { $case: "switchHands", value: { removedHandIds: [] } } };
        case "rerollDice":
          return { response: { $case: "rerollDice", value: { diceToReroll: [] } } };
        case "chooseActive":
          return { response: { $case: "chooseActive", value: { activeCharacterId: r.value.candidateIds[0] } } };
        case "selectCard":
          return { response: { $case: "selectCard", value: { selectedDefinitionId: r.value.candidateDefinitionIds[0] } } };
        case "action": {
          const a = r.value.action;
          let i = a.findIndex((x) => x.action?.$case === "useSkill" && x.validity === ActionValidity.VALID);
          if (i < 0) i = a.findIndex((x) => x.action?.$case === "declareEnd");
          return { response: { $case: "action", value: { chosenActionIndex: i, usedDice: a[i].autoSelectedDice } } };
        }
      }
      throw new Error("unreachable");
    },
  };
}

test("computer opponent plays full games and beats a naive player", async () => {
  const games = 8;
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const botSide = (g % 2) as 0 | 1;
    // Mirror decks so only play quality differs.
    const deck = sampleDeck(g % 4);
    const state = Game.createInitialState({ data: gameData(), decks: [deck, deck], randomSeed: 1000 + g });
    const game = new Game(state, { errorLevel: "toleratePreview" });
    const bot = createBot(botSide, { randomness: 0.3 });
    game.players[botSide].io = bot;
    game.players[1 - botSide].io = naive();
    const t0 = performance.now();
    const winner = await game.start();
    const ms = performance.now() - t0;
    if (winner === botSide) wins++;
    console.log(`game ${g}: bot=${botSide} winner=${winner} rounds=${game.state.roundNumber} ${ms.toFixed(0)}ms`);
  }
  assert.ok(wins >= games * 0.75, `bot won only ${wins}/${games}`);
});
