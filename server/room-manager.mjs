import { randomInt, randomUUID } from "node:crypto";
import {
  COLORS,
  GameRuleError,
  colorForPlayer,
  createGame,
  flipPiece,
  gameViewFor,
  legalActionsFor,
  makePiece,
  movePiece,
  processTurnTimeout,
  recordCurrentPosition,
  refreshLatestReplayFrame,
  resetReplayFrames,
  resignGame,
} from "./game-engine.mjs";
import {
  DEFAULT_AI_SEARCH_MS,
  MAX_AI_SEARCH_MS,
  publicStateForAI,
} from "./ai-engine.mjs";
import { AI_SEARCH_QUANTUM_MS, AISearchScheduler, defaultAIWorkerCount } from "./ai-scheduler.mjs";
import {
  DEFAULT_AI_VERSION,
  chooseVersionedAIAction,
  normalizeAIVersion,
} from "./ai-versions.mjs";
import { normalizeRuleIds, ruleCatalog } from "./rule-system.mjs";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const AI_NAMES = ["AI·小虎", "AI·象博士", "AI·森林守卫", "AI·闪电鼠"];

export class LobbyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LobbyError";
    this.code = code;
  }
}

function cleanText(value, fallback, maxLength) {
  const cleaned = String(value ?? "")
    .replace(/[<>\u0000-\u001f]/g, "")
    .trim()
    .slice(0, maxLength);
  return cleaned || fallback;
}

function roomCode() {
  let code = "";
  for (let index = 0; index < 5; index += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export class RoomManager {
  constructor({
    disconnectGraceMs = 20_000,
    turnDurationMs = 30_000,
    qaEnabled = false,
    aiThinkMinMs = 150,
    aiThinkMaxMs = 300,
    aiSearchTimeMs = DEFAULT_AI_SEARCH_MS,
    aiWorkerCount = defaultAIWorkerCount(),
    aiQuantumMs = AI_SEARCH_QUANTUM_MS,
    historyStore = null,
    rng = Math.random,
    now = () => Date.now(),
  } = {}) {
    this.rooms = new Map();
    this.clients = new Map();
    this.disconnectGraceMs = disconnectGraceMs;
    this.turnDurationMs = turnDurationMs;
    this.qaEnabled = qaEnabled;
    this.aiThinkMinMs = aiThinkMinMs;
    this.aiThinkMaxMs = Math.max(aiThinkMinMs, aiThinkMaxMs);
    this.aiSearchTimeMs = Math.min(MAX_AI_SEARCH_MS, Math.max(5, Number(aiSearchTimeMs) || DEFAULT_AI_SEARCH_MS));
    this.aiWorkerCount = Math.max(1, Math.floor(aiWorkerCount));
    this.aiQuantumMs = aiQuantumMs;
    this.aiScheduler = null;
    this.aiSearches = new Map();
    this.historyStore = historyStore;
    this.rng = rng;
    this.now = now;
  }

  attach({ sessionId = randomUUID(), nickname, transport }) {
    if (!transport || typeof transport.send !== "function") {
      throw new TypeError("transport.send is required");
    }

    let client = this.clients.get(sessionId);
    const reconnected = Boolean(client);
    if (!client) {
      client = {
        id: sessionId,
        nickname: cleanText(nickname, `玩家${randomInt(100, 999)}`, 12),
        roomId: null,
        transport: null,
        disconnectTimer: null,
        isAI: false,
      };
      this.clients.set(sessionId, client);
    } else if (nickname) {
      client.nickname = cleanText(nickname, client.nickname, 12);
    }

    if (client.disconnectTimer) {
      clearTimeout(client.disconnectTimer);
      client.disconnectTimer = null;
    }
    if (client.transport && client.transport !== transport && typeof client.transport.close === "function") {
      client.transport.close(4001, "已在另一页面重新连接");
    }
    client.transport = transport;

    this.send(client, {
      type: "welcome",
      sessionId: client.id,
      nickname: client.nickname,
      reconnected,
      qaEnabled: this.qaEnabled,
      disconnectGraceMs: this.disconnectGraceMs,
      serverNow: this.now(),
    });
    this.send(client, { type: "lobby", rooms: this.lobbyView() });
    if (client.roomId) {
      const room = this.rooms.get(client.roomId);
      if (room) this.send(client, this.roomView(room, client));
      else client.roomId = null;
    }
    if (client.roomId) this.broadcastRoom(this.rooms.get(client.roomId));
    return client;
  }

  detach(sessionId, transport) {
    const client = this.clients.get(sessionId);
    if (!client) return;
    if (client.isAI) return;
    if (transport && client.transport !== transport) return;
    client.transport = null;
    if (!client.roomId) return;

    const room = this.rooms.get(client.roomId);
    if (!room) {
      client.roomId = null;
      return;
    }
    this.broadcastRoom(room);
    client.disconnectTimer = setTimeout(() => {
      client.disconnectTimer = null;
      if (client.transport || !client.roomId) return;
      this.leaveRoom(client, { reason: "disconnect", silent: true });
    }, this.disconnectGraceMs);
    client.disconnectTimer.unref?.();
  }

  send(client, payload) {
    if (!client?.transport) return false;
    try {
      client.transport.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  notice(client, message, tone = "info") {
    this.send(client, { type: "notice", message, tone });
  }

  sendHistoryList(client) {
    this.send(client, {
      type: "history_list",
      records: this.historyStore?.list() ?? [],
    });
  }

  sendHistoryRecord(client, id) {
    const record = this.historyStore?.get(String(id ?? "")) ?? null;
    if (!record) throw new LobbyError("history_not_found", "没有找到这局历史对局");
    this.send(client, { type: "history_record", record });
  }

  recordFinishedGame(room) {
    const game = room?.game;
    if (!this.historyStore || !game || game.status !== "finished" || game.historyPersisted) return false;
    const participants = room.gameParticipants ?? {};
    const record = {
      schemaVersion: 1,
      id: game.id,
      roomId: room.id,
      roomName: room.name,
      startedAt: game.startedAt,
      endedAt: game.endedAt ?? this.now(),
      initialHealth: game.initialHealth,
      players: COLORS.map((color) => ({
        color,
        id: participants[color]?.id ?? game.players[color],
        nickname: participants[color]?.nickname ?? this.clients.get(game.players[color])?.nickname ?? "玩家",
        isAI: Boolean(participants[color]?.isAI ?? this.clients.get(game.players[color])?.isAI),
        aiVersion: participants[color]?.isAI
          ? normalizeAIVersion(participants[color]?.aiVersion ?? room.aiVersion)
          : null,
      })),
      winner: game.winner,
      loser: game.loser,
      endReason: game.endReason,
      ruleIds: [...(game.ruleIds ?? [])],
      frames: structuredClone(game.replayFrames ?? []),
    };
    try {
      this.historyStore.append(record);
      game.historyPersisted = true;
      return true;
    } catch (error) {
      console.error("保存历史对局失败", error);
      return false;
    }
  }

  fail(client, error) {
    const known = error instanceof LobbyError || error instanceof GameRuleError;
    this.send(client, {
      type: "error",
      code: known ? error.code : "server_error",
      message: known ? error.message : "服务器暂时无法完成这个操作",
    });
  }

  lobbyView() {
    return [...this.rooms.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((room) => ({
        id: room.id,
        name: room.name,
        status: room.status,
        health: room.health,
        aiVersion: room.aiVersion,
        ruleIds: [...room.ruleIds],
        players: room.players.filter(Boolean).length,
        capacity: 2,
        spectators: room.spectators.size,
        hostName: this.clients.get(room.hostId)?.nickname ?? "玩家",
      }));
  }

  roomView(room, viewer) {
    const seatIndex = room.players.indexOf(viewer.id);
    const role = seatIndex >= 0 ? "player" : "spectator";
    const now = this.now();
    return {
      type: "room",
      room: {
        id: room.id,
        name: room.name,
        status: room.status,
        health: room.health,
        aiVersion: room.aiVersion,
        ruleIds: [...room.ruleIds],
        availableRules: ruleCatalog(),
        isHost: room.hostId === viewer.id,
        role,
        seatIndex,
        ready: room.ready.has(viewer.id),
        players: room.players.map((id, index) => {
          const player = id ? this.clients.get(id) : null;
          return player
            ? {
                id,
                seatIndex: index,
                nickname: player.nickname,
                connected: player.isAI || Boolean(player.transport),
                ready: room.ready.has(id),
                color: room.game ? colorForPlayer(room.game, id) : null,
                isHost: room.hostId === id,
                isAI: Boolean(player.isAI),
                aiVersion: player.isAI ? normalizeAIVersion(player.aiVersion ?? room.aiVersion) : null,
                aiThinking: Boolean(player.isAI && room.aiThinking && room.game?.turn === colorForPlayer(room.game, id)),
                aiPondering: Boolean(player.isAI && room.aiPondering && room.game?.turn !== colorForPlayer(room.game, id)),
              }
            : null;
        }),
        spectators: [...room.spectators].map((id) => ({
          id,
          nickname: this.clients.get(id)?.nickname ?? "观战者",
          connected: Boolean(this.clients.get(id)?.transport),
        })),
        game: room.game ? gameViewFor(room.game, viewer.id, now) : null,
        qaEnabled: this.qaEnabled,
        serverNow: now,
      },
    };
  }

  broadcastLobby() {
    const payload = { type: "lobby", rooms: this.lobbyView() };
    for (const client of this.clients.values()) this.send(client, payload);
  }

  broadcastRoom(room) {
    if (!room) return;
    const memberIds = [...room.players.filter(Boolean), ...room.spectators];
    for (const id of memberIds) {
      const client = this.clients.get(id);
      if (client) this.send(client, this.roomView(room, client));
    }
  }

  createRoom(client, name) {
    if (client.roomId) this.leaveRoom(client, { reason: "switch_room", silent: true });
    let id = roomCode();
    while (this.rooms.has(id)) id = roomCode();
    const room = {
      id,
      name: cleanText(name, `${client.nickname}的房间`, 18),
      hostId: client.id,
      players: [client.id, null],
      spectators: new Set(),
      health: 14,
      aiVersion: DEFAULT_AI_VERSION,
      ruleIds: [],
      ready: new Set(),
      status: "waiting",
      game: null,
      aiMoveAt: null,
      aiThinking: false,
      aiPondering: false,
      aiPonderJobId: null,
      aiPonderResult: null,
      createdAt: this.now(),
    };
    this.rooms.set(id, room);
    client.roomId = id;
    this.broadcastRoom(room);
    this.broadcastLobby();
    this.notice(client, `房间 ${id} 已创建`, "success");
    return room;
  }

  joinRoom(client, rawId, { asSpectator = false } = {}) {
    const id = cleanText(rawId, "", 8).toUpperCase();
    const room = this.rooms.get(id);
    if (!room) throw new LobbyError("room_not_found", "没有找到这个房间");
    if (client.roomId === id) return room;
    if (client.roomId) this.leaveRoom(client, { reason: "switch_room", silent: true });

    const emptySeat = room.players.findIndex((playerId) => !playerId);
    if (!asSpectator && emptySeat >= 0 && room.status !== "playing") room.players[emptySeat] = client.id;
    else room.spectators.add(client.id);
    client.roomId = id;
    this.broadcastRoom(room);
    this.broadcastLobby();
    return room;
  }

  takeSeat(client) {
    const room = this.requireRoom(client);
    if (room.status === "playing") throw new LobbyError("game_in_progress", "对局进行中，暂时不能入座");
    if (room.players.includes(client.id)) return;
    const emptySeat = room.players.findIndex((id) => !id);
    if (emptySeat < 0) throw new LobbyError("seats_full", "两个玩家席位都有人了");
    room.spectators.delete(client.id);
    room.players[emptySeat] = client.id;
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  addAI(client) {
    const room = this.requireRoom(client);
    if (room.hostId !== client.id) throw new LobbyError("host_only", "只有房主可以添加 AI 玩家");
    if (room.status === "playing") throw new LobbyError("game_in_progress", "对局中不能添加 AI 玩家");
    const emptySeat = room.players.findIndex((id) => !id);
    if (emptySeat < 0) throw new LobbyError("seats_full", "两个玩家席位都有人了");

    const aiId = `ai-${randomUUID()}`;
    const ai = {
      id: aiId,
      nickname: AI_NAMES[Math.floor(this.rng() * AI_NAMES.length)] ?? AI_NAMES[0],
      roomId: room.id,
      transport: null,
      disconnectTimer: null,
      isAI: true,
      aiVersion: room.aiVersion,
    };
    this.clients.set(aiId, ai);
    room.players[emptySeat] = aiId;
    room.ready.add(aiId);
    this.broadcastRoom(room);
    this.broadcastLobby();
    this.notice(client, `${ai.nickname} 已入座`, "success");
  }

  setAIVersion(client, value) {
    const room = this.requireRoom(client);
    if (room.hostId !== client.id) throw new LobbyError("host_only", "只有房主可以选择 AI 版本");
    if (room.status === "playing") throw new LobbyError("game_in_progress", "对局中不能更换 AI 版本");
    const version = String(value ?? "");
    if (normalizeAIVersion(version) !== version) throw new LobbyError("bad_ai_version", "AI 版本必须是 V1、V2 或 V3");
    const hasReadyHuman = [...room.ready].some((id) => !this.clients.get(id)?.isAI);
    if (hasReadyHuman) throw new LobbyError("players_ready", "请先取消准备再更换 AI 版本");
    room.aiVersion = version;
    const aiId = room.players.find((id) => this.clients.get(id)?.isAI);
    if (aiId) this.clients.get(aiId).aiVersion = version;
    this.broadcastRoom(room);
  }

  removeAI(client) {
    const room = this.requireRoom(client);
    if (room.hostId !== client.id) throw new LobbyError("host_only", "只有房主可以移除 AI 玩家");
    if (room.status === "playing") throw new LobbyError("game_in_progress", "对局中不能移除 AI 玩家");
    const seatIndex = room.players.findIndex((id) => this.clients.get(id)?.isAI);
    if (seatIndex < 0) throw new LobbyError("no_ai", "房间里没有 AI 玩家");
    const aiId = room.players[seatIndex];
    room.players[seatIndex] = null;
    room.ready.delete(aiId);
    this.clients.delete(aiId);
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  leaveRoom(client, { reason = "leave", silent = false } = {}) {
    if (!client.roomId) return;
    const room = this.rooms.get(client.roomId);
    client.roomId = null;
    if (!room) return;

    const seatIndex = room.players.indexOf(client.id);
    if (seatIndex >= 0) {
      if (room.status === "playing" && room.game?.status === "playing") {
        const color = colorForPlayer(room.game, client.id);
        if (color) resignGame(room.game, color, { reason, now: this.now() });
        room.status = "finished";
        this.recordFinishedGame(room);
        this.cancelAISearch(room);
        this.broadcastRoom(room);
      }
      room.players[seatIndex] = null;
      room.ready.delete(client.id);
    }
    room.spectators.delete(client.id);

    if (room.hostId === client.id) {
      room.hostId = room.players.find((id) => id && !this.clients.get(id)?.isAI) ?? [...room.spectators][0] ?? null;
    }

    if (!room.hostId) this.destroyRoom(room);
    else this.broadcastRoom(room);
    this.broadcastLobby();
    if (!silent) this.send(client, { type: "left_room" });
  }

  setHealth(client, value) {
    const room = this.requireRoom(client);
    if (room.hostId !== client.id) throw new LobbyError("host_only", "只有房主可以修改血量");
    if (room.status === "playing") throw new LobbyError("game_in_progress", "对局中不能修改血量");
    const hasReadyHuman = [...room.ready].some((id) => !this.clients.get(id)?.isAI);
    if (hasReadyHuman) throw new LobbyError("players_ready", "请先让双方取消准备再修改血量");
    const health = Number(value);
    if (!Number.isInteger(health) || health < 1 || health > 16) {
      throw new LobbyError("bad_health", "血量必须是 1–16 的整数");
    }
    room.health = health;
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  setRule(client, ruleId, enabled) {
    const room = this.requireRoom(client);
    if (room.hostId !== client.id) throw new LobbyError("host_only", "只有房主可以修改规则集");
    if (room.status === "playing") throw new LobbyError("game_in_progress", "对局中不能修改规则集");
    const hasReadyHuman = [...room.ready].some((id) => !this.clients.get(id)?.isAI);
    if (hasReadyHuman) throw new LobbyError("players_ready", "请先取消准备再修改规则集");
    const id = String(ruleId ?? "");
    if (!ruleCatalog().some((rule) => rule.id === id)) throw new LobbyError("bad_rule", "未知扩展规则");
    const next = new Set(room.ruleIds);
    if (enabled) next.add(id);
    else next.delete(id);
    room.ruleIds = normalizeRuleIds([...next]);
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  setReady(client, ready) {
    const room = this.requireRoom(client);
    if (!room.players.includes(client.id)) throw new LobbyError("spectator", "观战者不能准备");
    if (room.status === "playing") throw new LobbyError("game_in_progress", "对局已经开始");
    if (ready) {
      room.ready.add(client.id);
      for (const id of room.players.filter(Boolean)) {
        if (this.clients.get(id)?.isAI) room.ready.add(id);
      }
    }
    else room.ready.delete(client.id);
    this.broadcastRoom(room);

    const players = room.players.filter(Boolean);
    if (players.length === 2 && players.every((id) => room.ready.has(id))) this.startGame(room);
  }

  startGame(room) {
    const playerIds = room.players.filter(Boolean);
    if (playerIds.length !== 2) throw new LobbyError("need_two_players", "需要两名玩家才能开始");
    room.game = createGame({
      playerIds,
      initialHealth: room.health,
      turnDurationMs: this.turnDurationMs,
      rng: this.rng,
      now: this.now(),
      ruleIds: room.ruleIds,
    });
    room.status = "playing";
    room.gameParticipants = Object.fromEntries(COLORS.map((color) => {
      const id = room.game.players[color];
      const player = this.clients.get(id);
      return [color, {
        id,
        nickname: player?.nickname ?? "玩家",
        isAI: Boolean(player?.isAI),
        aiVersion: player?.isAI ? normalizeAIVersion(player.aiVersion ?? room.aiVersion) : null,
      }];
    }));
    room.aiThinking = false;
    room.aiPondering = false;
    room.aiPonderJobId = null;
    room.aiPonderResult = null;
    room.ready.clear();
    this.scheduleAI(room, this.now());
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  performGameAction(client, message) {
    const room = this.requireRoom(client);
    if (!room.game || room.status !== "playing") throw new LobbyError("no_game", "房间还没有开始对局");
    const color = colorForPlayer(room.game, client.id);
    if (!color) throw new LobbyError("spectator", "观战者不能操作棋子");
    const options = { version: message.version, now: this.now() };

    if (message.type === "flip") flipPiece(room.game, color, Number(message.index), options);
    else if (message.type === "move") {
      movePiece(room.game, color, Number(message.from), Number(message.to), options);
    } else if (message.type === "resign") {
      resignGame(room.game, color, { reason: "resign", now: this.now() });
    }

    if (room.game.status === "finished") {
      room.status = "finished";
      this.recordFinishedGame(room);
    }
    const ponderResult = room.game.status === "playing" ? this.harvestAIPonder(room) : null;
    if (room.game.status === "playing") this.scheduleAI(room, this.now(), ponderResult);
    else {
      room.aiMoveAt = null;
      this.cancelAISearch(room);
    }
    this.broadcastRoom(room);
    this.broadcastLobby();
  }

  loadQaScenario(client) {
    if (!this.qaEnabled) throw new LobbyError("qa_disabled", "测试剧本未启用");
    const room = this.requireRoom(client);
    if (!room.game) throw new LobbyError("no_game", "请先开始一局游戏");
    const color = colorForPlayer(room.game, client.id);
    if (!color) throw new LobbyError("spectator", "观战者不能加载测试剧本");
    const enemy = color === "blue" ? "red" : "blue";
    this.cancelAISearch(room);
    const board = Array(32).fill(null);
    board[0] = { ...makePiece("football", color, "qa-football"), revealed: true };
    board[8] = { ...makePiece("cat", enemy, "qa-screen"), revealed: false };
    board[16] = { ...makePiece("elephant", enemy, "qa-target"), revealed: true };
    board[20] = { ...makePiece("elephant", color, "qa-elephant"), revealed: true };
    board[21] = { ...makePiece("mouse", enemy, "qa-mouse"), revealed: true };
    board[25] = { ...makePiece("tiger", enemy, "qa-tiger"), revealed: true };
    board[29] = { ...makePiece("dog", color, "qa-dog"), revealed: true };
    if (room.game.ruleIds.includes("snake")) {
      board[24] = { ...makePiece("snake", color, "qa-snake"), revealed: true };
    }
    if (room.game.ruleIds.includes("football-poison")) {
      board[20].poisoned = true;
      board[20].poisonTurns = 2;
      board[28] = { ...makePiece("football", enemy, "qa-poison-football"), revealed: true };
    }
    room.game.board = board;
    room.game.turn = color;
    room.game.health = { blue: 3, red: 3 };
    const visualCaptureTypes = [
      "mouse", "mouse", "mouse",
      "cat", "cat", "cat",
      "dog", "dog",
      "wolf", "wolf",
      "tiger", "tiger",
      "elephant", "elephant",
      "football", "football",
    ];
    room.game.capturedBy = { blue: [], red: [] };
    room.game.capturedBy[color] = visualCaptureTypes.map((type) => ({ type, color: enemy }));
    room.game.initialHealth = 3;
    room.game.status = "playing";
    room.game.winner = null;
    room.game.loser = null;
    room.game.endReason = null;
    room.game.version += 1;
    room.game.turnDeadline = this.now() + room.game.turnDurationMs;
    room.game.lastAction = { type: "qa_scenario", color, at: this.now() };
    room.game.positionCounts = Object.create(null);
    recordCurrentPosition(room.game);
    resetReplayFrames(room.game);
    room.status = "playing";
    this.scheduleAI(room, this.now());
    this.broadcastRoom(room);
  }

  destroyRoom(room) {
    this.cancelAISearch(room);
    for (const id of room.players.filter(Boolean)) {
      if (this.clients.get(id)?.isAI) this.clients.delete(id);
    }
    this.rooms.delete(room.id);
  }

  scheduleAI(room, now = this.now(), ponderResult = null) {
    this.cancelAISearch(room);
    room.aiMoveAt = null;
    room.aiThinking = false;
    if (room.status !== "playing" || room.game?.status !== "playing") return;
    const playerId = room.game.players[room.game.turn];
    if (this.clients.get(playerId)?.isAI) {
      room.aiPonderResult = ponderResult;
      const spread = this.aiThinkMaxMs - this.aiThinkMinMs;
      room.aiMoveAt = now + this.aiThinkMinMs + Math.floor(this.rng() * (spread + 1));
      return;
    }
    this.startAIPonder(room, now);
  }

  cancelAISearch(room) {
    const job = room ? this.aiSearches.get(room.id) : null;
    if (job) {
      this.aiSearches.delete(room.id);
      this.aiScheduler?.cancel(job.jobId);
    }
    if (room?.aiPonderJobId) this.aiScheduler?.cancel(room.aiPonderJobId);
    if (room) {
      room.aiThinking = false;
      room.aiPondering = false;
      room.aiPonderJobId = null;
      room.aiPonderResult = null;
    }
  }

  startAIPonder(room, now = this.now()) {
    if (this.aiSearchTimeMs <= 25 || room.status !== "playing" || room.game?.status !== "playing") return false;
    const aiId = room.players.find((id) => this.clients.get(id)?.isAI);
    if (!aiId) return false;
    const aiColor = colorForPlayer(room.game, aiId);
    if (!aiColor || room.game.turn === aiColor) return false;
    const scheduler = this.ensureAIScheduler();
    const jobId = `ponder:${room.id}:${room.game.version}:${room.game.turn}`;
    const publicState = publicStateForAI(room.game);
    const remainingTurnMs = Math.max(1_000, room.game.turnDeadline - now + 1_000);
    const seed = Math.floor(this.rng() * 0xffff_ffff) ^ room.game.version ^ 0x51f15e;
    room.aiPondering = true;
    room.aiPonderJobId = jobId;
    scheduler.submit({
      id: jobId,
      publicState,
      color: aiColor,
      mode: "ponder",
      wallTimeMs: remainingTurnMs,
      seed,
      aiVersion: room.aiVersion,
    }).then(() => {
      if (room.aiPonderJobId !== jobId) return;
      room.aiPonderJobId = null;
      room.aiPondering = false;
      this.broadcastRoom(room);
    }).catch(() => {});
    return true;
  }

  harvestAIPonder(room) {
    const jobId = room?.aiPonderJobId;
    if (!jobId || !room.game) return null;
    room.aiPonderJobId = null;
    room.aiPondering = false;
    return this.aiScheduler?.harvest(jobId, publicStateForAI(room.game)) ?? null;
  }

  ensureAIScheduler() {
    if (!this.aiScheduler) {
      this.aiScheduler = new AISearchScheduler({
        workerCount: this.aiWorkerCount,
        quantumMs: this.aiQuantumMs,
      });
    }
    return this.aiScheduler;
  }

  applyAIResult(room, expectedVersion, color, result) {
    const game = room?.game;
    if (
      room?.status !== "playing" ||
      game?.status !== "playing" ||
      game.version !== expectedVersion ||
      game.turn !== color ||
      !this.clients.get(game.players[color])?.isAI
    ) return false;

    let action = result?.action;
    const legal = legalActionsFor(game, color).all;
    const matches = (candidate) => candidate && legal.some((entry) => (
      entry.type === candidate.type &&
      (entry.type === "flip" ? entry.index === candidate.index : entry.from === candidate.from && entry.to === candidate.to)
    ));
    if (!matches(action)) action = legal[0] ?? null;
    if (!action) {
      room.aiThinking = false;
      room.aiMoveAt = null;
      return false;
    }

    const now = this.now();
    const options = { version: game.version, now };
    if (action.type === "flip") flipPiece(game, color, action.index, options);
    else movePiece(game, color, action.from, action.to, options);
    game.lastAction.isAI = true;
    game.lastAction.ai = {
      version: normalizeAIVersion(result?.aiVersion ?? room.aiVersion),
      method: result?.method ?? "fallback",
      elapsedMs: Math.round(result?.elapsedMs ?? 0),
      iterations: result?.iterations ?? null,
      depth: result?.completedDepth ?? null,
      score: Number.isFinite(result?.score) ? Number(result.score.toFixed(3)) : null,
      threads: result?.threads ?? null,
      quanta: result?.quanta ?? null,
      ponderIterations: result?.ponderIterations ?? null,
    };
    refreshLatestReplayFrame(game);
    room.aiThinking = false;

    if (game.status === "finished") {
      room.status = "finished";
      this.recordFinishedGame(room);
      room.aiMoveAt = null;
      this.broadcastLobby();
    } else {
      this.scheduleAI(room, now);
    }
    this.broadcastRoom(room);
    return true;
  }

  performAIAction(room, now = this.now()) {
    const game = room.game;
    if (room.status !== "playing" || game?.status !== "playing") return false;
    const color = game.turn;
    const aiId = game.players[color];
    if (!this.clients.get(aiId)?.isAI) return false;
    const expectedVersion = game.version;
    const publicState = publicStateForAI(game);
    const seed = Math.floor(this.rng() * 0xffff_ffff) ^ expectedVersion;
    const initialResult = room.aiPonderResult;
    room.aiPonderResult = null;
    room.aiMoveAt = null;
    room.aiThinking = true;

    if (this.aiSearchTimeMs <= 25) {
      const result = chooseVersionedAIAction(publicState, color, {
        timeLimitMs: this.aiSearchTimeMs,
        maxIterations: 96,
        seed,
        aiVersion: room.aiVersion,
      });
      return this.applyAIResult(room, expectedVersion, color, result);
    }

    const scheduler = this.ensureAIScheduler();
    const jobId = `${room.id}:${expectedVersion}:${color}`;
    this.aiSearches.set(room.id, { jobId, expectedVersion, color });
    scheduler.submit({
      id: jobId,
      publicState,
      color,
      timeLimitMs: this.aiSearchTimeMs,
      seed,
      initialResult,
      aiVersion: room.aiVersion,
    }).then((result) => {
      const job = this.aiSearches.get(room.id);
      if (!job || job.jobId !== jobId) return;
      this.aiSearches.delete(room.id);
      room.aiThinking = false;
      const fallback = () => chooseVersionedAIAction(publicState, color, {
        timeLimitMs: 20,
        maxIterations: 64,
        seed,
        aiVersion: room.aiVersion,
      });
      this.applyAIResult(room, expectedVersion, color, result ?? fallback());
    }).catch(() => {
      const job = this.aiSearches.get(room.id);
      if (!job || job.jobId !== jobId) return;
      this.aiSearches.delete(room.id);
      room.aiThinking = false;
      this.applyAIResult(room, expectedVersion, color, chooseVersionedAIAction(publicState, color, {
        timeLimitMs: 20,
        maxIterations: 64,
        seed,
        aiVersion: room.aiVersion,
      }));
    });
    this.broadcastRoom(room);
    return true;
  }

  tick(now = this.now()) {
    for (const room of this.rooms.values()) {
      if (room.status !== "playing" || !room.game) continue;
      if (processTurnTimeout(room.game, now)) {
        this.cancelAISearch(room);
        if (room.game.status === "finished") {
          room.status = "finished";
          this.recordFinishedGame(room);
          this.broadcastLobby();
        } else {
          this.scheduleAI(room, now);
        }
        this.broadcastRoom(room);
      }
      if (!room.aiThinking && room.aiMoveAt !== null && now >= room.aiMoveAt) this.performAIAction(room, now);
    }
  }

  close() {
    for (const room of this.rooms.values()) this.cancelAISearch(room);
    const scheduler = this.aiScheduler;
    this.aiScheduler = null;
    return scheduler?.close();
  }

  requireRoom(client) {
    const room = client.roomId ? this.rooms.get(client.roomId) : null;
    if (!room) throw new LobbyError("not_in_room", "请先进入一个房间");
    return room;
  }

  handle(client, message) {
    try {
      if (!message || typeof message.type !== "string") {
        throw new LobbyError("bad_message", "消息格式无效");
      }
      switch (message.type) {
        case "set_nickname":
          client.nickname = cleanText(message.nickname, client.nickname, 12);
          if (client.roomId) this.broadcastRoom(this.rooms.get(client.roomId));
          this.broadcastLobby();
          break;
        case "create_room":
          this.createRoom(client, message.name);
          break;
        case "join_room":
          this.joinRoom(client, message.roomId, { asSpectator: Boolean(message.asSpectator) });
          break;
        case "leave_room":
          this.leaveRoom(client);
          break;
        case "take_seat":
          this.takeSeat(client);
          break;
        case "add_ai":
          this.addAI(client);
          break;
        case "remove_ai":
          this.removeAI(client);
          break;
        case "set_ai_version":
          this.setAIVersion(client, message.version);
          break;
        case "set_health":
          this.setHealth(client, message.value);
          break;
        case "set_rule":
          this.setRule(client, message.ruleId, Boolean(message.enabled));
          break;
        case "set_ready":
          this.setReady(client, Boolean(message.ready));
          break;
        case "flip":
        case "move":
        case "resign":
          this.performGameAction(client, message);
          break;
        case "qa_scenario":
          this.loadQaScenario(client);
          break;
        case "history_list":
          this.sendHistoryList(client);
          break;
        case "history_get":
          this.sendHistoryRecord(client, message.id);
          break;
        case "ping":
          this.send(client, { type: "pong", clientNow: message.clientNow, serverNow: this.now() });
          break;
        default:
          throw new LobbyError("unknown_message", "未知操作");
      }
    } catch (error) {
      this.fail(client, error);
    }
  }
}
