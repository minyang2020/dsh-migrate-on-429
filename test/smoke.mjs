/**
 * dsh-migrate-on-429 — host logic smoke test (mock ctx, no real DSH host).
 *
 * Verifies the core migration flow:
 *  1. turn-level: 3 consecutive RATE_LIMIT turn/end → cancel(old) → create(new) → seed → note
 *  2. request-level: heavy 429 burst (>= 2× threshold) → early migration
 *  3. below threshold: auto-continue is scheduled, no migration
 *  4. after migration: old session is disarmed (no further migration)
 *
 * Run: node test/smoke.mjs
 */
import { apply, name } from "../lib/index.js";

// 隔离测试配置：指向不存在的临时路径 → 使用默认值（阈值 3），
// 不读/不写用户的真实 ~/.dsh/migrate-on-429.json。
process.env.DSH_MIGRATE_ON_429_CONFIG = "./.smoke-migrate-on-429-test.json";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ " + msg); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeMessage(text, source) {
  return { role: "user", id: "test-" + Math.random().toString(36).slice(2), content: [{ type: "text", text }], source };
}

function makeSession(id, events) {
  const appended = [];
  return {
    id,
    header: { id, cwd: "C:\\test\\proj", agentPreset: "standard-lite" },
    events,
    append(type, data, opts) { appended.push({ type, data, opts }); return { seq: 0, data }; },
    _appended: appended,
  };
}

function makeAgent(id, session, opts = {}) {
  const log = { cancelled: [], followups: [] };
  return {
    id,
    session,
    status: "idle",
    // 真实宿主里 agent.cancel() 会 abort 本轮 phase.abort.signal —— 这个 signal
    // 正是 request-error payload 里的 signal。opts.onCancel 让 mock 复现该行为。
    cancel(cause) {
      log.cancelled.push(String(cause));
      if (typeof opts.onCancel === "function") opts.onCancel(cause);
    },
    whenIdle() { return Promise.resolve(); },
    followup(msg) { log.followups.push(msg); },
    _log: log,
  };
}

function buildCtx(opts = {}) {
  const handlers = new Map();
  const cleanups = [];
  const agents = new Map();
  const created = [];
  const registeredRoutes = [];
  const webServer = { register(r) { registeredRoutes.push(r); return () => {}; } };
  const presets = {
    async resolve(id) { return { id }; },
    async mount(agentCtx, id) { /* no-op */ },
  };
  const defaultModel = { currentSelection() { return { provider: "deepseek", model: "deepseek-chat" }; } };
  // opts.llm: null（跳过 LLM）| mock 对象 | undefined（默认跳过）
  const llm = opts.llm === undefined ? null : opts.llm;
  // opts.workspaceRegistry: 可选 mock（测「新会话登记进工作区」）
  const workspaceRegistry = opts.workspaceRegistry || undefined;
  // opts.sessions / opts.sessionPersistence: 可选 mock（测「启动对账」）
  const sessionsSvc = opts.sessions || undefined;
  const persistenceSvc = opts.sessionPersistence || undefined;

  const ctx = {
    agents: {
      get(id) { return agents.get(id); },
      async create(opts) {
        const na = makeAgent(opts.sessionId, makeSession(opts.sessionId, []));
        created.push({ opts, agent: na });
        return { agent: na };
      },
    },
    get(name) {
      if (name === "agentDefaultModel") return defaultModel;
      if (name === "agentPresets") return presets;
      if (name === "llm") return llm;
      if (name === "webServer") return { webServer };
      if (name === "workspaceRegistry") return workspaceRegistry;
      if (name === "sessions") return sessionsSvc;
      if (name === "sessionPersistence") return persistenceSvc;
      return undefined;
    },
    on(ev, handler, opts) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      const list = handlers.get(ev);
      if (opts && opts.prepend) list.unshift(handler); else list.push(handler);
      return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); };
    },
    inject(deps, cb) { cb({ effect(fn) { const c = fn(); if (typeof c === "function") cleanups.push(c); }, webServer }); },
    effect(fn) { const c = fn(); if (typeof c === "function") cleanups.push(c); return c; },
    logger: { warn: console.warn, info: console.info, error: console.error },
  };
  return { ctx, handlers, agents, created, registeredRoutes, cleanups };
}

async function main() {
  console.log(`\n[${name}] smoke test`);

  // ── Test 1: turn-level migration after threshold ──
  console.log("\n#1 turn-level 3× RATE_LIMIT → migration");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, {});
    const session = makeSession("session-t1", [
      { seq: 0, type: "user/message", data: { role: "user", id: "u0", content: [{ type: "text", text: "帮我写一个 Python 脚本" }], source: { kind: "user" } } },
      { seq: 1, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "好的，我先创建脚本文件。" }] } } },
    ]);
    const agent = makeAgent("session-t1", session);
    agents.set("session-t1", agent);
    const turnEnd = handlers.get("session/event");

    const err = (code) => ({ turn: 1, reason: { kind: "error", error: { code, message: "rate limit" } } });
    for (const ev of [err("RATE_LIMIT"), err("RATE_LIMIT"), err("RATE_LIMIT")]) {
      for (const h of turnEnd) h(session, { type: "turn/end", data: ev });
    }
    await sleep(150); // 等异步 runMigration 完成

    assert(agent._log.cancelled.length === 1, "旧会话被 cancel 一次");
    assert(created.length === 1, "创建了一个新会话");
    assert(created[0] && created[0].opts.meta.cwd === "C:\\test\\proj", "新会话沿用旧 cwd");
    assert(created[0] && created[0].opts.meta.agentPreset === "standard-lite", "新会话沿用旧 preset");
    assert(created[0] && created[0].opts.agentOptions.provider === "deepseek", "新会话沿用模型 provider");
    const na = created[0] ? created[0].agent : null;
    assert(na && na._log.followups.length === 1, "新会话被 seed 了一条用户消息");
    if (na && na._log.followups[0]) {
      const text = JSON.stringify(na._log.followups[0].content);
      assert(text.includes("交接") && text.includes("帮我写一个 Python 脚本"), "seed 消息包含交接总结 + 原任务");
    }
    const note = session._appended.find((a) => a.type === "user/message");
    assert(!!note && JSON.stringify(note.data.source) === JSON.stringify({ kind: "plugin", plugin: "migrate-on-429" }), "旧会话追加了迁移说明");

    // 迁移后再次 429 不应再触发第二次迁移（已解除武装）
    for (const h of turnEnd) h(session, { type: "turn/end", data: err("RATE_LIMIT") });
    await sleep(50);
    assert(created.length === 1, "迁移后旧会话被解除武装，不再二次迁移");
  }

  // ── Test 2: below threshold → auto-continue, no migration ──
  console.log("\n#2 1× RATE_LIMIT → auto-continue，不迁移");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, {});
    const session = makeSession("session-t2", []);
    const agent = makeAgent("session-t2", session);
    agents.set("session-t2", agent);
    const turnEnd = handlers.get("session/event");
    for (const h of turnEnd) h(session, { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } } });
    await sleep(50);
    assert(created.length === 0, "1 次失败未迁移");
    assert(agent._log.cancelled.length === 0, "1 次失败未 cancel");
  }

  // ── Test 3: request-level heavy burst → early migration ──
  console.log("\n#3 请求级 6× RATE_LIMIT → 快速迁移");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, {});
    const session = makeSession("session-t3", []);
    const agent = makeAgent("session-t3", session);
    agents.set("session-t3", agent);
    const reqErr = handlers.get("agent/request-error");
    const payload = () => ({ agent, turn: 1, step: 1, provider: "deepseek", failure: { code: "RATE_LIMIT", message: "tpm" }, retryPolicy: undefined, signal: new AbortController().signal });
    for (let i = 0; i < 6; i++) {
      for (const h of reqErr) await h(payload(), () => Promise.resolve(undefined));
    }
    await sleep(150);
    assert(agent._log.cancelled.length === 1, "请求级突发触发 cancel");
    assert(created.length === 1, "请求级突发触发新会话创建");
  }

  // ── Test 4: non-retryable error → no migration ──
  console.log("\n#4 非 429 错误（SERVER）不迁移");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, {});
    const session = makeSession("session-t4", []);
    const agent = makeAgent("session-t4", session);
    agents.set("session-t4", agent);
    const turnEnd = handlers.get("session/event");
    for (let i = 0; i < 4; i++) for (const h of turnEnd) h(session, { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "SERVER", message: "boom" } } } });
    await sleep(50);
    assert(created.length === 0, "SERVER 错误不迁移");
    assert(agent._log.cancelled.length === 0, "SERVER 错误不 cancel");
  }

  // ── Test 5: HTTP routes registered ──
  console.log("\n#5 HTTP 路由注册");
  {
    const { ctx, registeredRoutes } = buildCtx();
    await apply(ctx, {});
    const paths = registeredRoutes.map((r) => r.path);
    assert(paths.includes("/api/migrate-on-429/state"), "state 路由已注册");
    assert(paths.includes("/api/migrate-on-429/set-config"), "set-config 路由已注册");
    assert(paths.length >= 5, `共 ${paths.length} 条路由`);
  }

  // ── Test 6: LLM 精炼成功 → seed 用 LLM 总结 ──
  console.log("\n#6 LLM 精炼成功 → seed 使用 LLM 总结");
  {
    const llmOk = {
      async prepareCall() {
        return {
          stream: async function* () {
            yield { type: "text-delta", index: 0, text: "[LLM精炼] 任务：写脚本；已建文件；待写逻辑" };
            yield { type: "finish", reason: { kind: "completed" } };
          },
        };
      },
    };
    const { ctx, handlers, agents, created } = buildCtx({ llm: llmOk });
    await apply(ctx, {});
    const session = makeSession("session-t6", [
      { seq: 0, type: "user/message", data: { role: "user", id: "u0", content: [{ type: "text", text: "写一个 Python 脚本" }], source: { kind: "user" } } },
    ]);
    const agent = makeAgent("session-t6", session);
    agents.set("session-t6", agent);
    const turnEnd = handlers.get("session/event");
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(session, { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } } });
    await sleep(150);
    const na = created[0] ? created[0].agent : null;
    const text = na && na._log.followups[0] ? JSON.stringify(na._log.followups[0].content) : "";
    assert(text.includes("[LLM精炼]"), "LLM 成功时 seed 使用 LLM 总结");
    assert(created.length === 1, "LLM 路径同样完成迁移");
  }

  // ── Test 7: LLM 失败 → 回退结构化 ──
  console.log("\n#7 LLM 失败 → 自动回退结构化提取");
  {
    const llmFail = {
      async prepareCall() { throw new Error("no adapter for provider"); },
    };
    const { ctx, handlers, agents, created } = buildCtx({ llm: llmFail });
    await apply(ctx, {});
    const session = makeSession("session-t7", [
      { seq: 0, type: "user/message", data: { role: "user", id: "u0", content: [{ type: "text", text: "写一个 Python 脚本" }], source: { kind: "user" } } },
    ]);
    const agent = makeAgent("session-t7", session);
    agents.set("session-t7", agent);
    const turnEnd = handlers.get("session/event");
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(session, { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } } });
    await sleep(150);
    const na = created[0] ? created[0].agent : null;
    const text = na && na._log.followups[0] ? JSON.stringify(na._log.followups[0].content) : "";
    assert(text.includes("# 会话交接总结"), "LLM 失败时回退到结构化交接文档");
    assert(created.length === 1, "回退路径仍完成迁移");
  }

  // ── Test 8: 用户手动输入 → 计数归零，不误迁移 ──
  console.log("\n#8 用户手动输入重置计数，不误迁移");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, {});
    const session = makeSession("session-t8", []);
    const agent = makeAgent("session-t8", session);
    agents.set("session-t8", agent);
    const turnEnd = handlers.get("session/event");
    const err = { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } };
    for (let i = 0; i < 2; i++) for (const h of turnEnd) h(session, { type: "turn/end", data: err });
    // 用户手动输入（source kind=user，非插件）→ 归零
    for (const h of turnEnd) h(session, { type: "user/message", data: makeMessage("我改主意了，换个方向", { kind: "user" }) });
    for (let i = 0; i < 2; i++) for (const h of turnEnd) h(session, { type: "turn/end", data: err });
    await sleep(80);
    assert(created.length === 0, "归零后 2 次失败（<3）不迁移");
    assert(agent._log.cancelled.length === 0, "归零后不 cancel");
  }

  // ── Test 9: 与 dsh-llm-retry 的真实顺序交互（prepend 优先）─────
  console.log("\n#9 prepend 优先于 llm-retry：cancel 后 retry 决策不产生，交接不并行");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, {});
    const session = makeSession("session-t9", []);
    const ctl = new AbortController();
    const agent = makeAgent("session-t9", session, { onCancel: () => ctl.abort() });
    agents.set("session-t9", agent);
    // 模拟 dsh-llm-retry：正常模式下，RATE_LIMIT 可重试且 signal 未中止 → 返回 {kind:"retry"}
    const offRetry = ctx.on("agent/request-error", async (payload, next) => {
      if (payload.failure && payload.failure.code === "RATE_LIMIT" && !payload.signal.aborted) return { kind: "retry" };
      return next();
    });
    // 真实瀑布语义：按注册顺序依次调用，handler 可短路
    async function dispatchWaterfall(list, payload) {
      let i = 0;
      const next = () => {
        const h = list[i++];
        return h ? Promise.resolve(h(payload, next)) : Promise.resolve(undefined);
      };
      return next();
    }
    const list = handlers.get("agent/request-error");
    let finalDecision = undefined;
    for (let n = 0; n < 6; n++) {
      finalDecision = await dispatchWaterfall(list, { agent, turn: 1, step: 1, provider: "deepseek", failure: { code: "RATE_LIMIT", message: "tpm" }, retryPolicy: undefined, signal: ctl.signal });
    }
    await sleep(150);
    assert(agent._log.cancelled.length === 1, "突发 6 次 → 旧会话被 cancel");
    assert(ctl.signal.aborted === true, "cancel 已中止本轮 signal（= 真实宿主里 payload.signal）");
    assert(finalDecision === undefined, "llm-retry 看到已中止 signal，不返回 retry 决策（不并行）");
    assert(created.length === 1, "完成迁移创建新会话");
    if (typeof offRetry === "function") offRetry();
  }

  // ── Test 10: 手动立即迁移（migrate-now 路由）──────────────
  console.log("\n#10 手动立即迁移按钮 → migrate-now 路由触发迁移");
  {
    const { ctx, handlers, agents, created, registeredRoutes } = buildCtx();
    await apply(ctx, {});
    const session = makeSession("session-m1", [
      { seq: 0, type: "user/message", data: { role: "user", id: "u0", content: [{ type: "text", text: "跑一个长任务" }], source: { kind: "user" } } },
    ]);
    const agent = makeAgent("session-m1", session, { onCancel: () => {} });
    agents.set("session-m1", agent);
    // 通过用户消息让宿主记录 activeSessionId = session-m1
    const evHandlers = handlers.get("session/event");
    for (const h of evHandlers) h(session, { type: "user/message", data: makeMessage("跑一个长任务", { kind: "user" }) });

    async function callRoute(path, method, bodyStr) {
      const route = registeredRoutes.find((r) => r.path === path);
      const req = { method, [Symbol.asyncIterator]: async function* () { if (bodyStr) yield Buffer.from(bodyStr, "utf8"); } };
      let status = 0, body = null;
      const res = { writeHead(s) { status = s; }, end(b) { body = b ? JSON.parse(b) : null; } };
      await route.handler(req, res);
      return { status, body };
    }
    const r = await callRoute("/api/migrate-on-429/migrate-now", "POST", "");
    assert(r.status === 200 && r.body && r.body.ok === true, "migrate-now 返回 ok:true（用活跃会话）");
    await sleep(150);
    assert(agent._log.cancelled.length === 1, "手动迁移 → 旧会话被 cancel");
    assert(created.length === 1, "手动迁移 → 创建新会话");

    // 已迁移后再点 → 409
    const r2 = await callRoute("/api/migrate-on-429/migrate-now", "POST", "");
    assert(r2.status === 409, "已迁移会话再次 migrate-now 返回 409");
  }

  // ── Test 11: 计数只归零本会话（其它会话不受用户输入影响）──
  console.log("\n#11 计数按会话隔离：B 会话用户输入不影响 A 会话计数");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, {});
    const sa = makeSession("session-a", []);
    const aa = makeAgent("session-a", sa);
    agents.set("session-a", aa);
    const sb = makeSession("session-b", []);
    const ab = makeAgent("session-b", sb);
    agents.set("session-b", ab);
    const turnEnd = handlers.get("session/event");
    const err = { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } };
    for (let i = 0; i < 2; i++) for (const h of turnEnd) h(sa, { type: "turn/end", data: err });
    // B 会话用户手动输入 → 只应归零 B，不影响 A
    for (const h of turnEnd) h(sb, { type: "user/message", data: makeMessage("B 用户输入", { kind: "user" }) });
    for (let i = 0; i < 2; i++) for (const h of turnEnd) h(sa, { type: "turn/end", data: err });
    await sleep(150);
    assert(created.length === 1, "A 会话计数未被 B 输入归零，累计到阈值触发迁移");
    assert(aa._log.cancelled.length === 1, "A 会话被迁移 cancel");
  }

  // ── Test 12: state 计数 = turn 级连续失败（不再把请求级相加）──
  console.log("\n#12 state 返回 turnStreak 主计数 + activeSessionId + 请求级分开");
  {
    const { ctx, handlers, agents, registeredRoutes } = buildCtx();
    await apply(ctx, {});
    const session = makeSession("session-s1", []);
    const agent = makeAgent("session-s1", session);
    agents.set("session-s1", agent);
    const turnEnd = handlers.get("session/event");
    const reqErr = handlers.get("agent/request-error");
    for (const h of turnEnd) h(session, { type: "user/message", data: makeMessage("hi", { kind: "user" }) });
    // 1 次 turn 级失败 + 5 次请求级 429（< 快速通道阈值 6，不迁移）
    for (const h of turnEnd) h(session, { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } } });
    const payload = { agent, turn: 1, step: 1, provider: "deepseek", failure: { code: "RATE_LIMIT", message: "tpm" }, retryPolicy: undefined, signal: new AbortController().signal };
    for (let i = 0; i < 5; i++) for (const h of reqErr) await h(payload, () => Promise.resolve(undefined));

    let stateBody = null;
    const route = registeredRoutes.find((r) => r.path === "/api/migrate-on-429/state");
    await route.handler({ method: "GET" }, { writeHead() {}, end(b) { stateBody = JSON.parse(b); } });
    assert(stateBody.activeSessionId === "session-s1", "state 返回 activeSessionId");
    assert(stateBody.maxFailures === 1, "maxFailures 只算 turn 级（1，不再把请求级相加）");
    assert(stateBody.maxRequest429s === 5, "请求级单独返回（5）");
    assert(stateBody.bySession["session-s1"].turnStreak === 1 && stateBody.bySession["session-s1"].request429s === 5, "bySession 分开展示 turnStreak 与 request429s");
  }

  // ── Test 13: 迁移目标工作区解析 + 新会话 attachSession 登记 ──
  console.log("\n#13 迁移沿用源会话工作区，并把新会话 attachSession 登记进工作区");
  {
    const attachLog = [];
    const ws = {
      path: "C:\\test\\proj",
      get sessionIds() { return ["session-src"]; },
      async attachSession(id) { attachLog.push({ workspace: this.path, sessionId: id }); },
    };
    const wr = {
      list() { return [ws]; },
      async resolveByPath(p) { return p === "C:\\test\\proj" ? ws : undefined; },
      async create(p) { return ws; },
    };
    const { ctx, handlers, agents, created } = buildCtx({ workspaceRegistry: wr });
    await apply(ctx, {});
    const session = makeSession("session-src", []);
    const agent = makeAgent("session-src", session);
    agents.set("session-src", agent);
    const turnEnd = handlers.get("session/event");
    const err = { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } };
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(session, { type: "turn/end", data: err });
    await sleep(150);
    assert(created.length === 1, "完成迁移");
    assert(created[0].opts.meta.cwd === "C:\\test\\proj", "新会话 cwd 取源会话所属工作区路径");
    const newId = created[0].agent.id;
    assert(attachLog.some((a) => a.workspace === "C:\\test\\proj" && a.sessionId === newId), "新会话已 attachSession 登记进正确工作区");
  }

  // ── Test 14: 启动对账 —— 历史未登记会话（已存在、cwd 属某工作区）自动补登记 ──
  console.log("\n#14 启动对账：历史已存在但未登记工作区的会话自动 attachSession");
  {
    const attachLog = [];
    const ws = {
      path: "C:\\test\\proj",
      sessionIds: ["session-already"],
      async attachSession(id) { attachLog.push({ workspace: this.path, sessionId: id }); },
    };
    const wr = {
      list() { return [ws]; },
      async resolveByPath(p) { return p === "C:\\test\\proj" ? ws : undefined; },
      async create(p) { return ws; },
    };
    // 持久化里有两个会话：一个已登记（跳过）、一个 cwd 属 proj 但未登记（应补登记）
    const persistenceSvc = {
      async list() {
        return [
          { id: "session-already", cwd: "C:\\test\\proj" },
          { id: "session-orphan", cwd: "C:\\test\\proj" },
          { id: "session-nocwd", cwd: undefined },
        ];
      },
    };
    const { ctx } = buildCtx({ workspaceRegistry: wr, sessionPersistence: persistenceSvc });
    await apply(ctx, { reconcileDelayMs: 0 });
    await sleep(30); // 等对账（reconcileDelayMs=0 也会走 setTimeout 宏任务）
    assert(attachLog.some((a) => a.sessionId === "session-orphan"), "未登记孤儿会话被补登记");
    assert(!attachLog.some((a) => a.sessionId === "session-already"), "已登记会话不重复登记");
    assert(!attachLog.some((a) => a.sessionId === "session-nocwd"), "无 cwd 的会话不登记");
  }

  // ── Test 15: provider 级突发（多子代理同时 429）→ 全局冷却，压住连环迁移 ──
  console.log("\n#15 多会话同时 429 → 突发检测进入全局冷却，不迁移、不 cancel");
  {
    const { ctx, handlers, agents, created, registeredRoutes } = buildCtx();
    await apply(ctx, { providerBurstWindowMs: 10000, providerBurstSessions: 2, providerBurstCount: 3, globalCooldownMs: 60000 });
    const sa = makeSession("session-p1", []);
    const aa = makeAgent("session-p1", sa);
    agents.set("session-p1", aa);
    const sb = makeSession("session-p2", []);
    const ab = makeAgent("session-p2", sb);
    agents.set("session-p2", ab);
    const reqErr = handlers.get("agent/request-error");
    const payloadFor = (agent) => ({ agent, turn: 1, step: 1, provider: "deepseek", failure: { code: "RATE_LIMIT", message: "tpm" }, retryPolicy: undefined, signal: new AbortController().signal });
    // 3 次 429 来自 2 个会话（≥ burstSessions=2 且 ≥ burstCount=3）→ provider 级限流
    for (const h of reqErr) await h(payloadFor(aa), () => Promise.resolve(undefined));
    for (const h of reqErr) await h(payloadFor(aa), () => Promise.resolve(undefined));
    for (const h of reqErr) await h(payloadFor(ab), () => Promise.resolve(undefined));
    // 冷却中即使凑满 turn 级阈值也不迁移
    const turnEnd = handlers.get("session/event");
    const err = { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } };
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(sa, { type: "turn/end", data: err });
    await sleep(80);
    assert(created.length === 0, "provider 突发后冷却期内不触发迁移");
    assert(aa._log.cancelled.length === 0, "冷却期内不 cancel");
    // state 暴露冷却状态
    let stateBody = null;
    const route = registeredRoutes.find((r) => r.path === "/api/migrate-on-429/state");
    await route.handler({ method: "GET" }, { writeHead() {}, end(b) { stateBody = JSON.parse(b); } });
    assert(stateBody.globalCooldown && stateBody.globalCooldown.active === true, "state 暴露全局冷却 active=true");
  }

  // ── Test 16: 迁移互斥 —— 已有迁移在途时其它会话被跳过 ──
  console.log("\n#16 迁移互斥：迁移在途时其它会话不并发交接");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, { providerBurstWindowMs: 10000, providerBurstSessions: 3, providerBurstCount: 100, globalCooldownMs: 60000 });
    // 让 A 的 whenIdle 挂起 → 迁移保持 in-flight
    let releaseIdle;
    const gate = new Promise((r) => { releaseIdle = r; });
    const sa = makeSession("session-m1", []);
    const aa = makeAgent("session-m1", sa);
    aa.whenIdle = () => gate;
    agents.set("session-m1", aa);
    const sb = makeSession("session-m2", []);
    const ab = makeAgent("session-m2", sb);
    agents.set("session-m2", ab);
    const turnEnd = handlers.get("session/event");
    const err = { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } };
    // A 触发迁移（迁移在途：whenIdle 挂起）
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(sa, { type: "turn/end", data: err });
    // B 同时凑满阈值 → 应被互斥跳过
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(sb, { type: "turn/end", data: err });
    releaseIdle();
    await sleep(80);
    assert(created.length === 1, "迁移在途时只发生一次交接");
    assert(aa._log.cancelled.length === 1 && ab._log.cancelled.length === 0, "只有第一个会话被 cancel");
  }

  // ── Test 17: 冷却结束后单个仍频繁失败的会话正常迁移（串行恢复） ──
  console.log("\n#17 冷却结束后仍失败的会话逐个迁移（串行不并发）");
  {
    const { ctx, handlers, agents, created } = buildCtx();
    await apply(ctx, { providerBurstWindowMs: 5000, providerBurstSessions: 3, providerBurstCount: 10, globalCooldownMs: 50 });
    const sa = makeSession("session-r1", []);
    const aa = makeAgent("session-r1", sa);
    agents.set("session-r1", aa);
    const sb = makeSession("session-r2", []);
    const ab = makeAgent("session-r2", sb);
    agents.set("session-r2", ab);
    const turnEnd = handlers.get("session/event");
    const err = { turn: 1, reason: { kind: "error", error: { code: "RATE_LIMIT", message: "rl" } } };
    // A 先达标 → 迁移（成功后冷却 50ms）
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(sa, { type: "turn/end", data: err });
    // B 同步达标 → 此时被冷却压制
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(sb, { type: "turn/end", data: err });
    await sleep(120); // 等 A 完成 + 冷却过期
    // B 仍失败 → 冷却结束后正常迁移（第二次交接发生在 A 之后）
    for (let i = 0; i < 3; i++) for (const h of turnEnd) h(sb, { type: "turn/end", data: err });
    await sleep(120);
    assert(created.length === 2, "冷却结束后第二个会话也完成迁移（串行共 2 次）");
    assert(aa._log.cancelled.length === 1 && ab._log.cancelled.length === 1, "两个会话各被 cancel 一次");
  }

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
