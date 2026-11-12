import test from "node:test";
import assert from "node:assert/strict";
import { createGame, legalActionsFor, positionSignature } from "../server/game-engine.mjs";
import { actionKey, publicStateForAI } from "../server/ai-engine.mjs";
import { FEATURE_NAMES, chooseRLAction, loadRLModel, rlCandidates } from "../server/rl-policy.mjs";

function position(pieces, ruleIds = []) {
  const board = Array(32).fill(null);
  for (const [square, type, color, data] of pieces) board[square] = { type, color, revealed: true, ...data };
  const game = createGame({ board, playerIds: ["a", "b"], ruleIds, rng: () => 0 });
  return publicStateForAI(game);
}

function feature(row, name) {
  return row.features[FEATURE_NAMES.indexOf(name)];
}

test("V3 候选和估分只依赖明子、吃子清单和未翻棋池", () => {
  const state = position([[4, "cat", "blue"], [8, "dog", "red", { revealed: false }]]);
  const sampled = structuredClone(state);
  sampled.board[8] = { type: "elephant", color: "blue", revealed: false };
  assert.deepEqual(rlCandidates(sampled), rlCandidates(state));
  const snapshot = structuredClone(state);
  state.capturedBy.red.push({ color: "blue", type: "dog" });
  const getFlip = (s) => rlCandidates(s).find(row => row.action.type === "flip");
  assert.ok(feature(getFlip(state), "flipFriendlyProbability") < feature(getFlip(snapshot), "flipFriendlyProbability"));
});

test("V3 掩码排除四次重复并区分蛇击退、边界吃子和毒素效果", () => {
  const state = position([
    [0, "dog", "red"], [4, "snake", "blue", { poisoned: true, poisonTurns: 1 }], [8, "football", "red"],
  ], ["snake", "football-poison"]);
  const boardAfterExpiredQuietMove = state.board.slice();
  boardAfterExpiredQuietMove[4] = null;
  state.positionCounts[positionSignature(boardAfterExpiredQuietMove, "red")] = 3;
  const before = structuredClone(state);
  const rows = rlCandidates(state);
  assert.deepEqual(rows.map(({ action }) => actionKey(action)), legalActionsFor(state, "blue").all.map(actionKey));
  assert.ok(!rows.some(({ action }) => action.to === 5));
  const push = rows.find(({ action }) => action.to === 8);
  assert.equal(feature(push, "push"), 1);
  assert.equal(feature(push, "capture"), 0);
  assert.equal(feature(push, "ownPoisonDeaths"), 0.5);
  const capture = rows.find(({ action }) => action.to === 0);
  assert.equal(feature(capture, "poisonCured"), 1);
  assert.deepEqual(state, before);
});

test("V3 加载随附训练权重，同一公开棋盘的走法随策略权重变化", () => {
  const model = loadRLModel();
  assert.equal(model.weights.length, FEATURE_NAMES.length);
  assert.ok(model.weights.some(w => w !== 0));
  const state = position([[1, "dog", "blue"], [2, "mouse", "red"], [9, "cat", "red", { revealed: false }]]);
  const weights = FEATURE_NAMES.map(name => name === "capture" ? 8 : 0);
  assert.equal(chooseRLAction(state, "blue", { weights, seed: 3 }).action.capture, true);
  const flipBias = FEATURE_NAMES.map(name => name === "flip" ? 8 : 0);
  assert.equal(chooseRLAction(state, "blue", { weights: flipBias, seed: 3 }).action.type, "flip");
  state.health.red = 1;
  assert.equal(chooseRLAction(state, "blue", { weights: flipBias, seed: 3 }).action.capture, true);
  assert.equal(chooseRLAction(state, "red").action, null);
});
