/**
 * dsh-migrate-on-429 — 会话迁移插件（宿主端 + 客户端打包期双端安全）
 *
 * 场景：会话上下文过长 → 每次请求携带超大输入 → 频繁触发 429 TPM 限流。
 * 旧插件 dsh-auto-continue-429 只会反复发 "continue"，治标不治本（每次
 * continue 都重新发送全部超大上下文，继续 429，纯烧额度）。
 *
 * 本插件是超集：先自动 continue 重试若干次（阈值前）；仍持续失败则
 * 1) 总结当前会话（结构化提取 + 可选 LLM 精炼，两者结合）；
 * 2) cancel 旧会话（中止运行中的轮次 + 清空收件箱）→ 保证「交接而非并行」；
 * 3) 用 ctx.agents.create 创建全新会话（同 cwd / 同 agent preset / 同模型），
 *    把交接摘要 + 原任务作为首条用户消息注入，让新会话继续任务；
 * 4) 旧会话永久解除武装（不再自动 continue），新会话成为唯一续跑者。
 *
 * ⚠️ 双端安全约束（与 dsh-auto-continue-429 一致）：
 *   - 本模块顶层不能 import 任何 node builtins，也不能顶层 import 会拉入
 *     node builtins 的包（@deepseek-ai/dsh-agent 顶层 import node:async_hooks，
 *     客户端 bundler 会炸）。所有 node builtins / dsh 核心包都走
 *     lazy dynamic import，只在宿主端 apply() 首次执行时才真正加载。
 *   - 模块顶层只有纯数据 + createUserMessage 内联实现，保证客户端 bundler
 *     能 parse、cordis loader 永远拿到 typeof apply === "function"。
 */

// ── createUserMessage 内联实现（浏览器/Node 双端可运行）─────────────
function _deepFreeze(obj) {
  if (obj === null || obj === undefined) return obj;
  const t = typeof obj;
  if (t !== "object" && t !== "function") return obj;
  if (Object.isFrozen(obj)) return obj;
  const propNames = Object.getOwnPropertyNames(obj);
  for (const k of propNames) _deepFreeze(obj[k]);
  return Object.freeze(obj);
}

export function createUserMessage(input) {
  const clone = (typeof structuredClone === "function")
    ? structuredClone(input)
    : JSON.parse(JSON.stringify(input));
  const msg = {
    ...clone,
    role: "user",
    id: globalThis.crypto.randomUUID(),
  };
  return _deepFreeze(msg);
}

const name = "migrate-on-429";
const inject = ["agents"];

const CONFIG_DEFAULTS = {
  migrateThreshold: 3,       // 连续失败达到此数 → 迁移（小于此数先自动 continue）
  windowMs: 180000,          // 请求级 429 统计滚动窗口（毫秒）
  llmSummary: true,          // 尝试用 LLM 精炼交接摘要（失败自动回退结构化）
  continueMessage: "continue",
};

const DEFAULT_MAX_THRESHOLD = 20;
const MIN_THRESHOLD = 2;
const MAX_THRESHOLD = 50;
const MIN_WINDOW_MS = 30000;
const MAX_WINDOW_MS = 3600000;

// DSH 适配器归一化的稳定错误码：
//   - "RATE_LIMIT"              HTTP 429（TPM / RPM 限流）
//   - "QUOTA"                   配额/余额耗尽（insufficient_quota）
//   - "CONTEXT_WINDOW_EXCEEDED" 上下文超长（400 context_length_exceeded）
// 三类都属"临时无法完成、需要更小上下文/稍后继续"，都计入迁移判定。
const RETRYABLE_CODES = new Set(["RATE_LIMIT", "QUOTA", "CONTEXT_WINDOW_EXCEEDED"]);

let settings = {
  enabled: true,
  quickOn: true,
  buttonHidden: false,
  migrateThreshold: CONFIG_DEFAULTS.migrateThreshold,
  windowMs: CONFIG_DEFAULTS.windowMs,
  llmSummary: CONFIG_DEFAULTS.llmSummary,
  continueMessage: CONFIG_DEFAULTS.continueMessage,
};
let settingsFile = null;
let settingsLoaded = false;

// ── Node builtins lazy loader ──────────────────────────────────────
let _builtinsPromise = null;
function getBuiltins() {
  if (_builtinsPromise) return _builtinsPromise;
  _builtinsPromise = (async () => {
    try {
      const [fs, path, os] = await Promise.all([
        import("node:fs"),
        import("node:path"),
        import("node:os"),
      ]);
      return { isNode: true, fs, path, os };
    } catch {
      return { isNode: false };
    }
  })();
  return _builtinsPromise;
}

function ensureNodeRuntimeOrThrow(b) {
  if (!b.isNode) throw new Error("not running on Node.js host runtime");
}
function ensureSettingsReady(b) {
  ensureNodeRuntimeOrThrow(b);
  if (!settingsFile) {
    // 允许通过环境变量把配置重定向（测试隔离 / 多 profile 各一份配置）
    settingsFile = (typeof process !== "undefined" && process.env && process.env.DSH_MIGRATE_ON_429_CONFIG)
      ? process.env.DSH_MIGRATE_ON_429_CONFIG
      : b.path.join(b.os.homedir(), ".dsh", "migrate-on-429.json");
  }
  if (!settingsLoaded) {
    try {
      if (b.fs.existsSync(settingsFile)) {
        const data = JSON.parse(b.fs.readFileSync(settingsFile, "utf8"));
        settings = { ...settings, ...data };
        clampSettings();
      }
    } catch {
      // 读取失败，使用默认值
    }
    settingsLoaded = true;
  }
}
function clampSettings() {
  const n = Number(settings.migrateThreshold);
  settings.migrateThreshold = Number.isFinite(n)
    ? Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.floor(n)))
    : CONFIG_DEFAULTS.migrateThreshold;
  const w = Number(settings.windowMs);
  settings.windowMs = Number.isFinite(w)
    ? Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.floor(w)))
    : CONFIG_DEFAULTS.windowMs;
  settings.llmSummary = settings.llmSummary !== false;
}
function saveSettingsNow(b) {
  ensureNodeRuntimeOrThrow(b);
  ensureSettingsReady(b);
  try {
    const dir = b.path.join(b.os.homedir(), ".dsh");
    if (!b.fs.existsSync(dir)) b.fs.mkdirSync(dir, { recursive: true });
    b.fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch {
    // 写入失败，忽略
  }
}

function randomDelayMs() {
  return 1000 + Math.random() * 1000;
}

// ── apply ──────────────────────────────────────────────────────────
async function apply(ctx, config = {}) {
  const b = await getBuiltins();
  // 浏览器侧（非 Node 运行时）：空插件，真实 UI 由 client.js 注入。
  if (!b.isNode) return;

  ensureSettingsReady(b);

  const continueMessage = config.continueMessage ?? settings.continueMessage;
  if (typeof continueMessage === "string" && continueMessage.trim() !== "") {
    settings.continueMessage = continueMessage.trim();
  }

  // 每个会话一个状态：请求级 429 滚动计数 + turn 级连续失败计数 + 迁移标记
  const state = new Map();
  let lastMigration = null;
  let activeSessionId = null; // 最近交互的会话（用户消息 / 轮次开始），客户端指示器据此显示

  function stateFor(sid) {
    let s = state.get(sid);
    if (!s) {
      s = {
        request429s: [],     // 时间戳（滚动窗口内）
        turnStreak: 0,       // 连续 turn 级失败
        pendingTimer: null,
        migrating: false,
        migrated: false,
        migratedTo: null,
        promptFile: null,
      };
      state.set(sid, s);
    }
    return s;
  }
  function prune(s, now) {
    const cutoff = now - settings.windowMs;
    while (s.request429s.length > 0 && s.request429s[0] < cutoff) s.request429s.shift();
  }
  function resetStreaks(s) {
    s.turnStreak = 0;
    s.request429s.length = 0;
  }
  function agentOf(sid) {
    try { return ctx.agents.get(sid); } catch { return undefined; }
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      Promise.resolve(promise).then(
        () => { clearTimeout(timer); resolve(true); },
        () => { clearTimeout(timer); resolve(false); }
      );
    });
  }

  function messageText(message) {
    if (!message) return "";
    const content = Array.isArray(message.content) ? message.content : [];
    const parts = [];
    for (const blk of content) {
      if (blk && blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
    }
    return parts.join("").trim();
  }

  function collectToolPaths(blk, set) {
    try {
      let args = {};
      if (typeof blk.arguments === "string") {
        try { args = JSON.parse(blk.arguments); } catch { args = {}; }
      } else if (blk.arguments && typeof blk.arguments === "object") {
        args = blk.arguments;
      }
      for (const key of ["file_path", "path", "filePath", "filename", "directory", "target", "destination", "source", "cwd"]) {
        const v = args[key];
        if (typeof v === "string" && v.length > 1 && v.length < 500) set.add(v);
      }
    } catch { /* 忽略解析失败 */ }
  }

  function sanitizeFileName(s) {
    return String(s || "session").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  }

  // 从会话事件里做结构化交接提取（保底，不消耗 LLM）
  function buildHandoverMarkdown(agent, opts) {
    const session = agent?.session;
    const header = (session && session.header) || {};
    const events = (session && session.events) || [];
    const userMsgs = [];
    const assistantTexts = [];
    const touched = new Set();
    for (const e of events) {
      if (e.type === "user/message") {
        const src = (e.data && e.data.source) || {};
        if (src.kind === "plugin") continue; // 跳过本插件 continue 与 compact 检查点
        const text = messageText(e.data);
        if (text) userMsgs.push({ seq: e.seq, text });
      } else if (e.type === "assistant/message") {
        const msg = e.data && e.data.message;
        const content = (msg && msg.content) || [];
        const text = messageText(msg);
        if (text) assistantTexts.push({ seq: e.seq, text, interrupted: e.data?.interrupted === true });
        for (const blk of content) {
          if (blk && blk.type === "tool-call") collectToolPaths(blk, touched);
        }
      }
    }
    const originalTask = userMsgs.length ? userMsgs[0].text : "(未找到原始任务，请查看交接文档)";
    const followups = userMsgs.slice(1).map((u) => u.text).filter(Boolean);
    const recent = assistantTexts.slice(-8).map((a) => a.text);

    const lines = [];
    lines.push("# 会话交接总结");
    lines.push("");
    lines.push(`- 原会话: \`${header.id || (agent && agent.id) || "?"}\``);
    lines.push(`- 工作目录: \`${header.cwd || "(未知)"}\``);
    lines.push(`- Agent 预设: \`${header.agentPreset || "(默认)"}\``);
    lines.push(`- 模型: \`${opts.selection && opts.selection.provider ? opts.selection.provider + "/" + opts.selection.model : "(未知)"}\``);
    lines.push(`- 迁移原因: ${opts.reason}`);
    lines.push("");
    lines.push("## 原始任务");
    lines.push(originalTask);
    lines.push("");
    if (followups.length > 0) {
      lines.push("## 用户后续指示");
      followups.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
      lines.push("");
    }
    if (recent.length > 0) {
      lines.push("## 已完成进展（助手最近输出摘要）");
      recent.forEach((t, i) => {
        const clipped = t.length > 600 ? t.slice(0, 600) + "…" : t;
        lines.push(`- [${i + 1}] ${clipped.replace(/\n+/g, " ")}`);
      });
      lines.push("");
    }
    if (touched.size > 0) {
      lines.push("## 涉及文件");
      [...touched].sort().forEach((p) => lines.push(`- \`${p}\``));
      lines.push("");
    }
    lines.push("## 待办/未完成");
    lines.push("（由续跑代理根据上述上下文自行识别，优先从尚未完成的部分继续，不要重复已完成工作）");
    return lines.join("\n");
  }

  async function tryLlmSummarize(content, selection) {
    const llm = ctx.get("llm");
    if (!llm || !selection || !selection.provider) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const prepared = await llm.prepareCall(
        { provider: selection.provider, model: selection.model, maxTokens: 1500 },
        ctl.signal
      );
      const stream = prepared.stream({
        provider: selection.provider,
        model: selection.model,
        messages: [{
          role: "user",
          id: globalThis.crypto.randomUUID(),
          content: [{ type: "text", text: "请把下面的会话交接材料精炼成一份简洁、结构化的交接总结（保留：原始任务、已完成进度、未完成事项、关键文件路径、下一步建议）。直接输出总结正文，不要客套。\n\n" + content }],
        }],
        signal: ctl.signal,
      });
      let out = "";
      for await (const chunk of stream) {
        if (chunk.type === "text-delta") out += chunk.text;
        else if (chunk.type === "finish" && chunk.reason && chunk.reason.kind === "error") return null;
      }
      const trimmed = out.trim();
      return trimmed.length > 20 ? trimmed : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function buildHandover(agent, opts) {
    const baseMd = buildHandoverMarkdown(agent, opts);
    let summaryText = baseMd;
    let llmUsed = false;
    let filePath = null;
    try {
      const dir = b.path.join(b.os.homedir(), ".dsh", "migrations");
      b.fs.mkdirSync(dir, { recursive: true });
      const sid = (agent && agent.session && agent.session.header && agent.session.header.id) || (agent && agent.id) || "session";
      filePath = b.path.join(dir, `${sanitizeFileName(sid)}-${Date.now()}.md`);
      let fileBody = baseMd;
      if (settings.llmSummary && opts.selection && opts.selection.provider) {
        const refined = await tryLlmSummarize(baseMd, opts.selection);
        if (refined) {
          summaryText = refined;
          llmUsed = true;
          fileBody = baseMd + "\n\n---\n\n## LLM 精炼总结\n\n" + refined + "\n";
        }
      }
      b.fs.writeFileSync(filePath, fileBody);
    } catch {
      filePath = null;
    }
    return { baseMd, summaryText, filePath, llmUsed };
  }

  function buildHandoverPrompt(handover, opts) {
    const lines = [];
    lines.push(`[系统交接] 上一个会话 \`${opts.sid}\` 因 ${opts.reason}（上下文过长导致 TPM 限流）已停止，任务交接给你继续。`);
    lines.push("");
    lines.push("规则：");
    lines.push("1. 不要重复已经完成的工作；");
    lines.push("2. 先简要复述你对任务的理解和剩余步骤，然后立即继续执行；");
    lines.push("3. 完整交接文档在 " + (handover.filePath || "(未生成)") + "（需要时读取它获取更多细节）。");
    lines.push("");
    lines.push("—— 交接总结 ——");
    lines.push(handover.summaryText);
    return lines.join("\n");
  }

  async function resolveSelection(agent) {
    const dflt = ctx.get("agentDefaultModel");
    if (dflt && typeof dflt.currentSelection === "function") {
      try {
        const sel = dflt.currentSelection();
        if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model };
      } catch { /* 忽略 */ }
    }
    const events = (agent && agent.session && agent.session.events) || [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const cfg = e && e.type === "request/header" ? (e.data && e.data.header && e.data.header.config) : undefined;
      if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
    }
    return { provider: "", model: "" };
  }

  // ── 迁移主流程（异步，不阻塞 request-error dispatch）──────────────────
  // 注意：profile 插件的运行时模块解析无法可靠裸导入 @deepseek-ai/* 包
  //（与 dsh-auto-continue-429 一样，不依赖顶层 import）。
  // SessionId 只是编译期 brand（运行时就是普通字符串），直接内联即可；
  // 模型选择注入用 agentCtx 上等价的事件监听内联实现（语义与
  // @deepseek-ai/dsh-agent 的 installModelSelection 一致）。
  function installModelSelectionInline(agentCtx, selection) {
    agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const assembled = await next();
      if (!selection || !selection.provider) return assembled;
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: selection.provider,
          model: selection.model,
        },
      };
    });
    agentCtx.on("agent/request", async (_payload, next) => {
      const resolved = await next();
      if (!selection || !selection.provider) return resolved;
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
      return {
        ...withoutInheritedEffort,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }),
      };
    });
  }

  // 解析迁移目标工作区（最权威：源会话所属工作区；其次 header.cwd 解析；
  // 最后兜底 homedir）。同时拿到 workspace 实体，便于创建后 attachSession。
  async function resolveTargetWorkspace(agent, header, sid) {
    const wr = ctx.get("workspaceRegistry");
    if (!wr) return { cwd: header.cwd || b.os.homedir(), workspace: null };
    try {
      for (const w of wr.list()) {
        const ids = w.sessionIds;
        if (ids.includes(sid)) return { cwd: w.path, workspace: w };
      }
      if (header.cwd) {
        const ws = await wr.resolveByPath(header.cwd);
        if (ws) return { cwd: ws.path, workspace: ws };
      }
    } catch { /* 注册表未就绪等，走兜底 */ }
    return { cwd: header.cwd || b.os.homedir(), workspace: null };
  }
  // 把新会话登记进工作区（应用自身的 session.create 就是这么做的），
  // 否则侧边栏里新会话不会出现在正确工作区下（workspace.sessionIds 按
  // sessionPath(id) 过滤，而新会话的 path 从未被注册）。
  async function registerToWorkspace(newId, target) {
    const wr = ctx.get("workspaceRegistry");
    if (!wr) return;
    try {
      let workspace = target.workspace;
      if (!workspace) {
        workspace = await wr.resolveByPath(target.cwd) ?? await wr.create(target.cwd);
      }
      if (workspace) await workspace.attachSession(newId);
    } catch (e) {
      console.warn(`[migrate-on-429] 新会话 ${newId} 登记工作区失败（不影响迁移本身）: ${e && e.message ? e.message : String(e)}`);
    }
  }

  // ── 启动对账：把历史迁移产生的「已存在但未登记工作区」的会话补登记 ──
  // 背景：早期版本插件用 ctx.agents.create 直接建会话、未调用 attachSession，
  // 导致侧边栏工作区看不到这些会话（workspace.sessionIds 里没有它们）。
  // 本函数在插件加载后延迟执行一次：扫描全部会话（活跃 + 持久化），凡 cwd
  // 能解析到某工作区但尚未登记的，就补 attachSession —— 幂等、失败仅记日志。
  async function reconcileWorkspaceMembership() {
    const wr = ctx.get("workspaceRegistry");
    if (!wr || typeof wr.list !== "function" || typeof wr.resolveByPath !== "function") return;
    try {
      const registered = new Set();
      for (const w of wr.list()) {
        if (w && Array.isArray(w.sessionIds)) for (const sid of w.sessionIds) registered.add(sid);
      }
      // 收集所有会话的 id/cwd：活跃会话 + 持久化头部
      const known = new Map();
      const sessions = ctx.get("sessions");
      if (sessions && typeof sessions.list === "function") {
        try {
          for (const s of sessions.list()) {
            if (s && s.header) known.set(s.header.id, s.header.cwd);
          }
        } catch { /* 忽略 */ }
      }
      const sp = ctx.get("sessionPersistence");
      if (sp && typeof sp.list === "function") {
        let headers;
        try { headers = await sp.list(); } catch { headers = []; }
        for (const h of headers || []) {
          if (h && h.id) known.set(h.id, h.cwd);
        }
      }
      let attached = 0;
      for (const [sid, cwd] of known) {
        if (registered.has(sid)) continue;
        if (typeof cwd !== "string" || cwd.trim() === "") continue;
        let ws;
        try { ws = await wr.resolveByPath(cwd); } catch { ws = undefined; }
        if (!ws) continue; // cwd 不属于任何已知工作区，跳过（不强行建）
        if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sid)) continue;
        try {
          await ws.attachSession(sid);
          attached++;
        } catch (e) {
          console.warn(`[migrate-on-429] 对账补登记会话 ${sid} 失败: ${e && e.message ? e.message : String(e)}`);
        }
      }
      if (attached > 0) console.info(`[migrate-on-429] 工作区对账：为 ${attached} 个未登记会话补登记进工作区`);
    } catch (e) {
      console.warn(`[migrate-on-429] 工作区对账失败: ${e && e.message ? e.message : String(e)}`);
    }
  }

  async function runMigration(agent, s, reason) {
    const sid = agent ? agent.id : "?";
    try {
      // 1) 等待旧会话彻底空闲 —— 「交接而非并行」的核心保证：
      //    先 cancel（中止轮次+清空收件箱），再等 whenIdle 真正结束，才创建新会话。
      await withTimeout(Promise.resolve(agent && agent.whenIdle ? agent.whenIdle() : undefined).catch(() => {}), 20000);

      // 2) 生成交接摘要
      const selection = await resolveSelection(agent);
      const handover = await buildHandover(agent, { reason, selection });

      // 3) 解析新会话身份/配置（沿用旧会话所在工作区 / agent preset / 模型）
      const header = (agent && agent.session && agent.session.header) || {};
      const target = await resolveTargetWorkspace(agent, header, sid);
      const cwd = target.cwd;
      const presetId = header.agentPreset;
      const presets = ctx.get("agentPresets");
      let mountId = presetId;
      if (presetId && presets) {
        try { mountId = (await presets.resolve(presetId)).id; } catch { mountId = presetId; }
      }
      const newId = `session-${globalThis.crypto.randomUUID()}`;

      const { agent: newAgent } = await ctx.agents.create({
        sessionId: newId,
        meta: {
          cwd,
          ...(mountId ? { agentPreset: mountId } : {}),
        },
        agentOptions: {
          provider: selection.provider || "",
          model: selection.model || "",
        },
        setup: async (agentCtx) => {
          installModelSelectionInline(agentCtx, selection);
          if (presets && mountId) await presets.mount(agentCtx, mountId);
        },
      });

      // 3.5) 登记进工作区，确保侧边栏显示在正确工作区下
      await registerToWorkspace(newId, target);

      // 4) 注入交接 prompt 作为新会话首条用户消息，续跑
      await withTimeout(Promise.resolve(newAgent.whenIdle()).catch(() => {}), 30000);
      const prompt = buildHandoverPrompt(handover, { sid, reason });
      newAgent.followup(createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" },
      }));

      // 5) 旧会话追加可见说明（本插件 source，不触发任何计数重置）
      try {
        if (agent && agent.session) {
          agent.session.append(
            "user/message",
            createUserMessage({
              content: [{
                type: "text",
                text: `⛔ 429 迁移：本会话因频繁 TPM 限流已交接至新会话 \`${newId}\`，本会话已停止自动继续。交接摘要${handover.filePath ? `见 ${handover.filePath}` : "见新会话首条消息"}。`,
              }],
              source: { kind: "plugin", plugin: "migrate-on-429" },
            }),
            { surfaceOp: "append" }
          );
        }
      } catch { /* 忽略 */ }

      s.migrated = true;
      s.migrating = false;
      s.migratedTo = newId;
      s.promptFile = handover.filePath;
      lastMigration = {
        at: Date.now(),
        from: sid,
        to: newId,
        reason,
        file: handover.filePath,
        llm: handover.llmUsed,
      };
      console.info(`[migrate-on-429] ✅ 会话 ${sid} → 迁移到 ${newId}（${reason}${handover.llmUsed ? "，LLM 精炼摘要" : ""}）`);
    } catch (e) {
      s.migrating = false;
      console.error(`[migrate-on-429] ❌ 迁移失败（${sid}）: ${e && e.stack ? e.stack : String(e)}`);
    }
  }

  function startMigration(agent, s, reason) {
    if (!agent || s.migrated || s.migrating) return;
    s.migrating = true; // 立即解除武装：不再继续、不再计数
    if (s.pendingTimer) { clearTimeout(s.pendingTimer); s.pendingTimer = null; }
    try {
      agent.cancel(new Error(`migrate-on-429: ${reason} — handing over to a fresh session`));
    } catch { /* 忽略 */ }
    console.info(`[migrate-on-429] 会话 ${agent.id} 触发迁移（${reason}），先取消旧会话…`);
    void runMigration(agent, s, reason);
  }

  // ── HTTP 路由（客户端状态/配置）────────────────────────────────
  ctx.inject(["webServer"], (wctx) => {
    wctx.effect(() => {
      const routes = [
        {
          kind: "exact",
          path: "/api/migrate-on-429/state",
          handler: async (req, res) => {
            if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
            let maxFailures = 0;   // 跨会话 turn 级连续失败的最大值（展示用主计数）
            let maxRequest429s = 0;
            const bySession = {};
            for (const [id, s] of state) {
              bySession[id] = { turnStreak: s.turnStreak, request429s: s.request429s.length, migrated: s.migrated, migrating: s.migrating, migratedTo: s.migratedTo };
              if (s.turnStreak > maxFailures) maxFailures = s.turnStreak;
              if (s.request429s.length > maxRequest429s) maxRequest429s = s.request429s.length;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
              enabled: settings.enabled,
              quickOn: settings.quickOn,
              buttonHidden: settings.buttonHidden,
              migrateThreshold: settings.migrateThreshold,
              windowMs: settings.windowMs,
              llmSummary: settings.llmSummary,
              activeSessionId,
              maxFailures,
              maxRequest429s,
              bySession,
              lastMigration,
            }));
          },
        },
        {
          kind: "exact",
          path: "/api/migrate-on-429/toggle",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            settings.enabled = !settings.enabled;
            saveSettingsNow(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ enabled: settings.enabled }));
          },
        },
        {
          kind: "exact",
          path: "/api/migrate-on-429/toggle-quick",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            settings.quickOn = !settings.quickOn;
            saveSettingsNow(b);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ quickOn: settings.quickOn }));
          },
        },
        {
          kind: "exact",
          path: "/api/migrate-on-429/hide-button",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              settings.buttonHidden = body.hidden === true;
              saveSettingsNow(b);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ buttonHidden: settings.buttonHidden }));
            } catch {
              res.writeHead(400); res.end("invalid json");
            }
          },
        },
        {
          kind: "exact",
          path: "/api/migrate-on-429/set-config",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            try {
              const chunks = [];
              for await (const chunk of req) chunks.push(chunk);
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const errors = [];
              if (body.migrateThreshold !== undefined) {
                const n = Number(body.migrateThreshold);
                if (!Number.isFinite(n) || n < MIN_THRESHOLD || n > MAX_THRESHOLD) errors.push(`migrateThreshold 必须是 ${MIN_THRESHOLD}-${MAX_THRESHOLD} 的整数`);
                else settings.migrateThreshold = Math.floor(n);
              }
              if (body.windowMs !== undefined) {
                const w = Number(body.windowMs);
                if (!Number.isFinite(w) || w < MIN_WINDOW_MS || w > MAX_WINDOW_MS) errors.push(`windowMs 必须是 ${MIN_WINDOW_MS}-${MAX_WINDOW_MS} 的整数`);
                else settings.windowMs = Math.floor(w);
              }
              if (body.llmSummary !== undefined) settings.llmSummary = body.llmSummary === true;
              if (errors.length > 0) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, errors }));
                return;
              }
              saveSettingsNow(b);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true, migrateThreshold: settings.migrateThreshold, windowMs: settings.windowMs, llmSummary: settings.llmSummary }));
            } catch {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, errors: ["invalid json"] }));
            }
          },
        },
        {
          kind: "exact",
          path: "/api/migrate-on-429/migrate-now",
          handler: async (req, res) => {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            try {
              let sid = null;
              try {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (body && typeof body.sessionId === "string" && body.sessionId.trim() !== "") sid = body.sessionId.trim();
              } catch { /* 无 body 或非 JSON：忽略，走 activeSessionId */ }
              if (!sid) sid = activeSessionId;
              if (!sid) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "未指定会话且无活跃会话" }));
                return;
              }
              const agent = agentOf(sid);
              if (!agent) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: `未找到会话 ${sid}` }));
                return;
              }
              const s = stateFor(sid);
              if (s.migrating) {
                res.writeHead(409, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "该会话正在迁移中" }));
                return;
              }
              if (s.migrated) {
                res.writeHead(409, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: `该会话已迁移过（→ ${s.migratedTo}）` }));
                return;
              }
              if (!settings.enabled) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "插件已停用（enabled=false）" }));
                return;
              }
              startMigration(agent, s, "手动触发迁移");
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true, sessionId: sid }));
            } catch (e) {
              res.writeHead(500, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
            }
          },
        },
      ];
      const disposers = routes.map((r) => wctx.webServer.register(r));
      return () => disposers.forEach((d) => d());
    });
  });

  // ── 请求级 429 监听（prepend 优先于 dsh-llm-retry，能看见每一次 429）──
  const offRequestError = ctx.on("agent/request-error", async (payload, next) => {
    try {
      const agent = payload && payload.agent;
      if (!agent) return next();
      if (!settings.enabled || !settings.quickOn) return next();
      const failure = payload.failure;
      if (!failure || !RETRYABLE_CODES.has(failure.code)) return next();
      const sid = agent.id;
      const s = stateFor(sid);
      if (s.migrated || s.migrating) return next();
      const now = Date.now();
      s.request429s.push(now);
      prune(s, now);
      const count = s.request429s.length;
      // 请求级是"快速通道"：需要更重的突发（2×阈值）才迁移，避免把
      // llm-retry 能恢复的瞬时 429 误判为"频繁"。真正的 TPM 饱和会迅速累积。
      const requestTrigger = Math.max(settings.migrateThreshold * 2, settings.migrateThreshold + 3);
      if (count >= requestTrigger) {
        startMigration(agent, s, `请求级 429 ×${count}`);
      }
    } catch { /* 观察型监听，绝不抛出 */ }
    return next();
  }, { prepend: true });

  // ── 会话事件监听（turn 级）────────────────────────────────────
  const offSessionEvent = ctx.on("session/event", (session, event) => {
    const sid = session.id;
    if (event.type === "turn/start") {
      activeSessionId = sid;
      return;
    }
    if (event.type === "user/message") {
      const src = (event.data && event.data.source) || {};
      if (src.kind === "plugin" && src.plugin === "migrate-on-429") return;
      // 用户手动输入：只归零「本会话」的失败计数（其它会话不受影响），
      // 并取消本会话待发送的 continue，避免用户已手动接管后再自动继续。
      activeSessionId = sid;
      const cur = state.get(sid);
      if (cur) {
        resetStreaks(cur);
        if (cur.pendingTimer) { clearTimeout(cur.pendingTimer); cur.pendingTimer = null; }
      }
      return;
    }
    if (event.type !== "turn/end") return;
    const reason = event.data && event.data.reason;
    const s = state.get(sid) ?? stateFor(sid);
    // 正常完成 / 中止 / 非可重试错误：重置连续失败计数
    if (!reason || reason.kind !== "error" || !reason.error || !RETRYABLE_CODES.has(reason.error.code)) {
      resetStreaks(s);
      return;
    }
    if (!settings.enabled || !settings.quickOn) return;
    if (s.migrated || s.migrating) return;

    s.turnStreak += 1;
    const streak = s.turnStreak;
    if (streak >= settings.migrateThreshold) {
      startMigration(agentOf(sid), s, `turn 级 429 ×${streak}`);
      return;
    }
    // 阈值前：自动 continue 重试（与旧插件行为一致）
    if (s.pendingTimer) clearTimeout(s.pendingTimer);
    const delay = randomDelayMs();
    console.info(`[migrate-on-429] 会话 ${sid} 连续失败 ${streak}/${settings.migrateThreshold}，${Math.round(delay)}ms 后自动 continue`);
    s.pendingTimer = setTimeout(() => {
      s.pendingTimer = null;
      try {
        const agent = agentOf(sid);
        if (!agent) { console.warn(`[migrate-on-429] 未找到会话 ${sid} 的 agent`); return; }
        agent.followup(createUserMessage({
          content: [{ type: "text", text: settings.continueMessage }],
          source: { kind: "plugin", plugin: "migrate-on-429" },
        }));
        console.info(`[migrate-on-429] 已发送 continue 到会话 ${sid}`);
      } catch (e) {
        console.error(`[migrate-on-429] 发送 continue 失败: ${e && e.message ? e.message : String(e)}`);
      }
    }, delay);
  });

  const offDisposed = ctx.on("session/disposed", (session) => {
    const s = state.get(session.id);
    if (!s) return;
    if (s.pendingTimer) clearTimeout(s.pendingTimer);
    state.delete(session.id);
  });

  // ── 启动对账（延迟执行，等 workspaceRegistry / sessions 就绪）──────────
  // 插件每次加载后补登记一次历史未登记的会话；对账本身幂等，不重复 attach。
  let reconcileTimer = null;
  const reconcileDelayMs = Number.isFinite(Number(config.reconcileDelayMs))
    ? Math.max(0, Number(config.reconcileDelayMs))
    : 3000;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcileWorkspaceMembership();
  }, reconcileDelayMs);

  // ── 清理 ──────────────────────────────────────────────────────
  ctx.effect(() => () => {
    if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null; }
    for (const s of state.values()) {
      if (s.pendingTimer) clearTimeout(s.pendingTimer);
    }
    state.clear();
    if (typeof offRequestError === "function") offRequestError();
    if (typeof offSessionEvent === "function") offSessionEvent();
    if (typeof offDisposed === "function") offDisposed();
  });
}

// 双端 loader 兼容：named + default 都导出。
export { apply, inject, name };
export default { apply, inject, name };
