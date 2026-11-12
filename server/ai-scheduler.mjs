import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import {
  actionKey,
  DEFAULT_AI_SEARCH_MS,
  MAX_AI_SEARCH_MS,
  informationSetKey,
} from "./ai-engine.mjs";
import { legalActionsFor } from "./game-engine.mjs";

export const AI_SEARCH_QUANTUM_MS = 400;

const SAMPLING_METHOD = { v1: "so-ismcts", v2: "belief-mcts-v2", v3: "rl-rollout" };

export function defaultAIWorkerCount(parallelism = availableParallelism()) {
  return Math.max(1, Math.floor(Math.max(1, Number(parallelism) || 1) / 2));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function aggregateISMCTS(results, elapsedMs, threadCount, aiVersion = "v1") {
  const candidates = new Map();
  let iterations = 0;
  let ponderIterations = 0;
  for (const entry of results) {
    iterations += entry.result.iterations ?? 0;
    ponderIterations += entry.result.ponderIterations ?? 0;
    for (const candidate of entry.result.candidateDeltas ?? entry.result.candidates ?? []) {
      const key = actionKey(candidate.action);
      const current = candidates.get(key) ?? {
        action: candidate.action,
        visits: 0,
        weightedScore: 0,
        prior: candidate.prior ?? 0,
      };
      const visits = Math.max(0, candidate.visits ?? 0);
      current.visits += visits;
      current.weightedScore += (candidate.score ?? 0) * visits;
      current.prior = Math.max(current.prior, candidate.prior ?? 0);
      candidates.set(key, current);
    }
  }
  const ranked = [...candidates.values()]
    .map((candidate) => ({
      action: candidate.action,
      visits: candidate.visits,
      score: candidate.visits ? candidate.weightedScore / candidate.visits : -1,
      prior: candidate.prior,
    }))
    .sort((a, b) => b.visits - a.visits || b.score - a.score || b.prior - a.prior);
  return {
    action: ranked[0]?.action ?? null,
    method: `parallel-${SAMPLING_METHOD[aiVersion]}`,
    aiVersion,
    elapsedMs,
    iterations,
    candidates: ranked.slice(0, 8),
    threads: threadCount,
    quanta: results.length,
    ponderIterations,
  };
}

function mergeCandidateMap(target, candidates = []) {
  for (const candidate of candidates) {
    const key = actionKey(candidate.action);
    const current = target.get(key) ?? {
      action: candidate.action,
      visits: 0,
      weightedScore: 0,
      prior: candidate.prior ?? 0,
    };
    const visits = Math.max(0, candidate.visits ?? 0);
    current.visits += visits;
    current.weightedScore += (candidate.score ?? 0) * visits;
    current.prior = Math.max(current.prior, candidate.prior ?? 0);
    target.set(key, current);
  }
}

function rankedCandidateMap(candidates) {
  return [...candidates.values()]
    .map((candidate) => ({
      action: candidate.action,
      visits: candidate.visits,
      score: candidate.visits ? candidate.weightedScore / candidate.visits : -1,
      prior: candidate.prior,
    }))
    .sort((a, b) => b.visits - a.visits || b.score - a.score || b.prior - a.prior);
}

function accumulatedRootCandidates(results) {
  const candidates = new Map();
  for (const entry of results) {
    mergeCandidateMap(candidates, entry.result?.candidateDeltas ?? entry.result?.candidates);
  }
  return rankedCandidateMap(candidates);
}

function aggregateEndgame(results, elapsedMs, threadCount, aiVersion = "v1") {
  const deepestByAction = new Map();
  for (const entry of results) {
    const result = entry.result;
    if (!result.action) continue;
    const key = actionKey(result.action);
    const current = deepestByAction.get(key);
    if (!current || (result.completedDepth ?? 0) > (current.completedDepth ?? 0)) {
      deepestByAction.set(key, result);
    }
  }
  const ranked = [...deepestByAction.values()].sort((a, b) => (
    (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
    (b.completedDepth ?? 0) - (a.completedDepth ?? 0)
  ));
  const best = ranked[0];
  return {
    action: best?.action ?? null,
    method: aiVersion === "v2" ? "parallel-alpha-beta-v2" : "parallel-alpha-beta",
    aiVersion,
    elapsedMs,
    score: best?.score ?? null,
    completedDepth: best?.completedDepth ?? 0,
    nodes: results.reduce((sum, entry) => sum + (entry.result.nodes ?? 0), 0),
    threads: threadCount,
    quanta: results.length,
  };
}

export class AISearchScheduler {
  constructor({
    workerCount = defaultAIWorkerCount(),
    quantumMs = AI_SEARCH_QUANTUM_MS,
    workerFactory = () => new Worker(new URL("./ai-worker.mjs", import.meta.url)),
  } = {}) {
    this.workerCount = Math.max(1, Math.floor(workerCount));
    this.quantumMs = clamp(Math.floor(quantumMs), 25, 1_000);
    this.workerFactory = workerFactory;
    this.jobs = new Map();
    this.slots = [];
    this.closed = false;
    this.roundRobin = 0;
    for (let index = 0; index < this.workerCount; index += 1) this.spawnSlot(index);
  }

  spawnSlot(index) {
    if (this.closed) return;
    const worker = this.workerFactory(index);
    const slot = { index, worker, busy: false, taskId: null, jobId: null };
    this.slots[index] = slot;
    worker.on("message", (message) => this.handleWorkerMessage(slot, message));
    worker.on("error", () => this.handleWorkerFailure(slot));
    worker.on("exit", (code) => {
      if (!this.closed && this.slots[index] === slot && code !== 0) this.handleWorkerFailure(slot);
    });
    worker.unref?.();
  }

  handleWorkerFailure(slot) {
    if (this.slots[slot.index] !== slot) return;
    const job = slot.jobId ? this.jobs.get(slot.jobId) : null;
    if (job) job.inFlight = Math.max(0, job.inFlight - 1);
    this.slots[slot.index] = null;
    slot.worker.terminate().catch(() => {});
    if (!this.closed) this.spawnSlot(slot.index);
    this.dispatch();
  }

  submit({
    id,
    publicState,
    color,
    timeLimitMs = DEFAULT_AI_SEARCH_MS,
    wallTimeMs,
    seed = Date.now(),
    mode = "search",
    initialResult = null,
    aiVersion = "v1",
  }) {
    if (this.closed) return Promise.reject(new Error("AI scheduler is closed"));
    if (this.jobs.has(id)) this.cancel(id);
    const startedAt = Date.now();
    const budget = mode === "ponder"
      ? clamp(Number(wallTimeMs) || Number(timeLimitMs) || DEFAULT_AI_SEARCH_MS, 5, 60_000)
      : clamp(Number(timeLimitMs) || DEFAULT_AI_SEARCH_MS, 5, MAX_AI_SEARCH_MS);
    const rootActionKeys = legalActionsFor(publicState, color).all.map(actionKey);
    const hiddenCount = publicState.board.filter((piece) => piece && !piece.revealed).length;
    let resolveJob;
    const promise = new Promise((resolve) => { resolveJob = resolve; });
    const job = {
      id,
      publicState,
      color,
      seed: Number(seed) >>> 0,
      startedAt,
      deadline: startedAt + budget,
      mode,
      aiVersion: ["v2", "v3"].includes(aiVersion) ? aiVersion : "v1",
      hiddenCount,
      rootActionKeys,
      nextRootShard: 0,
      nextSequence: 0,
      inFlight: 0,
      results: initialResult && (hiddenCount || aiVersion === "v3") ? [{ result: initialResult, workerIndex: -1 }] : [],
      ponderCache: new Map(),
      ponderIterations: 0,
      quantaCompleted: 0,
      workersUsed: new Set(),
      resolve: resolveJob,
      timer: null,
    };
    job.timer = setTimeout(() => this.finish(job), budget);
    job.timer.unref?.();
    this.jobs.set(id, job);
    this.dispatch();
    return promise;
  }

  pickJob() {
    const now = Date.now();
    const active = [...this.jobs.values()].filter((job) => job.deadline - now >= 10);
    if (!active.length) return null;
    const minimumInFlight = Math.min(...active.map((job) => job.inFlight));
    const balanced = active.filter((job) => job.inFlight === minimumInFlight);
    const selected = balanced[this.roundRobin % balanced.length];
    this.roundRobin += 1;
    return selected;
  }

  dispatch() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (!slot || slot.busy) continue;
      const job = this.pickJob();
      if (!job) break;
      const remaining = job.deadline - Date.now();
      if (remaining < 10) continue;
      const sequence = job.nextSequence++;
      const taskId = `${job.id}:${sequence}`;
      const options = {
        timeLimitMs: Math.max(5, Math.min(this.quantumMs, remaining - 5)),
        seed: (job.seed + Math.imul(sequence + 1, 0x9e3779b1)) >>> 0,
        aiVersion: job.aiVersion,
      };
      if (job.aiVersion === "v2") options.v2Lane = sequence % 8 === 0 ? "belief" : "classic";
      if (job.aiVersion === "v3") options.searchQuantum = true;
      if ((job.aiVersion === "v3" || options.v2Lane === "classic") && job.results.length) {
        options.initialCandidates = accumulatedRootCandidates(job.results);
      }
      if (job.mode === "ponder") options.ponder = true;
      if (job.mode === "search" && job.aiVersion !== "v3" && (!job.hiddenCount || (job.aiVersion === "v2" && job.hiddenCount === 1)) && job.rootActionKeys.length) {
        options.rootActionKeys = [job.rootActionKeys[job.nextRootShard % job.rootActionKeys.length]];
        job.nextRootShard += 1;
      }
      slot.busy = true;
      slot.taskId = taskId;
      slot.jobId = job.id;
      job.inFlight += 1;
      job.workersUsed.add(slot.index);
      slot.worker.postMessage({ type: "search", taskId, publicState: job.publicState, color: job.color, options });
    }
  }

  handleWorkerMessage(slot, message) {
    if (!slot.busy || message?.taskId !== slot.taskId) return;
    const job = this.jobs.get(slot.jobId);
    slot.busy = false;
    slot.taskId = null;
    slot.jobId = null;
    if (job) {
      job.inFlight = Math.max(0, job.inFlight - 1);
      if (message.ok && message.result) {
        job.quantaCompleted += 1;
        if (["ponder-ismcts", "ponder-belief-mcts-v2", "ponder-hybrid-mcts-v2", "ponder-rl-rollout"].includes(message.result.method)) {
          job.ponderIterations += message.result.iterations ?? 0;
          for (const state of message.result.ponderStates ?? []) {
            const cached = job.ponderCache.get(state.key) ?? { candidates: new Map(), visits: 0 };
            mergeCandidateMap(cached.candidates, state.candidates);
            cached.visits += state.visits ?? 0;
            job.ponderCache.set(state.key, cached);
          }
        } else {
          job.results.push({ result: message.result, workerIndex: slot.index });
        }
        if (job.mode === "search" && ["forced-win", "forced-win-v2", "forced-win-v3"].includes(message.result.method)) {
          this.finish(job, {
            ...message.result,
            elapsedMs: Date.now() - job.startedAt,
            threads: job.workersUsed.size,
            quanta: job.results.length,
          });
        }
      }
    }
    this.dispatch();
  }

  aggregate(job) {
    const elapsedMs = Math.min(MAX_AI_SEARCH_MS, Date.now() - job.startedAt);
    const valid = job.results.filter((entry) => entry.result?.action);
    if (!valid.length) return null;
    const ismcts = valid.filter((entry) => ["so-ismcts", "belief-mcts-v2", "hybrid-mcts-v2", "rl-rollout"].includes(entry.result.method));
    if (ismcts.length) return aggregateISMCTS(ismcts, elapsedMs, job.workersUsed.size, job.aiVersion);
    const endgames = valid.filter((entry) => ["alpha-beta", "alpha-beta-v2", "deduced-alpha-beta-v2"].includes(entry.result.method));
    if (endgames.length) return aggregateEndgame(endgames, elapsedMs, job.workersUsed.size, job.aiVersion);
    const first = valid[0].result;
    return { ...first, elapsedMs, threads: job.workersUsed.size, quanta: valid.length };
  }

  harvest(id, publicState) {
    const job = this.jobs.get(id);
    if (!job || job.mode !== "ponder") return null;
    const key = informationSetKey(publicState);
    const cached = job.ponderCache.get(key);
    let result = null;
    if (cached?.candidates.size) {
      const candidates = rankedCandidateMap(cached.candidates);
      result = {
        action: candidates[0]?.action ?? null,
        method: SAMPLING_METHOD[job.aiVersion],
        aiVersion: job.aiVersion,
        elapsedMs: 0,
        iterations: 0,
        ponderIterations: job.aiVersion === "v3" ? cached.visits : job.ponderIterations,
        candidates: candidates.slice(0, 8),
        threads: job.workersUsed.size,
        quanta: 0,
      };
    }
    this.finish(job, null);
    return result;
  }

  finish(job, result = this.aggregate(job)) {
    if (!job || this.jobs.get(job.id) !== job) return false;
    this.jobs.delete(job.id);
    clearTimeout(job.timer);
    job.resolve(result);
    this.dispatch();
    return true;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    return this.finish(job, null);
  }

  snapshot() {
    return {
      workerCount: this.workerCount,
      busyWorkers: this.slots.filter((slot) => slot?.busy).length,
      jobs: [...this.jobs.values()].map((job) => ({
        id: job.id,
        mode: job.mode,
        inFlight: job.inFlight,
        quanta: job.quantaCompleted,
        cachedStates: job.ponderCache.size,
      })),
    };
  }

  async close() {
    this.closed = true;
    for (const job of [...this.jobs.values()]) this.finish(job, null);
    const workers = this.slots.map((slot) => slot?.worker).filter(Boolean);
    this.slots = [];
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
  }
}
