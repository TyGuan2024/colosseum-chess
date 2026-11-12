import test from "node:test";
import assert from "node:assert/strict";
import { AISearchScheduler, defaultAIWorkerCount } from "../server/ai-scheduler.mjs";
import { applySimulatedAction, publicStateForAI } from "../server/ai-engine.mjs";
import { createGame, makePiece } from "../server/game-engine.mjs";

test("AI 搜索线程总数固定为可用逻辑线程的一半", () => {
  assert.equal(defaultAIWorkerCount(8), 4);
  assert.equal(defaultAIWorkerCount(12), 6);
  assert.equal(defaultAIWorkerCount(3), 1);
  assert.equal(defaultAIWorkerCount(1), 1);
});

test("多个 AI 房间共享固定线程池并获得近似均匀的搜索时间片", async (t) => {
  const scheduler = new AISearchScheduler({ workerCount: 4, quantumMs: 40 });
  t.after(() => scheduler.close());
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0.4 });
  const publicState = publicStateForAI(game);
  const first = scheduler.submit({ id: "room-a", publicState, color: game.turn, timeLimitMs: 700, seed: 101 });
  const second = scheduler.submit({ id: "room-b", publicState, color: game.turn, timeLimitMs: 700, seed: 202 });

  const balanceDeadline = Date.now() + 600;
  let during = scheduler.snapshot();
  while (
    during.jobs.length === 2 &&
    Math.abs(during.jobs[0].inFlight - during.jobs[1].inFlight) > 1 &&
    Date.now() < balanceDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    during = scheduler.snapshot();
  }
  assert.equal(during.workerCount, 4);
  assert.ok(during.busyWorkers <= 4);
  assert.equal(during.jobs.length, 2);
  assert.ok(Math.abs(during.jobs[0].inFlight - during.jobs[1].inFlight) <= 1);

  const [resultA, resultB] = await Promise.all([first, second]);
  assert.match(resultA.method, /parallel-so-ismcts/);
  assert.match(resultB.method, /parallel-so-ismcts/);
  assert.ok(resultA.action);
  assert.ok(resultB.action);
  assert.ok(resultA.threads <= 4 && resultB.threads <= 4);
  assert.ok(resultA.quanta > 0 && resultB.quanta > 0);
  assert.ok(
    Math.max(resultA.quanta, resultB.quanta) <= Math.min(resultA.quanta, resultB.quanta) * 2 + 2,
    `neither room may starve: ${resultA.quanta} vs ${resultB.quanta}`,
  );
});

test("预判任务可按真人实际走法收割，并注入 AI 正式搜索", async (t) => {
  const scheduler = new AISearchScheduler({ workerCount: 2, quantumMs: 40 });
  t.after(() => scheduler.close());
  const board = Array(32).fill(null);
  board[0] = { ...makePiece("cat", "blue", "ponder-blue"), revealed: true };
  board[5] = { ...makePiece("dog", "red", "ponder-red"), revealed: true };
  board[31] = { revealed: false };
  const publicState = {
    status: "playing",
    turn: "blue",
    health: { blue: 3, red: 3 },
    initialHealth: 3,
    board,
    capturedBy: { blue: [], red: [] },
  };
  scheduler.submit({
    id: "ponder-room",
    publicState,
    color: "red",
    mode: "ponder",
    wallTimeMs: 900,
    seed: 303,
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const future = structuredClone(publicState);
  assert.equal(applySimulatedAction(future, { type: "move", from: 0, to: 1 }), true);
  const cache = scheduler.harvest("ponder-room", future);
  assert.ok(cache);
  assert.ok(cache.action);
  assert.ok(cache.ponderIterations > 0);

  const official = await scheduler.submit({
    id: "official-room",
    publicState: future,
    color: "red",
    timeLimitMs: 160,
    seed: 404,
    initialResult: cache,
  });
  assert.ok(official.action);
  assert.ok(official.elapsedMs <= 300);
  assert.ok(official.ponderIterations > 0);
});

test("V2 调度会把固定线程池分成经典增强与概率机会节点通道后聚合", async (t) => {
  const scheduler = new AISearchScheduler({ workerCount: 4, quantumMs: 55 });
  t.after(() => scheduler.close());
  const game = createGame({ playerIds: ["a", "b"], rng: () => 0.31 });
  const result = await scheduler.submit({
    id: "v2-hybrid",
    publicState: publicStateForAI(game),
    color: game.turn,
    aiVersion: "v2",
    timeLimitMs: 240,
    seed: 2026,
  });
  assert.equal(result.aiVersion, "v2");
  assert.equal(result.method, "parallel-belief-mcts-v2");
  assert.ok(result.action);
  assert.ok(result.threads <= 4);
  assert.ok(result.quanta >= 2);
});

test("V3 能把完全明棋时的真人走法预判用于同一线程池中的正式搜索", async (t) => {
  const scheduler = new AISearchScheduler({ workerCount: 2, quantumMs: 35 });
  t.after(() => scheduler.close());
  const board = Array(32).fill(null);
  board[0] = { ...makePiece("dog", "blue"), revealed: true };
  board[31] = { ...makePiece("tiger", "red"), revealed: true };
  const game = createGame({ playerIds: ["a", "b"], board, initialHealth: 3, rng: () => 0 });
  const state = publicStateForAI(game);
  const future = structuredClone(state);
  applySimulatedAction(future, { type: "move", from: 0, to: 1 });
  const ponder = scheduler.submit({
    id: "ponder-rl", aiVersion: "v3", mode: "ponder", publicState: state,
    color: "red", seed: 9, wallTimeMs: 3_000,
  });
  const deadline = Date.now() + 2_500;
  while ((scheduler.snapshot().jobs[0]?.cachedStates ?? 0) < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const cache = scheduler.harvest("ponder-rl", future);
  await ponder;
  assert.equal(cache?.method, "rl-rollout");
  assert.ok(cache.ponderIterations > 0);
  const result = await scheduler.submit({
    id: "turn-rl", aiVersion: "v3", publicState: future, color: "red", seed: 10,
    initialResult: cache, timeLimitMs: 200,
  });
  assert.equal(result.aiVersion, "v3");
  assert.equal(result.method, "parallel-rl-rollout");
  assert.ok(result.iterations > 0 && result.threads <= 2);
  assert.equal(result.ponderIterations, cache.ponderIterations);
  assert.equal(result.action.from, 31);
});
