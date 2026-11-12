import test from "node:test";
import assert from "node:assert/strict";
import { createGame, legalActionsFor, makePiece } from "../server/game-engine.mjs";
import { actionKey, publicStateForAI } from "../server/ai-engine.mjs";
import { chooseVersionedAIAction } from "../server/ai-versions.mjs";

test("V3 从公开棋池推演并正确去重跨时间片的统计", () => {
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0, ruleIds: ["snake", "football-poison"] });
  const state = publicStateForAI(game);
  const snapshot = structuredClone(state);
  const options = { aiVersion: "v3", maxIterations: 5, timeLimitMs: 3_000, seed: 45 };
  const first = chooseVersionedAIAction(state, state.turn, options);
  assert.equal(first.method, "rl-rollout");
  assert.equal(first.iterations, 5);
  assert.ok(legalActionsFor(state, state.turn).all.some((action) => actionKey(action) === actionKey(first.action)));
  const next = chooseVersionedAIAction(state, state.turn, { ...options, seed: 46, initialCandidates: first.candidates });
  assert.equal(next.candidateDeltas.reduce((n, entry) => n + entry.visits, 0), 5);
  assert.equal(next.candidates.reduce((n, entry) => n + entry.visits, 0), 10);
  assert.deepEqual(state, snapshot);
});

test("V3 对蛇的击退与吃子区分，短时和正式搜索都会找到最后一血的胜着", () => {
  const board = Array(32).fill(null);
  for (const [i, type, color] of [[4, "snake", "blue"], [5, "wolf", "red"], [8, "tiger", "red"], [12, "mouse", "blue"]]) {
    board[i] = { ...makePiece(type, color), revealed: true };
  }
  const game = createGame({ playerIds: ["a", "b"], board, rng: () => 0, ruleIds: ["snake"] });
  game.health.red = 1;
  for (const timeLimitMs of [5, 400]) {
    const result = chooseVersionedAIAction(publicStateForAI(game), "blue", { aiVersion: "v3", timeLimitMs, seed: 17 });
    assert.equal(result.aiVersion, "v3");
    assert.deepEqual([result.action.from, result.action.to, result.action.capture], [4, 8, true]);
  }
});
