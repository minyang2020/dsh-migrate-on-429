# dsh-migrate-on-429

**中文** · [English](README.en.md)

DeepSeek Harness (dsh) 插件：当会话**频繁触发 429 TPM 限流**（通常因为上下文过长，每次请求携带超大输入）时，自动**总结当前会话并迁移到新会话继续任务** —— 先取消旧会话、再启动新会话，保证**交接而非并行**。

旧插件 `dsh-auto-continue-429` 只会反复发 `continue` 重试（每次 continue 都重新发送全部超大上下文 → 继续 429 → 纯烧额度）。本插件是它的超集：阈值前照常自动 continue 重试，仍持续失败就真正"换一个干净会话"续跑。

## 工作原理

1. **检测**：监听 `agent/request-error`（请求级，`prepend` 优先于 dsh-llm-retry）与 `session/event` 的 `turn/end`，统计 `RATE_LIMIT`（429）/ `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` 失败。
2. **阈值前**：按退避延迟自动向当前会话发 `continue`（与旧插件行为一致）。
3. **达到阈值（默认 3 次连续失败）**：
   - `agent.cancel()` 中止旧会话运行中的轮次并清空收件箱 —— **先停旧的**；
   - 等待旧会话 `whenIdle()` 真正空闲 —— **确保不并行**；
   - 从会话事件日志生成**交接摘要**（结构化提取：原始任务 / 用户后续指示 / 助手最近输出 / 涉及文件 / cwd / 预设 / 模型；可选再尝试一次 LLM 精炼，失败自动回退结构化）；
   - 交接文档写入 `~/.dsh/migrations/<会话id>-<时间戳>.md`；
   - `ctx.agents.create()` 创建**全新会话**（沿用同 cwd / 同 agent preset / 同模型，完整装配工具与系统提示），把"交接总结 + 原任务 + 继续规则"作为首条用户消息注入 —— 新会话自动出现在 Web UI 侧边栏，从尚未完成的部分继续；
   - 旧会话永久解除武装（不再自动 continue），并追加一条可见说明。

## 配置

配置文件 `~/.dsh/migrate-on-429.json`（可在 Web 设置页「429 自动迁移」tab 里改；也可用环境变量 `DSH_MIGRATE_ON_429_CONFIG` 重定向到其它路径，便于测试/多 profile 隔离）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 主开关 |
| `quickOn` | `true` | 对话框快捷开关（与主开关独立） |
| `migrateThreshold` | `3` | 连续失败达到此数触发迁移（2–50） |
| `windowMs` | `180000` | 请求级 429 滚动统计窗口（30s–1h） |
| `llmSummary` | `true` | 尝试 LLM 精炼交接摘要（失败自动回退结构化） |
| `continueMessage` | `"continue"` | 阈值前自动 continue 的消息内容 |
| `providerBurstWindowMs` | `30000` | provider 级限流判定窗口（5s–5min） |
| `providerBurstSessions` | `2` | 窗口内同时 429 的会话数 ≥ 此值判定 provider 级限流（2–20） |
| `providerBurstCount` | `3` | 且窗口内 429 总数 ≥ 此值（2–50） |
| `globalCooldownMs` | `60000` | 突发限流 / 每次迁移后的全局冷却（5s–10min） |

## HTTP API（客户端 / 手动操作）

| 端点 | 说明 |
|---|---|
| `GET /api/migrate-on-429/state` | 状态：设置 + `activeSessionId` + 各会话 `turnStreak`/`request429s`/`migrated` + `lastMigration` |
| `POST /api/migrate-on-429/toggle` | 主开关 |
| `POST /api/migrate-on-429/toggle-quick` | 快捷开关 |
| `POST /api/migrate-on-429/hide-button` | 隐藏输入区按钮 |
| `POST /api/migrate-on-429/set-config` | 改 `migrateThreshold`/`windowMs`/`llmSummary`/`providerBurst*`/`globalCooldownMs` |
| `POST /api/migrate-on-429/migrate-now` | **手动立即迁移**（body 可选 `{sessionId}`，缺省用当前活跃会话） |

界面指示器计数模型：徽标显示**当前活跃会话**的 `turnStreak`（连续失败次数，与阈值同口径）；迁移中 ⏳、已迁移红色 ⇄、全局冷却 ⏸（显示剩余秒数）。请求级 429 只在快速通道内部使用，不再混入展示计数。

## 多子代理并发：防连环交接

> 适用场景：父代理开多个子代理时，429 通常是 **provider 级 TPM 限流** —— 所有会话同时被限，
> 每个会话各自独立计数会导致 N 个会话同时各自 cancel+建新会话的「连环交接」，且新会话立刻又 429。
> 0.1.2 起插件引入跨会话全局协调：

1. **突发检测**：`providerBurstWindowMs` 窗口内 ≥ `providerBurstSessions` 个**不同会话**、且 429 总数 ≥ `providerBurstCount` → 判定 provider 级限流，进入 `globalCooldownMs` 全局冷却。冷却期间**所有会话**暂停自动 continue 与自动迁移（不再往已饱和的 TPM 池里烧请求）。
2. **迁移互斥**：同一时刻只允许一个会话在迁移（先 cancel 旧、再建新，交接依旧串行）；在途期间其它会话触发迁移会被跳过并记录日志。
3. **迁移后冷却**：每次迁移成功后同样进入全局冷却，防止兄弟会话紧随其后连环交接；冷却结束后若某个会话仍持续 429（那是它自身上下文过长的问题），它才被迁移。

Web 界面徽标在冷却期显示「⏸」；手动「立即迁移」不受冷却限制（仍是明确的人工意图），但受全局互斥约束。

## 工作区登记 / 启动对账

迁移用 `ctx.agents.create` 直接创建新会话，**不走应用自身的 `session.create` 流程**，因此新会话不会自动出现在侧边栏工作区下。插件在迁移后主动调用 `workspace.attachSession`，把新会话登记进**源会话所属工作区**（同一 `cwd`），保证侧边栏能在正确工作区看到它。

同时，插件每次加载后延迟执行一次**启动对账**（`config.reconcileDelayMs`，默认 3000ms）：扫描全部会话（活跃 + 持久化），凡 `cwd` 能解析到某工作区但尚未登记的会话，自动补 `attachSession`（幂等）。这样即使升级前已产生过「未登记」的历史孤儿会话，重启后也会被自动补进正确工作区。可在 profile 的插件行配置里用 `reconcileDelayMs` 调整（设为 `0` 则插件加载后立即对账）。

## 打包 / 安装

### ⚠️ 与旧插件 `dsh-auto-continue-429` 的关系（安装前必读）

- **本插件取代 `dsh-auto-continue-429`**：两者监听同一批 429 事件，**不要同时启用**，否则会互相抢着重试/迁移。安装本插件前，请先把旧插件从 `dependencies` 和 `dsh.profile.bundles` 里移除。
- 两个包名不同（`@minyang2026/dsh-migrate-on-429` vs `dsh-auto-continue-429`），npm / 安装器解析不会撞名。
- 若你之前装过 `dsh-auto-continue-429`：卸载它 → 安装本插件 → 重启应用。
- 本插件已发布到 npm：`@minyang2026/dsh-migrate-on-429`（scoped 包）。

### 本地开发（link 依赖）

```jsonc
// profiles/web/package.json dependencies
"@minyang2026/dsh-migrate-on-429": "link:C:/path/to/dsh-migrate-on-429"
// profiles/web/package.json dsh.profile.bundles 追加
"@minyang2026/dsh-migrate-on-429"
```

移除旧的 `dsh-auto-continue-429`（bundles + dependencies），然后：

```bash
cd <profiles>/web && pnpm install
```

重启 DeepSeek Harness 桌面应用生效。

> **从 0.1.0 升级**：0.1.0 的打包补丁 `cordis.patch.yml` 错误地把插件行的 `name`
> 写成了不带 scope 的 `dsh-migrate-on-429`，loader 按这个名在 node_modules 里解析不到
> scoped 包，需要一条别名依赖才能加载：
> `"dsh-migrate-on-429": "npm:@minyang2026/dsh-migrate-on-429@^0.1.0"`。
> 0.1.1–0.1.3 把补丁 `name` 改成了真实包名，但仍有缺陷：YAML 裸值未加引号（`@` 开头的
> plain scalar 非法，会造成 boot 解析失败）且 `lib/client.js` 的注册 id 仍是旧的
> 无 scope 名（浏览器端 `loaded without registering "@minyang2026/dsh-migrate-on-429"`）。
> **0.1.4 起**两者都已修正（`name` 加引号、注册 id 同步为 scoped 名），升级后请删除
> 上面那段别名依赖，依赖与 bundles 直接使用 scoped 名即可（npm 安装见下节）。

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add @minyang2026/dsh-migrate-on-429
```

> `dsh` 是 DeepSeek Harness 的命令行入口（桌面应用内置；独立 CLI 可用 `npm i -g @deepseek-ai/dsh` 安装）。`dsh plugin` 会把参数转发给 profile 目录下的 pnpm，从 npm registry 安装后重启应用生效。
>
> 注意：DSH Web 的「插件市场」目前只收录 awesome-dsh-plugin.com 精选列表里的插件（curated list），**不是** npm registry 的全量搜索 —— 本插件尚未提交收录，市场里暂时搜不到，请用上面的 `dsh plugin` 命令安装。

### 从 GitHub 安装

```bash
git clone https://github.com/minyang2020/dsh-migrate-on-429.git
# 然后按上面的「本地开发（link 依赖）」方式，把 package.json 里的
# link 路径换成你 clone 下来的本机目录，再 pnpm install + 重启。
```

> 已发布为 npm 包：`@minyang2026/dsh-migrate-on-429`（见上方「从 npm 安装」）。插件市场（awesome-dsh-plugin.com 精选列表）收录为后续计划。

## 设计要点

- **交接而非并行**：迁移是串行的 —— `cancel(旧) → await whenIdle(旧) → create(新) → followup(新)`。旧会话迁移瞬间即被解除武装，永远不会与新会话同时跑同一任务。
- **交接内容精简（去重 / 剪孤立，零 LLM）**：若原始任务本身是上一代迁移种子（`[系统交接] … —— 交接总结 ——`），递归解开迁移链、只保留最深层真实任务，中间各代交接整段丢弃；system-reminder（workspace 指令 / 技能目录等，新会话宿主会重新注入）不再抄进交接文档；用户后续指示与助手最近进展逐条去重、限长。防止「交接叠罗汉」让新会话首条消息重新撑爆上下文、当场再触发 429。
- **双端安全**：宿主入口 `lib/index.js` 顶层零 node builtins / 零 `@deepseek-ai` import（客户端 bundler 也能 parse）；Node 端在 `apply()` 内懒加载 `node:fs/path/os`。`SessionId` 与模型选择注入（`system-prompt/assemble` + `agent/request`）全部内联实现，规避 profile 插件运行时无法可靠裸导入核心包的问题。
- **健壮性**：所有观测型监听不抛异常；LLM 精炼带 25s 超时与降级；迁移失败仅解除本会话武装并记录日志，不影响其它会话。

## License

MIT
