import test from "node:test";
import assert from "node:assert/strict";
import { FEATURE_NAMES } from "../server/rl-policy.mjs";
import { samplePolicy, train } from "../scripts/train-rl.mjs";

test("零权重下均匀采样，策略梯度等于所选特征减去期望特征", () => {
  const zeros = Array(FEATURE_NAMES.length).fill(0);
  const ones = zeros.map(() => 1);
  const rows = [{ action: "first", features: zeros }, { action: "second", features: ones }];
  const first = samplePolicy(rows, zeros, () => 0.25);
  const second = samplePolicy(rows, zeros, () => 0.75);
  assert.equal(first.action, "first");
  assert.equal(second.action, "second");
  assert.ok(first.gradient.every(value => value === -0.5));
  assert.ok(second.gradient.every(value => value === 0.5));
});

test("相同种子从零开始自博弈，得到相同且非零的策略权重", () => {
  const first = train(2, 881);
  const second = train(2, 881);
  assert.deepEqual(first, second);
  assert.ok(first.weights.every(Number.isFinite));
  assert.ok(first.weights.some(weight => Math.abs(weight) > 1e-8));
  assert.ok(first.training.plies > 0);
});
