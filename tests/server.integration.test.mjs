import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGameServer } from "../server/server.mjs";

function socketClient(url, sessionId, nickname) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];

  function dispatch(message) {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }

  socket.addEventListener("message", (event) => dispatch(JSON.parse(event.data)));

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", sessionId, nickname }));
      resolve();
    }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  function waitFor(predicate, timeout = 2_000) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error("等待 WebSocket 消息超时"));
      }, timeout);
      waiters.push(waiter);
    });
  }

  return {
    socket,
    messages,
    opened,
    waitFor,
    send(message) { socket.send(JSON.stringify(message)); },
  };
}

test("HTTP 与两个真实 WebSocket 客户端可完成大厅到首步操作", async (t) => {
  const gameServer = createGameServer({ disconnectGraceMs: 50, turnDurationMs: 2_000 });
  const address = await gameServer.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  t.after(async () => gameServer.close());

  const healthResponse = await fetch(`${base}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ok, true);
  const pageResponse = await fetch(base);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /斗兽棋大厅/);

  const a = socketClient(wsUrl, "integration-a", "测试甲");
  const b = socketClient(wsUrl, "integration-b", "测试乙");
  await Promise.all([a.opened, b.opened]);
  await Promise.all([
    a.waitFor((message) => message.type === "welcome"),
    b.waitFor((message) => message.type === "welcome"),
  ]);

  a.send({ type: "create_room", name: "联机集成测试" });
  const created = await a.waitFor((message) => message.type === "room" && message.room.name === "联机集成测试");
  const roomId = created.room.id;
  b.send({ type: "join_room", roomId });
  await b.waitFor((message) => message.type === "room" && message.room.id === roomId);

  a.send({ type: "set_health", value: 5 });
  await a.waitFor((message) => message.type === "room" && message.room.health === 5);
  a.send({ type: "set_ready", ready: true });
  b.send({ type: "set_ready", ready: true });
  const gameA = await a.waitFor((message) => message.type === "room" && message.room.game?.status === "playing");
  const gameB = await b.waitFor((message) => message.type === "room" && message.room.game?.status === "playing");
  assert.equal(gameA.room.game.board.length, 32);
  assert.equal(gameA.room.game.board.every((piece) => piece.hidden && !piece.type), true);
  assert.equal(gameB.room.game.initialHealth, 5);

  const current = gameA.room.game.youColor === gameA.room.game.turn ? a : b;
  const currentGame = current === a ? gameA.room.game : gameB.room.game;
  current.send({ type: "flip", index: 0, version: currentGame.version });
  const updated = await current.waitFor(
    (message) => message.type === "room" && message.room.game?.version === currentGame.version + 1,
  );
  assert.equal(updated.room.game.board[0].hidden, undefined);
  assert.ok(updated.room.game.board[0].type);

  a.socket.close();
  b.socket.close();
});

test("已结束对局通过 WebSocket 查询并在服务器重启后继续存在", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jungle-server-history-"));
  const historyFile = join(directory, "history.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const firstServer = createGameServer({ historyFile, turnDurationMs: 2_000 });
  t.after(() => firstServer.close());
  const firstAddress = await firstServer.listen({ port: 0, host: "127.0.0.1" });
  const firstUrl = `ws://127.0.0.1:${firstAddress.port}/ws`;
  const blue = socketClient(firstUrl, "history-int-blue", "持久蓝方");
  const red = socketClient(firstUrl, "history-int-red", "持久红方");
  await Promise.all([blue.opened, red.opened]);
  await Promise.all([
    blue.waitFor((message) => message.type === "welcome"),
    red.waitFor((message) => message.type === "welcome"),
  ]);

  blue.send({ type: "create_room", name: "重启保留测试" });
  const created = await blue.waitFor((message) => message.type === "room" && message.room.name === "重启保留测试");
  red.send({ type: "join_room", roomId: created.room.id });
  await red.waitFor((message) => message.type === "room" && message.room.id === created.room.id);
  blue.send({ type: "set_ready", ready: true });
  red.send({ type: "set_ready", ready: true });
  const playing = await blue.waitFor((message) => message.type === "room" && message.room.game?.status === "playing");
  blue.send({ type: "resign", version: playing.room.game.version });
  await blue.waitFor((message) => message.type === "room" && message.room.game?.status === "finished");
  blue.send({ type: "history_list" });
  const beforeRestart = await blue.waitFor((message) => message.type === "history_list" && message.records.length === 1);
  const recordId = beforeRestart.records[0].id;
  blue.send({ type: "history_get", id: recordId });
  const fullRecord = await blue.waitFor((message) => message.type === "history_record" && message.record.id === recordId);
  assert.equal(fullRecord.record.frames.at(-1).status, "finished");
  blue.socket.close();
  red.socket.close();
  await firstServer.close();

  const secondServer = createGameServer({ historyFile });
  t.after(() => secondServer.close());
  const secondAddress = await secondServer.listen({ port: 0, host: "127.0.0.1" });
  const viewer = socketClient(`ws://127.0.0.1:${secondAddress.port}/ws`, "history-viewer", "查看者");
  await viewer.opened;
  await viewer.waitFor((message) => message.type === "welcome");
  viewer.send({ type: "history_list" });
  const afterRestart = await viewer.waitFor((message) => message.type === "history_list" && message.records.length === 1);
  assert.equal(afterRestart.records[0].id, recordId);
  assert.equal(afterRestart.records[0].roomName, "重启保留测试");
  viewer.socket.close();
});

test("局域网玩家可选择 V3，与它对弈并在回放中查看 AI 版本", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jungle-v3-room-"));
  const server = createGameServer({ historyFile: join(directory, "history.json"), aiSearchTimeMs: 20 });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = await server.listen({ port: 0, host: "127.0.0.1" });
  const host = socketClient(`ws://127.0.0.1:${address.port}/ws`, "v3-room-host", "训练对手测试");
  await host.opened;
  host.send({ type: "create_room", name: "强化学习实战" });
  await host.waitFor((message) => message.type === "room");
  host.send({ type: "set_ai_version", version: "v3" });
  host.send({ type: "set_rule", ruleId: "snake", enabled: true });
  host.send({ type: "set_rule", ruleId: "football-poison", enabled: true });
  host.send({ type: "add_ai" });
  const seated = await host.waitFor((message) => message.room?.players.some((player) => player?.isAI));
  assert.equal(seated.room.players.find((player) => player?.isAI).aiVersion, "v3");
  host.send({ type: "set_ready", ready: true });
  const { room: { game } } = await host.waitFor((message) => message.room?.game?.status === "playing");
  if (game.youColor === game.turn) host.send({ type: "flip", index: 0, version: game.version });
  const { room } = await host.waitFor((message) => message.room?.game?.lastAction?.isAI);
  assert.equal(room.game.lastAction.ai.version, "v3");
  assert.match(room.game.lastAction.ai.method, /rl|policy|v3/);
  host.send({ type: "resign", version: room.game.version });
  await host.waitFor((message) => message.room?.game?.status === "finished");
  host.send({ type: "history_get", id: game.id });
  const { record } = await host.waitFor((message) => message.type === "history_record");
  assert.equal(record.players.find((player) => player.isAI).aiVersion, "v3");
  assert.ok(record.frames.some((frame) => frame.action?.ai?.version === "v3"));
  assert.deepEqual([...record.ruleIds].sort(), ["football-poison", "snake"]);
  host.socket.close();
});
