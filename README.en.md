# dsh-migrate-on-429

[中文版](README.md) · **English**

A [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) plugin: when a session keeps hitting **429 TPM rate limits** (usually because the context has grown too long and every request carries a huge input), it automatically **summarizes the current session and migrates the task to a fresh session** — the old session is cancelled first, then the new one starts. This is a **true handoff, never parallel work**.

The older `dsh-auto-continue-429` plugin only kept sending `continue` (each retry re-sends the whole oversized context → more 429s → wasted quota). This plugin is its superset: it auto-continues below the threshold as usual, and only when failures persist does it truly "hand off to a clean session" to keep going.

## How it works

1. **Detect** — listens to `agent/request-error` (request-level, `prepend` ahead of dsh-llm-retry) and `session/event` `turn/end`, counting `RATE_LIMIT` (429) / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` failures.
2. **Below threshold** — schedules an automatic `continue` with a backoff delay (same behavior as the old plugin).
3. **Threshold reached (default 3 consecutive failures)**:
   - `agent.cancel()` stops the old session's running turn and clears its inbox — **the old one stops first**;
   - waits for the old session `whenIdle()` — **guarantees no parallelism**;
   - builds a **handover summary** from the session event log (structured extraction: original task / follow-up instructions / recent assistant output / touched files / cwd / preset / model; optionally refines it once with the LLM, falling back to structured on failure);
   - writes the handover doc to `~/.dsh/migrations/<sessionId>-<timestamp>.md`;
   - `ctx.agents.create()` creates a **brand-new session** (same cwd / same agent preset / same model, with full tooling and system prompt), injecting "handover summary + original task + continue rules" as the first user message — the new session appears in the Web UI sidebar and continues from where it left off;
   - the old session is permanently disarmed (no more auto-continue) and gets a visible note.

## Configuration

Config file `~/.dsh/migrate-on-429.json` (editable in the Web settings "429 自动迁移" tab; or redirect with the `DSH_MIGRATE_ON_429_CONFIG` env var for testing / multi-profile isolation):

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `quickOn` | `true` | Composer quick switch (independent of master) |
| `migrateThreshold` | `3` | Migrate after this many consecutive failures (2–50) |
| `windowMs` | `180000` | Request-level 429 rolling window (30s–1h) |
| `llmSummary` | `true` | Try LLM refinement of the handover summary (falls back to structured) |
| `continueMessage` | `"continue"` | Message content for below-threshold auto-continue |

## HTTP API (client / manual)

| Endpoint | Description |
|---|---|
| `GET /api/migrate-on-429/state` | Status: settings + `activeSessionId` + per-session `turnStreak`/`request429s`/`migrated` + `lastMigration` |
| `POST /api/migrate-on-429/toggle` | Master switch |
| `POST /api/migrate-on-429/toggle-quick` | Quick switch |
| `POST /api/migrate-on-429/hide-button` | Hide the composer button |
| `POST /api/migrate-on-429/set-config` | Change `migrateThreshold`/`windowMs`/`llmSummary` |
| `POST /api/migrate-on-429/migrate-now` | **Manual immediate migration** (optional `{sessionId}` in body; defaults to the active session) |

Badge model: shows the **active session's** `turnStreak` (same metric as the threshold); ⏳ while migrating, red ⇄ when migrated. Request-level 429s stay internal to the fast path and never pollute the shown count.

## Workspace registration & startup reconciliation

Migration creates the new session via `ctx.agents.create`, **not** the app's own `session.create` flow, so the new session wouldn't automatically appear under a workspace in the sidebar. The plugin explicitly calls `workspace.attachSession` after migrating to register the new session into the **source session's workspace** (same `cwd`), so the sidebar shows it in the right place.

The plugin also runs a one-time **startup reconciliation** after each load (`config.reconcileDelayMs`, default 3000ms): it scans all sessions (live + persisted) and auto-attaches any session whose `cwd` resolves to a workspace but isn't registered yet (idempotent). This heals historical orphan sessions created before the registration feature existed — restart once and they land in the correct workspace. Set `reconcileDelayMs` to `0` to reconcile immediately on load.

## Installation

### Local development (link dependency)

```jsonc
// profiles/web/package.json dependencies
"dsh-migrate-on-429": "link:C:/path/to/dsh-migrate-on-429"
// profiles/web/package.json dsh.profile.bundles
"dsh-migrate-on-429"
```

Remove the old `dsh-auto-continue-429` (bundles + dependencies), then:

```bash
cd <profiles>/web && pnpm install
```

Restart the DeepSeek Harness desktop app.

### From npm (recommended)

```bash
dsh plugin --profile web add @minyang2026/dsh-migrate-on-429
```

> `dsh` is the DeepSeek Harness CLI (bundled with the desktop app; a standalone CLI can be installed via `npm i -g @deepseek-ai/dsh`). `dsh plugin` forwards its arguments to pnpm in the profile directory, installs from the npm registry, then restart the app.
>
> Note: DSH Web's "plugin market" only lists plugins curated in the awesome-dsh-plugin.com catalog — it is **not** a full-text search over the npm registry. This plugin is not yet submitted there, so it won't show up in the market; use the `dsh plugin` command above instead.

### From GitHub

```bash
git clone https://github.com/minyang2020/dsh-migrate-on-429.git
# then follow the "Local development (link dependency)" steps above:
# point the link path at your cloned directory, run pnpm install, restart.
```

> Published on npm as `@minyang2026/dsh-migrate-on-429` (see "From npm" above). Submitting it to the plugin market (awesome-dsh-plugin.com curated list) is planned.

## Relationship with the old plugin (important)

- **This plugin replaces `dsh-auto-continue-429`.** Do **not** enable both at the same time — both listen to the same 429 events and would fight over retries/migrations. Remove the old plugin from both `dependencies` and `dsh.profile.bundles` before installing this one.
- The package name `@minyang2026/dsh-migrate-on-429` is distinct from `dsh-auto-continue-429`, so npm/installer resolution won't collide.
- If you previously installed `dsh-auto-continue-429`, uninstall it, then install this plugin and restart the app.
- Published on npm as `@minyang2026/dsh-migrate-on-429` (scoped).

## Design notes

- **Handoff, never parallel** — migration is strictly serial: `cancel(old) → await whenIdle(old) → create(new) → followup(new)`. The old session is disarmed the moment migration starts and can never run the same task concurrently with the new one.
- **Dual-environment safe** — the host entry `lib/index.js` has zero top-level node builtins and zero `@deepseek-ai` imports (the client bundler can also parse it); Node-side `node:fs/path/os` are lazily loaded inside `apply()`. `SessionId` and model-selection injection (`system-prompt/assemble` + `agent/request`) are implemented inline, avoiding the problem of a profile plugin being unable to reliably import core packages at runtime.
- **Robustness** — all observing listeners never throw; LLM refinement has a 25s timeout with fallback; a failed migration only disarms that session and logs, never affecting other sessions.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 minyang2020.
