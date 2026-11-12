import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSeededRng, publicStateForAI } from "../server/ai-engine.mjs";
import { createGame, flipPiece, legalActionsFor, movePiece, processTurnTimeout } from "../server/game-engine.mjs";
import { FEATURE_NAMES, chooseRLAction, policyScore, rlCandidates } from "../server/rl-policy.mjs";

const ruleSets = [[], ["snake"], ["football-poison"], ["football-poison", "snake"]];
const healthLevels = [4, 8, 14, 16, 6, 10, 14, 14];
const defaultModel = fileURLToPath(new URL("../server/models/rl-v3.json", import.meta.url));
const maxPlies = 180;
const discount = 0.94;
const trainingSeed = 20261112;
const evaluationSeed = 949100827;

function makeGame(seed, ruleIds, initialHealth) {
  return createGame({ rng: createSeededRng(seed), ruleIds, initialHealth, playerIds: ["a", "b"], now: 0 });
}

function step(game, action, ply) {
  const color = game.turn;
  const now = ply * game.turnDurationMs;
  if (!action) processTurnTimeout(game, game.turnDeadline);
  else if (action.type === "flip") flipPiece(game, color, action.index, { now });
  else movePiece(game, color, action.from, action.to, { now });
  // The offline environment only needs the current position and repetition history.
  game.replayFrames.length = 0;
}

// For softmax(dot(w, x)), grad(log(pi(a))) = x[a] - E_pi[x].
export function samplePolicy(rows, weights, rng) {
  const logits = rows.map(row => policyScore(row.features, weights));
  const maximum = Math.max(...logits);
  const masses = logits.map(logit => Math.exp(logit - maximum));
  const total = masses.reduce((sum, mass) => sum + mass, 0);
  let ticket = rng() * total;
  let index = 0;
  while (index + 1 < masses.length && ticket >= masses[index]) ticket -= masses[index++];
  const gradient = Float64Array.from(rows[index].features);
  for (let i = 0; i < rows.length; i++) {
    const probability = masses[i] / total;
    for (let k = 0; k < gradient.length; k++) gradient[k] -= probability * rows[i].features[k];
  }
  return { action: rows[index].action, gradient };
}

function trainEpisode(game, weights, rng) {
  const trajectory = [];
  for (let ply = 0; ply < maxPlies && game.status === "playing"; ply++) {
    const color = game.turn;
    const rows = rlCandidates(publicStateForAI(game), color);
    const decision = rows.length ? samplePolicy(rows, weights, rng) : { action: null, gradient: null };
    const differenceBefore = game.health.blue - game.health.red;
    step(game, decision.action, ply + 1);
    const differenceAfter = game.health.blue - game.health.red;
    let blueReward = 0.5 * (differenceAfter - differenceBefore);
    if (game.winner) blueReward += game.winner === "blue" ? 2 : -2;
    trajectory.push({ color, blueReward, gradient: decision.gradient });
  }
  let blueReturn = 0;
  const gradient = new Float64Array(weights.length);
  for (let t = trajectory.length - 1; t >= 0; t--) {
    const frame = trajectory[t];
    blueReturn = frame.blueReward + discount * blueReturn;
    const actorReturn = frame.color === "blue" ? blueReturn : -blueReturn;
    if (!frame.gradient) continue;
    for (let k = 0; k < weights.length; k++) gradient[k] += frame.gradient[k] * actorReturn;
  }
  return { gradient, plies: trajectory.length, finished: Boolean(game.winner) };
}

export function train(games, seed, progress = () => {}) {
  const weights = Array(FEATURE_NAMES.length).fill(0);
  const firstMoment = new Float64Array(weights.length);
  const secondMoment = new Float64Array(weights.length);
  let completedGames = 0;
  let plies = 0;
  for (let i = 0; i < games; i++) {
    const episodeSeed = seed + i * 7919;
    const ruleIds = ruleSets[i % ruleSets.length];
    const health = healthLevels[Math.floor(i / ruleSets.length) % healthLevels.length];
    const game = makeGame(episodeSeed, ruleIds, health);
    const episode = trainEpisode(game, weights, createSeededRng(episodeSeed ^ 0x2e97b94d));
    completedGames += Number(episode.finished);
    plies += episode.plies;
    // Adam performs ascent on both players' sampled policy gradients.
    const rate = 0.04 / Math.sqrt(1 + i / 256);
    for (let k = 0; k < weights.length; k++) {
      const g = episode.gradient[k] / episode.plies;
      firstMoment[k] = 0.9 * firstMoment[k] + 0.1 * g;
      secondMoment[k] = 0.999 * secondMoment[k] + 0.001 * g * g;
      const m = firstMoment[k] / (1 - 0.9 ** (i + 1));
      const v = secondMoment[k] / (1 - 0.999 ** (i + 1));
      weights[k] += rate * m / (Math.sqrt(v) + 1e-8);
    }
    if ((i + 1) % 32 === 0) progress(i + 1, plies);
  }
  return {
    schemaVersion: 1,
    featureNames: [...FEATURE_NAMES],
    weights,
    training: {
      algorithm: "Self-play REINFORCE with softmax linear policy and Adam",
      seed, games, plies, completedGames, maxPlies, ruleSets, healthLevels, discount,
      reward: "0.5 * change in health lead, plus +2 for winning or -2 for losing",
    },
  };
}

function baseline(state, color, opponent, rng) {
  const legal = legalActionsFor(state, color);
  let choices = legal.all;
  if (opponent === "captureFirst") {
    choices = legal.captures.length ? legal.captures : legal.flips.length ? legal.flips : legal.all;
  }
  return choices[Math.floor(rng() * choices.length)] ?? null;
}

export function evaluate(weights, pairsPerRule) {
  const results = [];
  for (const opponent of ["uniformRandom", "captureFirst"]) {
    for (const [r, ruleIds] of ruleSets.entries()) {
      const score = { opponent, ruleIds, wins: 0, draws: 0, losses: 0, plies: 0 };
      for (let pair = 0; pair < pairsPerRule; pair++) {
        const seed = evaluationSeed + (pair * 4 + r) * 7927;
        for (const color of ["blue", "red"]) {
          const game = makeGame(seed, ruleIds, 14);
          const rng = createSeededRng(seed ^ 0x796bc7);
          // Both agents in a pair receive the same board and swap seats.
          for (let ply = 0; game.status === "playing" && ply < maxPlies; ply++) {
            const state = publicStateForAI(game);
            const action = game.turn === color
              ? chooseRLAction(state, color, { weights, seed: seed + 997 * ply }).action
              : baseline(state, game.turn, opponent, rng);
            step(game, action, ply + 1);
            score.plies++;
          }
          if (!game.winner) score.draws++;
          else if (game.winner === color) score.wins++;
          else score.losses++;
        }
      }
      results.push(score);
    }
  }
  return { seed: evaluationSeed, pairsPerRule, initialHealth: 14, maxPlies, policy: "deployed V3 policy with seeded tie breaks", results };
}

function positiveInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(label + " must be a positive integer");
  return number;
}

async function main() {
  const output = resolve(process.env.RL_OUTPUT ?? defaultModel);
  const pairs = positiveInteger(process.env.RL_EVAL_PAIRS, "RL_EVAL_PAIRS", 16);
  if (process.argv.includes("--evaluate")) {
    const model = JSON.parse(await readFile(output, "utf8"));
    console.log(JSON.stringify(evaluate(model.weights, pairs), null, 2));
    return;
  }
  const games = positiveInteger(process.env.RL_GAMES, "RL_GAMES", 2048);
  const seed = positiveInteger(process.env.RL_SEED, "RL_SEED", trainingSeed);
  const model = train(games, seed, (count, plies) => console.log("Self-play", count, "/", games, "games,", plies, "plies"));
  model.evaluation = evaluate(model.weights, pairs);
  await mkdir(dirname(output), { recursive: true });
  const temp = output + "." + process.pid + ".tmp";
  await writeFile(temp, JSON.stringify(model, null, 2) + "\n", { flag: "wx" });
  await rename(temp, output);
  console.log("Saved", output, JSON.stringify(model.evaluation.results));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
