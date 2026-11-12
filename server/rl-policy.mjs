import { readFileSync } from "node:fs";
import { BOARD_SIZE, COLS, ROWS, canAnimalCapture, legalActionsFor, otherColor } from "./game-engine.mjs";
import { actionKey, applySimulatedAction, createSeededRng, remainingInventory } from "./ai-engine.mjs";
import { specialAttackOutcome } from "./rule-system.mjs";

// Order is the checkpoint ABI. All features describe a single legal action from
// the acting side's perspective. No absolute square number or color is encoded.
export const FEATURE_NAMES = Object.freeze([
  "flip", "capture", "push", "center", "quietApproach", "moverEscapesThreat",
  "exposedAfterMove", "captureTargetsAfterMove", "captureValue", "winningCapture",
  "poisonContracted", "poisonCured", "ownPoisonDeaths", "flipFriendlyInDanger",
  "flipEnemyInDanger", "flipEnemyThreat", "flipFriendlyThreat", "flipFriendlyProbability",
  "flipWhenBehind", "captureLowHealth", "flipHiddenFraction",
]);
const VALUE = { football: 1, elephant: 0.9, tiger: 0.83, snake: 0.73, wolf: 0.7, mouse: 0.67, dog: 0.58, cat: 0.5 };
const FEATURE = Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, index]));
const MODEL_FILE = new URL("./models/rl-v3.json", import.meta.url);
let cachedModel;

export function loadRLModel() {
  if (cachedModel) return cachedModel;
  const model = JSON.parse(readFileSync(MODEL_FILE, "utf8"));
  if (model.schemaVersion !== 1 || JSON.stringify(model.featureNames) !== JSON.stringify(FEATURE_NAMES)
      || !Array.isArray(model.weights) || model.weights.length !== FEATURE_NAMES.length
      || !model.weights.every(Number.isFinite)) {
    throw new Error("V3 强化学习模型的特征版本或权重无效");
  }
  cachedModel = Object.freeze({ ...model, weights: Object.freeze(model.weights) });
  return cachedModel;
}

export function policyScore(features, weights) {
  let result = 0;
  for (let i = 0; i < features.length; i++) result += features[i] * weights[i];
  return result;
}

const rays = Array.from({ length: BOARD_SIZE }, (_, square) => {
  const row = Math.floor(square / COLS);
  const col = square % COLS;
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dr, dc]) => {
    const ray = [];
    for (let r = row + dr, c = col + dc; r >= 0 && r < ROWS && c >= 0 && c < COLS; r += dr, c += dc) {
      ray.push(r * COLS + c);
    }
    return ray;
  });
});

// Only a neighbor or the second occupied square on a ray can exchange captures
// with the focus. A hidden piece counts as a screen without revealing its type.
function contacts(board, square) {
  const result = [];
  for (const ray of rays[square]) {
    let occupied = 0;
    for (let i = 0; i < ray.length; i++) {
      const index = ray[i];
      const piece = board[index];
      if (!piece) continue;
      if (piece.revealed && (i === 0 || occupied === 1)) {
        result.push({ index, piece, cannon: occupied === 1 });
      }
      if (++occupied === 2) break;
    }
  }
  return result;
}

// Geometry has already been checked by contacts(). This estimate describes
// tactical potential, while legalActionsFor() supplies the repetition-aware mask.
function canTake(board, from, to, attacker, defender, cannon, rules) {
  if (cannon || attacker.type === "football") return cannon && attacker.type === "football";
  if (attacker.type === "snake") {
    const special = specialAttackOutcome({ board, from, to, attacker, defender }, rules);
    if (special) return special.kind === "capture";
  }
  return canAnimalCapture(attacker.type, defender.type, rules);
}

function tactics(board, index, piece, nearby, rules) {
  let threatened = false;
  let targets = 0;
  for (const contact of nearby) {
    if (contact.piece.color === piece.color) continue;
    if (canTake(board, contact.index, index, contact.piece, piece, contact.cannon, rules)) threatened = true;
    if (canTake(board, index, contact.index, piece, contact.piece, contact.cannon, rules)) targets++;
  }
  return { threatened, targets };
}

function distance(a, b) {
  return Math.abs(Math.floor(a / COLS) - Math.floor(b / COLS)) + Math.abs(a % COLS - b % COLS);
}

function nearestEnemyDistance(board, from, color) {
  let nearest = COLS + ROWS;
  for (let i = 0; i < board.length; i++) {
    if (board[i]?.revealed && board[i].color !== color) nearest = Math.min(nearest, distance(i, from));
  }
  return nearest;
}

function fillFlip(features, state, color, index, pool, hiddenCount) {
  features[FEATURE.flip] = 1;
  features[FEATURE.flipWhenBehind] = (state.health[otherColor(color)] - state.health[color]) / state.initialHealth;
  features[FEATURE.flipHiddenFraction] = hiddenCount / BOARD_SIZE;
  const nearby = contacts(state.board, index);
  for (const { piece, chance } of pool) {
    const friendly = piece.color === color;
    if (friendly) features[FEATURE.flipFriendlyProbability] += chance;
    const { threatened, targets } = tactics(state.board, index, piece, nearby, state.ruleIds);
    if (threatened) features[friendly ? FEATURE.flipFriendlyInDanger : FEATURE.flipEnemyInDanger] += chance;
    if (targets) features[friendly ? FEATURE.flipFriendlyThreat : FEATURE.flipEnemyThreat] += chance;
  }
}

function fillMove(features, state, color, action, before) {
  const attacker = state.board[action.from];
  const target = state.board[action.to];
  // The shared simulator resolves infection, recovery, expiration, and both
  // snake attack outcomes. Only those rule effects can mutate a piece object.
  const board = state.board.slice();
  if (state.ruleIds?.includes("football-poison")) {
    for (let i = 0; i < board.length; i++) {
      if (i === action.from || (board[i]?.revealed && board[i].poisoned)) board[i] = { ...board[i] };
    }
  }
  const next = { ...state, board, turn: color, health: { ...state.health },
    capturedBy: { blue: [], red: [] }, positionCounts: {} };
  applySimulatedAction(next, action);
  const index = action.push ? action.from : action.to;
  const survivor = next.board[index];
  const after = survivor ? tactics(next.board, index, survivor, contacts(next.board, index), state.ruleIds) : null;
  features[FEATURE.capture] = Number(action.capture);
  features[FEATURE.push] = Number(Boolean(action.push));
  features[FEATURE.moverEscapesThreat] = Number(Boolean(before.threatened && after && !after.threatened));
  features[FEATURE.exposedAfterMove] = Number(Boolean(after?.threatened));
  features[FEATURE.captureTargetsAfterMove] = Math.min(1, (after?.targets ?? 0) / 2);
  features[FEATURE.ownPoisonDeaths] = Math.min(1, (state.health[color] - next.health[color]) / 2);
  if (action.capture) {
    features[FEATURE.captureValue] = VALUE[target.type] ?? 0.5;
    features[FEATURE.winningCapture] = Number(next.winner === color);
    features[FEATURE.captureLowHealth] = 1 / state.health[otherColor(color)];
    features[FEATURE.poisonContracted] = Number(Boolean(survivor?.poisoned));
    features[FEATURE.poisonCured] = Number(Boolean(attacker.poisoned && survivor && !survivor.poisoned));
  } else if (!action.push) {
    features[FEATURE.quietApproach] = nearestEnemyDistance(state.board, action.from, color)
      - nearestEnemyDistance(state.board, action.to, color);
  }
}

export function rlCandidates(state, color = state.turn) {
  const actions = legalActionsFor(state, color);
  const pool = [];
  if (actions.flips.length) {
    const inventory = remainingInventory(state);
    for (const [pieceColor, types] of Object.entries(inventory.remaining)) {
      for (const [type, count] of Object.entries(types)) {
        if (count) pool.push({ piece: { type, color: pieceColor, revealed: true }, chance: count / inventory.pool.length });
      }
    }
  }
  const before = new Map();
  return actions.all.map((action) => {
    const features = Array(FEATURE_NAMES.length).fill(0);
    const square = action.type === "flip" ? action.index : action.to;
    features[FEATURE.center] = 1 - (Math.abs(Math.floor(square / COLS) - (ROWS - 1) / 2)
      + Math.abs(square % COLS - (COLS - 1) / 2)) / ((COLS + ROWS - 2) / 2);
    if (action.type === "flip") {
      fillFlip(features, state, color, square, pool, actions.flips.length);
    } else {
      if (!before.has(action.from)) {
        before.set(action.from, tactics(state.board, action.from, state.board[action.from], contacts(state.board, action.from), state.ruleIds));
      }
      fillMove(features, state, color, action, before.get(action.from));
    }
    return { action, features };
  });
}

export function chooseRLAction(state, color, options = {}) {
  const started = performance.now();
  if (state.status !== "playing" || state.turn !== color) {
    return { aiVersion: "v3", method: "rl-policy", action: null, candidates: [], elapsedMs: 0, iterations: 0 };
  }
  const weights = options.weights ?? loadRLModel().weights;
  const random = createSeededRng(options.seed ?? Date.now());
  const rows = rlCandidates(state, color).map(({ action, features }) => ({
    action, logit: policyScore(features, weights), win: features[FEATURE.winningCapture], tie: random(),
  }));
  rows.sort((a, b) => b.win - a.win || b.logit - a.logit || a.tie - b.tie);
  const max = rows.reduce((high, row) => Math.max(high, row.logit), -Infinity);
  const total = rows.reduce((sum, row) => sum + Math.exp(row.logit - max), 0);
  const candidates = rows.map(({ action, logit, win }) => ({
    action, key: actionKey(action), prior: Math.exp(logit - max) / total,
    // This single pass yields a policy preference, not a rollout visit.
    visits: 0, score: win ? 1 : Math.tanh(logit),
  }));
  return { aiVersion: "v3", method: "rl-policy", action: candidates[0]?.action ?? null,
    score: candidates[0]?.score ?? 0, candidates, elapsedMs: Math.round(performance.now() - started), iterations: 1 };
}
