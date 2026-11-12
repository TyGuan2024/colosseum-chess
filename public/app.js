import { groupCapturedPieces } from "./captured.mjs";
import { createSessionId } from "./uuid.mjs";

const PIECE_NAMES = {
  elephant: "大象",
  tiger: "老虎",
  wolf: "狼",
  dog: "狗",
  cat: "猫",
  snake: "蛇",
  mouse: "老鼠",
  football: "足球",
};

const PIECE_RANKS = { elephant: 6, tiger: 5, wolf: 4, dog: 3, cat: 2, snake: 2, mouse: 1 };

const END_REASONS = {
  health: "对方血条空了。",
  poison: "对方最后一格血被毒素扣除。",
  resign: "对方认输了。",
  leave: "对方离开了对局。",
  switch_room: "对方离开了对局。",
  disconnect: "对方断线超时。",
};

const ACTION_TEXT = {
  start: "棋局开始",
  timeout: "超时，交换回合",
  resign: "玩家认输",
  disconnect: "玩家断线超时",
  leave: "玩家离开对局",
  qa_scenario: "已载入规则测试棋局",
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  shell: $("#game-shell"),
  board: $("#board"),
  lobby: $("#lobby-screen"),
  roomScreen: $("#room-screen"),
  endScreen: $("#end-screen"),
  roomList: $("#room-list"),
  roomCount: $("#room-count"),
  nickname: $("#nickname-input"),
  roomName: $("#room-name-input"),
  roomCodeInput: $("#room-code-input"),
  currentRoomName: $("#current-room-name"),
  copyCode: $("#copy-code-button"),
  seatZero: $("#seat-zero"),
  seatOne: $("#seat-one"),
  healthValue: $("#health-value"),
  healthMinus: $("#health-minus"),
  healthPlus: $("#health-plus"),
  spectatorLine: $("#spectator-line"),
  roomHelp: $("#room-help"),
  takeSeat: $("#take-seat-button"),
  aiPlayer: $("#ai-player-button"),
  aiVersionSetting: $("#ai-version-setting"),
  aiVersionDescription: $("#ai-version-description"),
  aiVersionButtons: [...document.querySelectorAll("[data-ai-version]")],
  ruleSetSetting: $("#rule-set-setting"),
  ruleSetOptions: $("#rule-set-options"),
  ready: $("#ready-button"),
  qa: $("#qa-button"),
  qaGame: $("#qa-game-button"),
  bluePlayer: $("#blue-player"),
  redPlayer: $("#red-player"),
  timer: $("#timer-number"),
  turnClock: $("#turn-clock"),
  turnBanner: $("#turn-banner"),
  blueFill: $("#blue-health-fill"),
  redFill: $("#red-health-fill"),
  blueHealth: $("#blue-health-label"),
  redHealth: $("#red-health-label"),
  capturedBlue: $("#captured-blue-pieces"),
  capturedRed: $("#captured-red-pieces"),
  capturedBlueCount: $("#captured-blue-count"),
  capturedRedCount: $("#captured-red-count"),
  lastAction: $("#last-action"),
  gameHint: $("#game-hint"),
  connection: $("#connection-pill"),
  onlineNumber: $("#online-number"),
  resign: $("#resign-button"),
  leaveGame: $("#leave-game-button"),
  endTitle: $("#end-title"),
  endReason: $("#end-reason"),
  rematch: $("#rematch-button"),
  toast: $("#toast-region"),
  rules: $("#rules-dialog"),
  confirm: $("#confirm-dialog"),
  historyScreen: $("#history-screen"),
  historyList: $("#history-list"),
  replayScreen: $("#replay-screen"),
  replayRoomName: $("#replay-room-name"),
  replayDate: $("#replay-date"),
  replayBluePlayer: $("#replay-blue-player"),
  replayRedPlayer: $("#replay-red-player"),
  replayBlueHealth: $("#replay-blue-health"),
  replayRedHealth: $("#replay-red-health"),
  replayBoard: $("#replay-board"),
  replayAction: $("#replay-action"),
  replayStepLabel: $("#replay-step-label"),
  replayProgress: $("#replay-progress"),
  replayPlay: $("#replay-play-button"),
  replayPrevious: $("#replay-previous-button"),
  replayNext: $("#replay-next-button"),
  replayInterval: $("#replay-interval"),
  replayIntervalLabel: $("#replay-interval-label"),
};

const savedSession = sessionStorage.getItem("jungle-session");
const savedNickname = localStorage.getItem("jungle-nickname") || `森林勇士${Math.floor(Math.random() * 90 + 10)}`;

const state = {
  socket: null,
  connected: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  sessionId: savedSession || createSessionId(),
  nickname: savedNickname,
  rooms: [],
  room: null,
  selected: null,
  clockOffset: 0,
  lastVersion: null,
  qaEnabled: false,
  pendingAnimation: null,
  lastTimerSecond: null,
  historyOpen: false,
  historyRecords: [],
  replay: null,
  replayIndex: 0,
  replayIntervalMs: 1_000,
  replayTimer: null,
  replayPlaying: false,
  lastRenderedReplayIndex: null,
};

sessionStorage.setItem("jungle-session", state.sessionId);
localStorage.setItem("jungle-nickname", state.nickname);
elements.nickname.value = state.nickname;

function updateClock(serverNow) {
  if (Number.isFinite(serverNow)) state.clockOffset = serverNow - Date.now();
}

function serverNow() {
  return Date.now() + state.clockOffset;
}

function send(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    toast("还没有连接到服务器，请稍等", "error");
    return false;
  }
  state.socket.send(JSON.stringify(payload));
  return true;
}

function aiVersionLabel(player) {
  return player?.aiVersion ? `AI ${player.aiVersion.toUpperCase()}` : "AI";
}

function connect() {
  clearTimeout(state.reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  setConnection("connecting");

  socket.addEventListener("open", () => {
    state.connected = true;
    state.reconnectAttempt = 0;
    setConnection("connected");
    send({ type: "hello", sessionId: state.sessionId, nickname: state.nickname });
  });

  socket.addEventListener("message", (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      console.error("无法处理服务器消息", error);
    }
  });

  socket.addEventListener("close", () => {
    if (socket !== state.socket) return;
    state.connected = false;
    setConnection("disconnected");
    scheduleReconnect();
  });

  socket.addEventListener("error", () => socket.close());
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(5_000, 500 * 2 ** state.reconnectAttempt);
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(connect, delay);
}

function setConnection(status) {
  elements.connection.className = `connection-pill ${status}`;
  const label = status === "connected" ? "已连接" : status === "disconnected" ? "正在重连" : "连接中";
  elements.connection.replaceChildren(document.createElement("i"), document.createTextNode(label));
  if (status === "disconnected") elements.gameHint.textContent = "连接中断，正在保留你的座位并自动重连…";
  else if (status === "connected") renderStatus();
}

function handleMessage(message) {
  if (message.serverNow) updateClock(message.serverNow);
  switch (message.type) {
    case "welcome":
      state.sessionId = message.sessionId;
      state.nickname = message.nickname;
      state.qaEnabled = Boolean(message.qaEnabled);
      if (!message.reconnected) {
        state.room = null;
        state.selected = null;
      }
      sessionStorage.setItem("jungle-session", state.sessionId);
      localStorage.setItem("jungle-nickname", state.nickname);
      elements.nickname.value = state.nickname;
      render();
      break;
    case "lobby":
      state.rooms = message.rooms || [];
      renderLobby();
      renderStatus();
      break;
    case "room": {
      const previousVersion = state.room?.game?.version;
      const nextVersion = message.room?.game?.version;
      if (nextVersion !== previousVersion) {
        const action = message.room?.game?.lastAction;
        state.pendingAnimation = ["flip", "move", "capture", "push"].includes(action?.type) || action?.poisonDeaths?.length
          ? { ...action }
          : null;
      }
      state.room = message.room;
      updateClock(message.room?.serverNow);
      if (nextVersion !== previousVersion) state.selected = null;
      render();
      break;
    }
    case "left_room":
      state.room = null;
      state.selected = null;
      render();
      break;
    case "notice":
      toast(message.message, message.tone || "info");
      break;
    case "error":
      toast(message.message, "error");
      if (message.code === "stale_version") state.selected = null;
      renderBoard();
      break;
    case "history_list":
      state.historyRecords = message.records || [];
      state.historyOpen = true;
      render();
      break;
    case "history_record":
      stopReplay();
      state.historyOpen = true;
      state.replay = message.record || null;
      state.replayIndex = 0;
      state.lastRenderedReplayIndex = null;
      render();
      break;
    case "pong":
      updateClock(message.serverNow);
      break;
    default:
      break;
  }
}

function render() {
  const room = state.room;
  const game = room?.game;
  elements.lobby.hidden = Boolean(room) || state.historyOpen;
  elements.historyScreen.hidden = !state.historyOpen || Boolean(state.replay);
  elements.replayScreen.hidden = !state.replay;
  elements.roomScreen.hidden = !room || Boolean(game);
  elements.endScreen.hidden = !game || game.status !== "finished";
  elements.resign.hidden = !game || game.status !== "playing" || !game.youColor;
  const qaAvailable = state.qaEnabled || room?.qaEnabled || ["localhost", "127.0.0.1"].includes(location.hostname);
  elements.qaGame.hidden = !game || !qaAvailable || !game.youColor;
  elements.leaveGame.hidden = !room;

  renderLobby();
  renderRoom();
  renderPlayers();
  renderCaptured();
  renderBoard();
  renderHealth();
  renderTimer();
  renderEnd();
  renderStatus();
  renderHistory();
  renderReplay();
}

function formatHistoryDate(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function historyPlayer(record, color) {
  return record.players?.find((player) => player.color === color) || { nickname: color === "blue" ? "蓝方" : "红方" };
}

function renderHistory() {
  if (!state.historyOpen || state.replay) return;
  elements.historyList.replaceChildren();
  if (!state.historyRecords.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.innerHTML = "<span>▣</span><strong>还没有历史对局</strong><small>完成一局后会自动保存在这里</small>";
    elements.historyList.append(empty);
    return;
  }

  for (const record of state.historyRecords) {
    const blue = historyPlayer(record, "blue");
    const red = historyPlayer(record, "red");
    const winner = historyPlayer(record, record.winner);
    const card = document.createElement("article");
    card.className = "history-item";
    const title = document.createElement("div");
    title.className = "history-item-title";
    const name = document.createElement("strong");
    name.textContent = record.roomName || "斗兽棋对局";
    const date = document.createElement("time");
    date.textContent = formatHistoryDate(record.endedAt);
    title.append(name, date);

    const matchup = document.createElement("div");
    matchup.className = "history-matchup";
    matchup.innerHTML = `<span class="blue-name"></span><b>VS</b><span class="red-name"></span>`;
    matchup.querySelector(".blue-name").textContent = `${blue.nickname}${blue.isAI ? ` · ${aiVersionLabel(blue)}` : ""}`;
    matchup.querySelector(".red-name").textContent = `${red.nickname}${red.isAI ? ` · ${aiVersionLabel(red)}` : ""}`;

    const footer = document.createElement("div");
    footer.className = "history-item-footer";
    const result = document.createElement("span");
    result.textContent = `${winner.nickname} 获胜 · ${record.stepCount} 步`;
    if (record.ruleIds?.length) result.textContent += ` · ${record.ruleIds.length} 条扩展规则`;
    const replay = document.createElement("button");
    replay.type = "button";
    replay.className = "history-replay-button";
    replay.textContent = "回放";
    replay.setAttribute("aria-label", `回放：${record.roomName || "斗兽棋对局"}，${blue.nickname} 对 ${red.nickname}`);
    replay.addEventListener("click", () => send({ type: "history_get", id: record.id }));
    footer.append(result, replay);
    card.append(title, matchup, footer);
    elements.historyList.append(card);
  }
}

function replayFrame() {
  return state.replay?.frames?.[state.replayIndex] || null;
}

function renderReplayBoard(frame, animate) {
  elements.replayBoard.replaceChildren();
  const action = frame?.action;
  (frame?.board || []).forEach((piece, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "board-cell";
    cell.disabled = true;
    cell.setAttribute("role", "gridcell");
    const row = Math.floor(index / 4);
    const col = index % 4;
    cell.classList.add((row + col) % 2 === 0 ? "light-square" : "dark-square");
    if (piece) {
      const tile = document.createElement("span");
      tile.className = "piece-tile";
      const image = document.createElement("img");
      image.draggable = false;
      if (piece.hidden) {
        tile.classList.add("hidden-tile");
        image.src = "/pieces/hidden.svg";
        image.alt = "未翻开的棋子";
      } else {
        tile.classList.add(`${piece.color}-tile`, "revealed-tile");
        image.src = `/pieces/${piece.type}.svg`;
        image.alt = `${piece.color === "blue" ? "蓝方" : "红方"}${PIECE_NAMES[piece.type]}`;
        if (piece.poisoned) {
          tile.classList.add("poisoned-tile");
          const poison = document.createElement("span");
          poison.className = "poison-counter";
          poison.textContent = String(piece.poisonTurns ?? 3);
          tile.append(poison);
        }
      }
      tile.append(image);
      if (animate && action?.type === "flip" && action.index === index) tile.classList.add("just-flipped");
      if (animate && ["move", "capture"].includes(action?.type) && action.to === index) {
        const fromRow = Math.floor(action.from / 4);
        const fromCol = action.from % 4;
        tile.style.setProperty("--move-x", `${(fromCol - col) * 120}%`);
        tile.style.setProperty("--move-y", `${(fromRow - row) * 120}%`);
        tile.classList.add(action.type === "capture" ? "just-captured" : "just-moved");
      }
      if (animate && action?.type === "push" && action.pushedTo === index) {
        const pushedFromRow = Math.floor(action.to / 4);
        const pushedFromCol = action.to % 4;
        tile.style.setProperty("--move-x", `${(pushedFromCol - col) * 120}%`);
        tile.style.setProperty("--move-y", `${(pushedFromRow - row) * 120}%`);
        tile.classList.add("just-pushed");
      }
      if (animate && action?.type === "push" && action.from === index) {
        const targetRow = Math.floor(action.to / 4);
        const targetCol = action.to % 4;
        tile.style.setProperty("--strike-x", `${(targetCol - col) * 34}%`);
        tile.style.setProperty("--strike-y", `${(targetRow - row) * 34}%`);
        tile.classList.add("snake-strike");
      }
      cell.append(tile);
    } else {
      cell.classList.add("empty-cell");
    }
    elements.replayBoard.append(cell);
  });
}

function renderReplay() {
  const record = state.replay;
  if (!record) return;
  const frames = record.frames || [];
  const frame = replayFrame();
  if (!frame) return;
  const blue = historyPlayer(record, "blue");
  const red = historyPlayer(record, "red");
  elements.replayRoomName.textContent = record.roomName || "对局回放";
  elements.replayDate.textContent = formatHistoryDate(record.endedAt);
  elements.replayBluePlayer.textContent = `${blue.nickname}${blue.isAI ? ` · ${aiVersionLabel(blue)}` : ""}`;
  elements.replayRedPlayer.textContent = `${red.nickname}${red.isAI ? ` · ${aiVersionLabel(red)}` : ""}`;
  elements.replayBlueHealth.textContent = `${frame.health.blue}/${record.initialHealth}`;
  elements.replayRedHealth.textContent = `${frame.health.red}/${record.initialHealth}`;
  elements.replayAction.textContent = describeAction(frame.action) || "棋局开始";
  elements.replayStepLabel.textContent = `${state.replayIndex} / ${Math.max(0, frames.length - 1)}`;
  elements.replayProgress.max = String(Math.max(0, frames.length - 1));
  elements.replayProgress.value = String(state.replayIndex);
  elements.replayPrevious.disabled = state.replayIndex <= 0;
  elements.replayNext.disabled = state.replayIndex >= frames.length - 1;
  elements.replayPlay.textContent = state.replayPlaying ? "暂停" : state.replayIndex >= frames.length - 1 ? "重新播放" : "播放";
  const animate = state.lastRenderedReplayIndex !== state.replayIndex;
  renderReplayBoard(frame, animate);
  state.lastRenderedReplayIndex = state.replayIndex;
}

function stopReplay() {
  clearInterval(state.replayTimer);
  state.replayTimer = null;
  state.replayPlaying = false;
}

function setReplayIndex(index) {
  const last = Math.max(0, (state.replay?.frames?.length ?? 1) - 1);
  state.replayIndex = Math.max(0, Math.min(last, Number(index) || 0));
  if (state.replayIndex >= last) stopReplay();
  renderReplay();
}

function startReplay() {
  if (!state.replay?.frames?.length) return;
  if (state.replayIndex >= state.replay.frames.length - 1) state.replayIndex = 0;
  stopReplay();
  state.replayPlaying = true;
  state.replayTimer = setInterval(() => setReplayIndex(state.replayIndex + 1), state.replayIntervalMs);
  renderReplay();
}

function renderLobby() {
  elements.roomCount.textContent = `${state.rooms.length} 个房间`;
  const visiblePlayers = state.rooms.reduce((sum, room) => sum + room.players + room.spectators, 0);
  elements.onlineNumber.textContent = String(Math.max(1, visiblePlayers));
  elements.roomList.replaceChildren();

  if (!state.rooms.length) {
    const empty = document.createElement("div");
    empty.className = "empty-rooms";
    empty.innerHTML = "<span>♟</span><strong>还没有房间</strong><small>创建第一场对局吧</small>";
    elements.roomList.append(empty);
    return;
  }

  for (const room of state.rooms) {
    const card = document.createElement("article");
    card.className = "room-list-item";
    const statusText = room.status === "playing" ? "对局中" : room.status === "finished" ? "待重赛" : "等待中";
    const statusClass = room.status === "playing" ? "busy" : "open";

    const info = document.createElement("span");
    info.className = "room-list-info";
    const title = document.createElement("strong");
    title.textContent = room.name;
    const detail = document.createElement("small");
    const ruleText = room.ruleIds?.length ? ` · ${room.ruleIds.length} 条扩展规则` : "";
    detail.textContent = `${room.hostName} · ${room.health} 格血${ruleText} · ${room.spectators} 人观战`;
    info.append(title, detail);

    const meta = document.createElement("span");
    meta.className = "room-list-meta";
    const badge = document.createElement("i");
    badge.className = statusClass;
    badge.textContent = statusText;
    const count = document.createElement("b");
    count.textContent = `${room.players}/2`;
    meta.append(badge, count);

    const actions = document.createElement("span");
    actions.className = "room-list-actions";
    if (room.status !== "playing" && room.players < room.capacity) {
      const joinButton = document.createElement("button");
      joinButton.type = "button";
      joinButton.className = "room-join-button";
      joinButton.textContent = "加入";
      joinButton.setAttribute("aria-label", `加入对局：${room.name}`);
      joinButton.addEventListener("click", () => send({ type: "join_room", roomId: room.id }));
      actions.append(joinButton);
    }
    const watchButton = document.createElement("button");
    watchButton.type = "button";
    watchButton.className = "room-watch-button";
    watchButton.textContent = "观战";
    watchButton.setAttribute("aria-label", `观战：${room.name}`);
    watchButton.addEventListener("click", () => send({ type: "join_room", roomId: room.id, asSpectator: true }));
    actions.append(watchButton);

    card.append(info, meta, actions);
    elements.roomList.append(card);
  }
}

function seatContent(seat, color) {
  const fragment = document.createDocumentFragment();
  const avatar = document.createElement("img");
  avatar.src = seat?.isAI ? "/pieces/wolf.svg" : color === "blue" ? "/pieces/tiger.svg" : "/pieces/dog.svg";
  avatar.alt = "";
  const copy = document.createElement("div");
  const name = document.createElement("strong");
  const status = document.createElement("small");
  if (seat) {
    name.textContent = seat.nickname;
    status.textContent = seat.isAI ? `${aiVersionLabel(seat)} 已就绪` : seat.connected ? (seat.ready ? "已准备" : "等待确认") : "断线重连中";
  } else {
    name.textContent = "等待玩家";
    status.textContent = "席位空闲";
  }
  copy.append(name);
  if (seat?.isAI) {
    const aiBadge = document.createElement("em");
    aiBadge.className = "ai-badge";
    aiBadge.textContent = aiVersionLabel(seat);
    copy.append(aiBadge);
  }
  copy.append(status);
  const badge = document.createElement("span");
  badge.className = seat?.ready ? "ready-badge is-ready" : "ready-badge";
  badge.textContent = seat?.ready ? "READY" : "WAIT";
  fragment.append(avatar, copy, badge);
  return fragment;
}

function renderRoom() {
  const room = state.room;
  if (!room) return;
  elements.currentRoomName.textContent = room.name;
  elements.copyCode.textContent = room.id;
  elements.seatZero.replaceChildren(seatContent(room.players[0], "blue"));
  elements.seatOne.replaceChildren(seatContent(room.players[1], "red"));
  elements.healthValue.value = String(room.health);
  elements.healthValue.textContent = String(room.health);

  const settingsLocked = !room.isHost || room.players.some((player) => player?.ready && !player?.isAI);
  elements.healthMinus.disabled = settingsLocked || room.health <= 1;
  elements.healthPlus.disabled = settingsLocked || room.health >= 16;
  elements.aiVersionSetting.hidden = room.status === "playing";
  elements.aiVersionSetting.disabled = settingsLocked;
  for (const button of elements.aiVersionButtons) {
    const selected = button.dataset.aiVersion === room.aiVersion;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = settingsLocked;
  }
  elements.aiVersionDescription.textContent = {
    v1: "经典版使用信息集搜索，残局使用 alpha-beta 搜索。",
    v2: "根据剩余暗子的概率推演，并搜索连续吃子的应对。",
    v3: "使用自我对弈训练的策略评估走法，模拟双方应对后落子。",
  }[room.aiVersion];
  elements.ruleSetSetting.disabled = settingsLocked || room.status === "playing";
  elements.ruleSetOptions.replaceChildren();
  for (const rule of room.availableRules ?? []) {
    const enabled = (room.ruleIds ?? []).includes(rule.id);
    const label = document.createElement("label");
    label.className = `rule-toggle${enabled ? " is-enabled" : ""}`;
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = rule.name;
    const description = document.createElement("small");
    description.textContent = rule.description;
    copy.append(title, description);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.disabled = settingsLocked || room.status === "playing";
    input.setAttribute("aria-label", `启用${rule.name}`);
    input.addEventListener("change", () => send({ type: "set_rule", ruleId: rule.id, enabled: input.checked }));
    const switcher = document.createElement("i");
    switcher.setAttribute("aria-hidden", "true");
    label.append(copy, input, switcher);
    elements.ruleSetOptions.append(label);
  }
  elements.takeSeat.hidden = room.role !== "spectator" || !room.players.some((player) => !player);
  const aiPlayer = room.players.find((player) => player?.isAI);
  const hasEmptySeat = room.players.some((player) => !player);
  elements.aiPlayer.hidden = !room.isHost || room.status === "playing" || (!aiPlayer && !hasEmptySeat);
  elements.aiPlayer.textContent = aiPlayer ? "移除 AI 玩家" : "添加 AI 玩家";
  elements.aiPlayer.dataset.action = aiPlayer ? "remove" : "add";
  elements.ready.hidden = room.role !== "player";
  elements.ready.textContent = room.ready ? "取消准备" : "确认准备";
  elements.ready.classList.toggle("is-ready", room.ready);
  elements.qa.hidden = !room.qaEnabled || !room.game;
  if (room.spectators.length) {
    const shownNames = room.spectators.slice(0, 4).map((person) => person.nickname).join("、");
    const remaining = room.spectators.length - 4;
    elements.spectatorLine.textContent = `👀 ${shownNames}${remaining > 0 ? ` 等 ${room.spectators.length} 人` : ""}正在观战`;
  } else {
    elements.spectatorLine.textContent = "👀 暂无观战者";
  }
  elements.roomHelp.textContent = room.players.filter(Boolean).length < 2
    ? "邀请朋友入座，或添加 AI 立即开局。"
    : "双方点击确认准备后，系统会随机分配阵营并立即开局。";
}

function playerForColor(color) {
  return state.room?.players.find((player) => player?.color === color) || null;
}

function updatePlayerCard(element, color, player, game) {
  const name = element.querySelector(".player-name");
  const status = element.querySelector(".player-state");
  name.textContent = player?.nickname || `等待${color === "blue" ? "蓝" : "红"}方`;
  const meBadge = element.querySelector(".me-badge");
  meBadge.hidden = !game || game.youColor !== color;
  if (!player) status.textContent = "未入座";
  else if (player.isAI && game?.status === "playing" && game.turn === color) status.textContent = player.aiThinking ? `${aiVersionLabel(player)} 深度搜索中` : `${aiVersionLabel(player)} 准备计算`;
  else if (player.isAI) status.textContent = player.aiPondering ? `${aiVersionLabel(player)} 预判中` : `${aiVersionLabel(player)} 玩家`;
  else if (!player.connected) status.textContent = "断线重连中";
  else if (game?.status === "playing" && game.turn === color) status.textContent = "正在行动";
  else if (game?.status === "playing") status.textContent = "等待对方";
  else status.textContent = player.ready ? "已准备" : "在房间中";
  element.classList.toggle("is-turn", game?.status === "playing" && game.turn === color);
  element.classList.toggle("is-you", game?.youColor === color);
  element.classList.toggle("is-ai", Boolean(player?.isAI));
}

function renderPlayers() {
  const room = state.room;
  const game = room?.game;
  const blue = game ? playerForColor("blue") : room?.players[0];
  const red = game ? playerForColor("red") : room?.players[1];
  updatePlayerCard(elements.bluePlayer, "blue", blue, game);
  updatePlayerCard(elements.redPlayer, "red", red, game);
}

function renderCaptured() {
  const game = state.room?.game;
  const capturedBy = game?.capturedBy || { blue: [], red: [] };
  const lists = [
    { color: "blue", root: elements.capturedBlue, count: elements.capturedBlueCount },
    { color: "red", root: elements.capturedRed, count: elements.capturedRedCount },
  ];

  for (const list of lists) {
    const pieces = capturedBy[list.color] || [];
    list.count.textContent = String(pieces.length);
    list.root.replaceChildren();
    const newestType = pieces.at(-1)?.type;
    groupCapturedPieces(pieces).forEach((piece) => {
      const item = document.createElement("div");
      item.className = "captured-item";
      const image = document.createElement("img");
      image.src = `/pieces/${piece.type}.svg`;
      image.alt = `${list.color === "blue" ? "蓝方" : "红方"}吃掉的${PIECE_NAMES[piece.type]}，共${piece.count}枚`;
      image.className = `captured-icon captured-${piece.color}`;
      const multiplier = document.createElement("span");
      multiplier.className = "captured-multiplier";
      multiplier.textContent = `×${piece.count}`;
      item.title = image.alt;
      if (
        state.pendingAnimation?.type === "capture" &&
        state.pendingAnimation.color === list.color &&
        piece.type === newestType
      ) {
        item.classList.add("new-capture");
      }
      item.append(image, multiplier);
      list.root.append(item);
    });
  }
}

function renderBoard() {
  const game = state.room?.game;
  const animation = state.pendingAnimation;
  const board = game?.board || Array.from({ length: 32 }, (_, index) => ({ id: `placeholder-${index}`, hidden: true }));
  elements.board.replaceChildren();

  board.forEach((piece, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "board-cell";
    cell.dataset.index = String(index);
    cell.setAttribute("role", "gridcell");
    const row = Math.floor(index / 4);
    const col = index % 4;
    cell.classList.add((row + col) % 2 === 0 ? "light-square" : "dark-square");

    if (piece) {
      const tile = document.createElement("span");
      tile.className = "piece-tile";
      const image = document.createElement("img");
      image.draggable = false;
      if (piece.hidden) {
        tile.classList.add("hidden-tile");
        image.src = "/pieces/hidden.svg";
        image.alt = "未翻开的棋子";
        cell.setAttribute("aria-label", `第 ${row + 1} 行第 ${col + 1} 列，暗子`);
      } else {
        tile.classList.add(`${piece.color}-tile`, "revealed-tile");
        image.src = `/pieces/${piece.type}.svg`;
        image.alt = `${piece.color === "blue" ? "蓝方" : "红方"}${PIECE_NAMES[piece.type]}`;
        cell.setAttribute("aria-label", image.alt);
        if (piece.color === game?.youColor) cell.classList.add("own-piece");
        if (piece.poisoned) {
          tile.classList.add("poisoned-tile");
          const poison = document.createElement("span");
          poison.className = "poison-counter";
          poison.textContent = String(piece.poisonTurns ?? 3);
          poison.setAttribute("aria-label", `中毒，还剩 ${piece.poisonTurns ?? 3} 回合`);
          tile.append(poison);
        }
      }
      tile.append(image);
      if (animation?.type === "flip" && animation.index === index) {
        tile.classList.add("just-flipped");
        cell.classList.add("flip-cell");
      }
      if (["move", "capture"].includes(animation?.type) && animation.to === index) {
        const fromRow = Math.floor(animation.from / 4);
        const fromCol = animation.from % 4;
        tile.style.setProperty("--move-x", `${(fromCol - col) * 120}%`);
        tile.style.setProperty("--move-y", `${(fromRow - row) * 120}%`);
        tile.classList.add(animation.type === "capture" ? "just-captured" : "just-moved");
        if (animation.type === "capture") cell.classList.add("capture-impact");
      }
      if (animation?.type === "push" && animation.pushedTo === index) {
        const pushedFromRow = Math.floor(animation.to / 4);
        const pushedFromCol = animation.to % 4;
        tile.style.setProperty("--move-x", `${(pushedFromCol - col) * 120}%`);
        tile.style.setProperty("--move-y", `${(pushedFromRow - row) * 120}%`);
        tile.classList.add("just-pushed");
      }
      if (animation?.type === "push" && animation.from === index) {
        const targetRow = Math.floor(animation.to / 4);
        const targetCol = animation.to % 4;
        tile.style.setProperty("--strike-x", `${(targetCol - col) * 34}%`);
        tile.style.setProperty("--strike-y", `${(targetRow - row) * 34}%`);
        tile.classList.add("snake-strike");
      }
      cell.append(tile);
    } else {
      cell.classList.add("empty-cell");
      cell.setAttribute("aria-label", `第 ${row + 1} 行第 ${col + 1} 列，空格`);
    }

    if (state.selected === index) cell.classList.add("selected-cell");
    if (["move", "capture"].includes(animation?.type) && animation.from === index) cell.classList.add("move-origin");
    if (state.selected !== null && isCandidateTarget(game, state.selected, index)) cell.classList.add("candidate-cell");
    const repetitionForbidden = state.selected !== null && isRepetitionForbidden(game, state.selected, index);
    if (repetitionForbidden) {
      cell.classList.add("repetition-forbidden");
      cell.title = "该走法会让同一局面第 4 次出现，必须变招";
    }
    if (animation?.poisonDeaths?.some((death) => death.index === index)) cell.classList.add("poison-death-cell");
    cell.disabled = !game || game.status !== "playing" || state.room?.role !== "player";
    cell.addEventListener("click", () => onCellClick(index));
    elements.board.append(cell);
  });
  state.pendingAnimation = null;
}

function canClientCapture(attackerType, defenderType) {
  if (attackerType === "football") return true;
  if (attackerType === "snake") return defenderType !== "elephant";
  if (defenderType === "football") return attackerType !== "mouse";
  if (attackerType === defenderType) return true;
  if (attackerType === "mouse") return defenderType === "elephant";
  if (attackerType === "elephant" && defenderType === "mouse") return false;
  return (PIECE_RANKS[attackerType] || 0) > (PIECE_RANKS[defenderType] || 0);
}

function isCandidateTarget(game, from, to) {
  if (!game || from === to) return false;
  if (isRepetitionForbidden(game, from, to)) return false;
  const source = game.board[from];
  const target = game.board[to];
  if (!source || source.hidden || source.color !== game.youColor) return false;
  if (target?.hidden || target?.color === source.color) return false;
  const fromRow = Math.floor(from / 4);
  const fromCol = from % 4;
  const toRow = Math.floor(to / 4);
  const toCol = to % 4;
  if (!target) return Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol) === 1;
  if (source.type !== "football") {
    return Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol) === 1 && canClientCapture(source.type, target.type);
  }
  if (fromRow !== toRow && fromCol !== toCol) return false;
  const step = fromRow === toRow ? (to > from ? 1 : -1) : (to > from ? 4 : -4);
  let screens = 0;
  for (let index = from + step; index !== to; index += step) if (game.board[index]) screens += 1;
  return screens === 1;
}

function isRepetitionForbidden(game, from, to) {
  return (game?.repetitionForbiddenMoves || []).some((move) => move.from === from && move.to === to);
}

function onCellClick(index) {
  const game = state.room?.game;
  if (!game || game.status !== "playing") return;
  if (!game.youColor) return toast("你正在观战，不能操作棋子", "info");
  if (game.turn !== game.youColor) return toast("还没轮到你", "error");
  const piece = game.board[index];

  if (state.selected !== null) {
    if (state.selected === index) {
      state.selected = null;
      renderBoard();
      return;
    }
    if (piece && !piece.hidden && piece.color === game.youColor) {
      state.selected = index;
      renderBoard();
      return;
    }
    if (isRepetitionForbidden(game, state.selected, index)) {
      return toast("该走法会让同一局面第 4 次出现，请变招", "error");
    }
    send({ type: "move", from: state.selected, to: index, version: game.version });
    return;
  }

  if (!piece) return toast("先选择一枚自己的棋子", "info");
  if (piece.hidden) {
    send({ type: "flip", index, version: game.version });
    return;
  }
  if (piece.color !== game.youColor) return toast("只能选择自己的棋子", "error");
  state.selected = index;
  renderBoard();
  elements.gameHint.textContent = piece.type === "football"
    ? "选择空邻格移动，或选择隔一枚棋子的敌方明子"
    : piece.type === "snake"
      ? "选择相邻空格，或吓退相邻敌子（大象免疫）"
      : "选择相邻空格或可以吃的敌方棋子";
}

function renderHealth() {
  const game = state.room?.game;
  const initial = game?.initialHealth || state.room?.health || 14;
  const blue = game?.health.blue ?? initial;
  const red = game?.health.red ?? initial;
  elements.blueFill.style.setProperty("--health", `${(blue / initial) * 100}%`);
  elements.redFill.style.setProperty("--health", `${(red / initial) * 100}%`);
  elements.blueHealth.textContent = `${blue}/${initial}`;
  elements.redHealth.textContent = `${red}/${initial}`;
}

function renderTimer() {
  const game = state.room?.game;
  if (!game || game.status !== "playing") {
    elements.timer.textContent = "30";
    elements.turnClock.style.setProperty("--time", "1");
    elements.turnClock.classList.remove("urgent");
    elements.shell.classList.remove("countdown-danger");
    state.lastTimerSecond = null;
    return;
  }
  const remainingMs = Math.max(0, game.turnDeadline - serverNow());
  const seconds = Math.ceil(remainingMs / 1000);
  elements.timer.textContent = String(seconds);
  elements.turnClock.style.setProperty("--time", String(remainingMs / game.turnDurationMs));
  const urgent = seconds <= 5;
  elements.turnClock.classList.toggle("urgent", urgent);
  elements.shell.classList.toggle("countdown-danger", urgent);
  if (urgent && seconds !== state.lastTimerSecond) {
    elements.timer.classList.remove("tick-pop");
    requestAnimationFrame(() => elements.timer.classList.add("tick-pop"));
  } else if (!urgent) {
    elements.timer.classList.remove("tick-pop");
  }
  state.lastTimerSecond = seconds;
}

function describeAction(action) {
  if (!action) return "";
  const actor = action.isAI ? "AI · " : "";
  let text = ACTION_TEXT[action.type] ? actor + ACTION_TEXT[action.type] : "";
  if (action.type === "flip") text = `${actor}翻开了${action.pieceColor === "blue" ? "蓝" : "红"}方${PIECE_NAMES[action.piece]}`;
  if (action.type === "move") text = `${actor}${PIECE_NAMES[action.piece]}移动了一格`;
  if (action.type === "capture") text = `${actor}${PIECE_NAMES[action.piece]}吃掉了${PIECE_NAMES[action.captured]}`;
  if (action.type === "push") text = `${actor}蛇把${PIECE_NAMES[action.pushed]}吓退了一格`;
  if (action.poisoned) text += "，并染上毒素";
  else if (action.cured) text += "，毒素已解除";
  if (action.poisonDeaths?.length) text += `；${action.poisonDeaths.map((death) => PIECE_NAMES[death.type]).join("、")}毒发倒下`;
  return text;
}

function renderStatus() {
  const room = state.room;
  const game = room?.game;
  if (!room) {
    elements.turnBanner.textContent = "等待开局";
    elements.gameHint.textContent = state.connected ? "创建或加入一个房间开始游戏" : "正在连接游戏服务器…";
    elements.lastAction.textContent = "";
    return;
  }
  if (!game) {
    elements.turnBanner.textContent = "等待双方确认";
    elements.gameHint.textContent = "把房间码发给同一局域网里的朋友";
    elements.lastAction.textContent = "";
    return;
  }

  const yourTurn = game.status === "playing" && game.turn === game.youColor;
  if (game.status === "finished") elements.turnBanner.textContent = "本局结束";
  else if (!game.youColor) elements.turnBanner.textContent = `${game.turn === "blue" ? "蓝" : "红"}方回合`;
  else elements.turnBanner.textContent = yourTurn ? "轮到你了" : "轮到对方";
  elements.turnBanner.className = `turn-banner ${game.turn || ""} ${yourTurn ? "your-turn" : ""}`;
  elements.gameHint.textContent = game.status === "finished"
    ? "双方可以确认再来一局"
    : yourTurn
      ? "翻开暗子，或选择自己的明子移动"
      : game.youColor
        ? playerForColor(game.turn)?.isAI
          ? `${aiVersionLabel(playerForColor(game.turn))} 正在并行推演（最长 15 秒）…`
          : "请等待对方操作"
        : "观战中 · 暗子信息已由服务器保护";
  elements.lastAction.textContent = describeAction(game.lastAction);
  const ai = game.lastAction?.ai;
  elements.lastAction.dataset.aiMethod = ai?.method || "";
  elements.lastAction.title = ai
    ? `AI ${(ai.version || "v1").toUpperCase()} · ${ai.method} · ${ai.threads ? `${ai.threads} 线程 · ` : ""}${ai.ponderIterations ? `预判 ${ai.ponderIterations} 次 · ` : ""}${ai.iterations ? `本回合 ${ai.iterations} 次模拟 · ` : ""}${ai.depth ? `深度 ${ai.depth} · ` : ""}${ai.elapsedMs}ms`
    : "";
}

function renderEnd() {
  const room = state.room;
  const game = room?.game;
  if (!game || game.status !== "finished") return;
  const isPlayer = Boolean(game.youColor);
  const won = isPlayer && game.winner === game.youColor;
  elements.endTitle.textContent = isPlayer ? (won ? "你赢了！" : "再接再厉") : `${game.winner === "blue" ? "蓝方" : "红方"}胜利！`;
  elements.endTitle.dataset.result = won ? "win" : isPlayer ? "lose" : "watch";
  let reason = END_REASONS[game.endReason] || "本局已经结束。";
  if (game.loser === game.youColor) {
    if (game.endReason === "resign") reason = "你已认输，本局结束。";
    if (game.endReason === "leave" || game.endReason === "switch_room") reason = "你离开了本局。";
    if (game.endReason === "disconnect") reason = "你的连接超时，本局结束。";
  }
  elements.endReason.textContent = reason;
  elements.rematch.hidden = state.room.role !== "player";
  elements.rematch.textContent = state.room.ready ? "等待对方…" : "再来一局";
  elements.rematch.disabled = state.room.ready;
}

function toast(message, tone = "info") {
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.textContent = message;
  elements.toast.append(item);
  requestAnimationFrame(() => item.classList.add("show"));
  setTimeout(() => {
    item.classList.remove("show");
    setTimeout(() => item.remove(), 220);
  }, 2_600);
}

function changeHealth(delta) {
  const room = state.room;
  if (!room) return;
  send({ type: "set_health", value: Math.max(1, Math.min(16, room.health + delta)) });
}

$("#create-room-form").addEventListener("submit", (event) => {
  event.preventDefault();
  send({ type: "create_room", name: elements.roomName.value });
});

$("#history-button").addEventListener("click", () => {
  state.historyOpen = true;
  state.replay = null;
  render();
  send({ type: "history_list" });
});

$("#history-close-button").addEventListener("click", () => {
  stopReplay();
  state.historyOpen = false;
  state.replay = null;
  render();
});

$("#replay-back-button").addEventListener("click", () => {
  stopReplay();
  state.replay = null;
  state.lastRenderedReplayIndex = null;
  render();
  send({ type: "history_list" });
});

elements.replayPrevious.addEventListener("click", () => {
  stopReplay();
  setReplayIndex(state.replayIndex - 1);
});
elements.replayNext.addEventListener("click", () => {
  stopReplay();
  setReplayIndex(state.replayIndex + 1);
});
elements.replayPlay.addEventListener("click", () => {
  if (state.replayPlaying) {
    stopReplay();
    renderReplay();
  } else {
    startReplay();
  }
});
elements.replayProgress.addEventListener("input", () => {
  stopReplay();
  setReplayIndex(elements.replayProgress.value);
});
elements.replayInterval.addEventListener("input", () => {
  const wasPlaying = state.replayPlaying;
  state.replayIntervalMs = Number(elements.replayInterval.value);
  elements.replayIntervalLabel.textContent = `${(state.replayIntervalMs / 1_000).toFixed(1)} 秒/步`;
  if (wasPlaying) startReplay();
});

$("#join-room-form").addEventListener("submit", (event) => {
  event.preventDefault();
  send({ type: "join_room", roomId: elements.roomCodeInput.value });
});

$("#save-name-button").addEventListener("click", () => {
  const nickname = elements.nickname.value.trim();
  if (!nickname) return toast("请输入昵称", "error");
  state.nickname = nickname.slice(0, 12);
  localStorage.setItem("jungle-nickname", state.nickname);
  send({ type: "set_nickname", nickname: state.nickname });
  toast("昵称已保存", "success");
});

elements.roomCodeInput.addEventListener("input", () => {
  elements.roomCodeInput.value = elements.roomCodeInput.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 5);
});

elements.healthMinus.addEventListener("click", () => changeHealth(-1));
elements.healthPlus.addEventListener("click", () => changeHealth(1));
elements.ready.addEventListener("click", () => send({ type: "set_ready", ready: !state.room?.ready }));
elements.takeSeat.addEventListener("click", () => send({ type: "take_seat" }));
elements.aiPlayer.addEventListener("click", () => {
  send({ type: elements.aiPlayer.dataset.action === "remove" ? "remove_ai" : "add_ai" });
});
for (const button of elements.aiVersionButtons) {
  button.addEventListener("click", () => send({ type: "set_ai_version", version: button.dataset.aiVersion }));
}
elements.qa.addEventListener("click", () => send({ type: "qa_scenario" }));
elements.qaGame.addEventListener("click", () => send({ type: "qa_scenario" }));
$("#spectate-code-button").addEventListener("click", () => {
  send({ type: "join_room", roomId: elements.roomCodeInput.value, asSpectator: true });
});
$("#leave-room-button").addEventListener("click", () => send({ type: "leave_room" }));
elements.leaveGame.addEventListener("click", () => {
  if (state.room?.game?.status === "playing" && state.room.game.youColor) elements.confirm.showModal();
  else send({ type: "leave_room" });
});
elements.resign.addEventListener("click", () => elements.confirm.showModal());
$("#confirm-resign").addEventListener("click", () => send({ type: "resign", version: state.room?.game?.version }));
$("#rules-button").addEventListener("click", () => elements.rules.showModal());
$("#quick-message").addEventListener("click", () => {
  const emojis = ["🐯", "🐘", "⚽", "👏", "加油！"];
  toast(emojis[Math.floor(Math.random() * emojis.length)], "emoji");
});
elements.copyCode.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.room?.id || "");
    toast("房间码已复制", "success");
  } catch {
    toast(`房间码：${state.room?.id}`, "info");
  }
});
elements.rematch.addEventListener("click", () => send({ type: "set_ready", ready: true }));
$("#end-leave-button").addEventListener("click", () => send({ type: "leave_room" }));

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.selected !== null) {
    state.selected = null;
    renderBoard();
  }
});

setInterval(renderTimer, 200);
setInterval(() => {
  if (state.connected) send({ type: "ping", clientNow: Date.now() });
}, 15_000);

render();
connect();
