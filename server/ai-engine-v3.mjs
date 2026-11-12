import { actionKey, createSeededRng, informationSetKey, DEFAULT_AI_SEARCH_MS, MAX_AI_SEARCH_MS } from "./ai-engine.mjs";
import { applyBeliefAction } from "./ai-engine-v2.mjs";
import { otherColor } from "./game-engine.mjs";
import { chooseRLAction, loadRLModel, policyScore, rlCandidates } from "./rl-policy.mjs";

// Each simulation flips from the remaining public inventory. Until flipped, a
// square has no assigned identity, even for the simulated opponent's policy.
function policyDistribution(state, weights) {
  const choices = rlCandidates(state, state.turn);
  const wins = state.health[otherColor(state.turn)] === 1
    ? choices.filter(({ action }) => action.capture)
    : [];
  const ranked = (wins.length ? wins : choices).map(({ action, features }) => ({
    action, prior: policyScore(features, weights),
  }));
  if (!ranked.length) return ranked;
  const maxScore = Math.max(...ranked.map(({ prior }) => prior));
  let total = 0;
  for (const entry of ranked) {
    entry.prior = Math.exp(entry.prior - maxScore);
    total += entry.prior;
  }
  for (const entry of ranked) entry.prior /= total;
  return ranked;
}

function samplePolicy(choices, rng) {
  let threshold = rng();
  for (const entry of choices) {
    threshold -= entry.prior;
    if (threshold <= 0) return entry.action;
  }
  return choices.at(-1)?.action;
}

function searchNode(choices, initialCandidates = []) {
  const previous = new Map(initialCandidates.map((entry) => [actionKey(entry.action), entry]));
  const entries = choices.map(({ action, prior }) => {
    const seed = previous.get(actionKey(action));
    const visits = seed?.visits ?? 0;
    return { action, prior, visits, sum: visits * (seed?.score ?? 0), newVisits: 0, newSum: 0 };
  });
  return { entries, visits: entries.reduce((n, entry) => n + entry.visits, 0) };
}

function selectForSimulation(node, rng) {
  let best = null;
  let bestScore = -Infinity;
  const scale = 1.65 * Math.sqrt(node.visits + 1);
  for (const entry of node.entries) {
    const mean = entry.visits ? entry.sum / entry.visits : 0;
    const exploration = (0.9 * entry.prior + 0.1 / node.entries.length) * scale / (entry.visits + 1);
    const score = mean + exploration + rng() * 1e-8;
    if (score > bestScore) { best = entry; bestScore = score; }
  }
  return best;
}

function simulate(node, state, color, weights, rng, deadline) {
  const entry = selectForSimulation(node, rng);
  if (!entry || !applyBeliefAction(state, entry.action, rng)) return false;
  for (let ply = 0; ply < 12 && state.status === "playing"; ply++) {
    if (Date.now() >= deadline) return false;
    const next = samplePolicy(policyDistribution(state, weights), rng);
    if (!next || !applyBeliefAction(state, next, rng)) break;
  }
  const score = state.status === "finished"
    ? (state.winner === color ? 1 : -1)
    : Math.tanh((state.health[color] - state.health[otherColor(color)]) / 3);
  entry.visits++;
  entry.newVisits++;
  entry.sum += score;
  entry.newSum += score;
  node.visits++;
  return true;
}

function report(node, delta = false) {
  return node.entries.map((entry) => {
    const visits = delta ? entry.newVisits : entry.visits;
    const sum = delta ? entry.newSum : entry.sum;
    return { action: entry.action, prior: entry.prior, visits, score: visits ? sum / visits : 0 };
  }).sort((a, b) => b.visits - a.visits || b.score - a.score || b.prior - a.prior);
}

export function chooseAIActionV3(publicState, color, options = {}) {
  const start = Date.now();
  const budget = Math.min(MAX_AI_SEARCH_MS, Math.max(1, options.timeLimitMs ?? DEFAULT_AI_SEARCH_MS));
  const deadline = start + budget;
  const pondering = options.ponder === true && publicState.turn !== color;
  if (!pondering && publicState.turn !== color) {
    return { action: null, aiVersion: "v3", method: "rl-policy", elapsedMs: 0, iterations: 0 };
  }
  if (!pondering && budget <= 25 && !options.searchQuantum) return chooseRLAction(publicState, color, options);
  const { weights } = loadRLModel();
  const rng = createSeededRng(options.seed ?? start);
  const choices = policyDistribution(publicState, weights);
  if (!choices.length) {
    return { action: null, aiVersion: "v3", method: "rl-policy", elapsedMs: Date.now() - start, iterations: 0 };
  }
  if (!pondering && publicState.health[otherColor(color)] === 1 && choices[0].action.capture) {
    return { action: choices[0].action, method: "forced-win-v3", aiVersion: "v3", elapsedMs: Date.now() - start, iterations: 0, score: 1 };
  }
  const root = searchNode(choices, options.initialCandidates);
  const branches = new Map();
  let iterations = 0;
  for (let trial = 0; trial < (options.maxIterations ?? Infinity) && Date.now() < deadline; trial++) {
    const state = structuredClone(publicState);
    let node = root;
    if (pondering) {
      // Sample unlikely human moves too. Only the observed successor's
      // statistics will be reused when the human finishes their turn.
      const prediction = rng() < 0.25
        ? choices[Math.floor(rng() * choices.length)].action : samplePolicy(choices, rng);
      if (!applyBeliefAction(state, prediction, rng) || state.status !== "playing") continue;
      const key = informationSetKey(state);
      node = branches.get(key);
      if (!node) {
        node = searchNode(policyDistribution(state, weights));
        branches.set(key, node);
      }
    }
    if (simulate(node, state, color, weights, rng, deadline)) iterations++;
  }
  const common = { aiVersion: "v3", iterations, elapsedMs: Date.now() - start };
  if (pondering) {
    const ponderStates = [...branches].filter(([, node]) => node.visits).map(([key, node]) => ({
      key, visits: node.visits, candidates: report(node).filter((entry) => entry.visits),
    }));
    return { ...common, action: null, method: "ponder-rl-rollout", ponderStates };
  }
  const candidates = report(root);
  return { ...common, action: candidates[0].action, method: "rl-rollout", candidates, candidateDeltas: report(root, true) };
}
