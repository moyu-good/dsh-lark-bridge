<p align="center">
  <img src="https://img.shields.io/badge/dsh--lark--bridge-0.3.1-blueviolet" alt="version">
  <img src="https://img.shields.io/badge/tests-259-green" alt="tests">
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
  <img src="https://img.shields.io/badge/transport-WebSocket%20long--connection-orange" alt="transport">
</p>

<h1 align="center">🕊️ dsh-lark-bridge</h1>

<p align="center">
  <b>Run a full DeepSeek Harness coding agent inside Feishu / Lark</b><br/>
  <i>Native thinking process, approval cards, live goal/todo cards, subagent fan-out,
  bilingual slash panel — no public webhook URL needed.</i>
</p>

<p align="center">
  <a href="README.zh.md">中文</a> · <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="#slash-commands">Slash Commands</a> · <a href="#configuration">Configuration</a> · <a href="#architecture">Architecture</a> · <a href="#development">Development</a>
</p>

---

## What is this?

`dsh-lark-bridge` is a **Feishu/Lark IM channel for DeepSeek Harness** — a plugin that makes
your coding agent work right inside a chat. Each conversation (DM or group) drives its own
dsh agent with:

- **Native thinking process** — model reasoning renders as Feishu's own "thinking" message,
  tool calls with icons, results as code blocks. No black box.
- **Interactive approval cards** — operations needing confirmation become clickable
  cards (Allow once / Deny), with the decider written back.
- **Live lifecycle reactions** — `OK` → `THINKING` → `DONE` / `ERROR` on every message.
- **Live goal & todo cards** — goal phase changes and todo snapshots update a card in the
  chat, so a long-running task is never a silent gap.
- **WebSocket long connection** — no public callback URL, no reverse proxy.

Feishu is the carrier; the work is still done by DeepSeek Harness itself.

## ✨ Features

| | |
|---|---|
| 🧠 **Native thinking process** | `cot` renders reasoning as Feishu's native thinking message; older clients fall back to `stream` typewriter card |
| ✅ **Live reactions** | `OK` → `THINKING` → `DONE`/`ERROR`, states replace each other, configurable |
| 🗂️ **One agent per conversation** | `sessionScope`: whole chat / topic thread / single sender; sessions persist across restarts |
| 📋 **Approval cards** | Host approval questions render as Allow-once / Deny cards; decision + decider written back |
| 🎯 **Goal cards** | Live goal phase (active/paused/blocked/complete) updates a card; `/goal` works, `autoResumeGoals` re-arms after restarts |
| ✅ **Todo cards** | `todo_write` snapshots update a live card in the chat |
| 🧑💻 **Subagent fan-out** | Workflow runs stream as text lines: run start, child open, child end, run end |
| 📦 **Compaction transparency** | "Compacting…" → summary text + released tokens; prunes report trimmed count |
| ⏰ **Scheduled reminders** | `schedule_create/list/delete` tools + `/schedules` view (compose `@deepseek-ai/dsh-schedule` yourself; the plugin ships the full listener) |
| 🔍 **Session history search** | `/sessions <keyword>` full-text searches this chat's stored history with snippets |
| ⚙️ **Background job notifications** | `run_in_background` jobs and direct subagents announce their terminal outcome in the chat |
| ⚡ **Full slash panel** | `/stop /help /preset /sessions /tools /schedules /audit /config` plus host commands (`goal`, `plan`, `compact`, `feedback`, `permission`) |
| 🌐 **Bilingual commands** | Panel and `/help` follow the platform: English on international Lark, Chinese on domestic Feishu; `locale` overrides |
| 🖼️ **Image input (opt-in)** | `attachImages` downloads chat images into the host attachment store |
| 📎 **File delivery** | Agent `send_file` delivers files with caption into the chat |
| 🔑 **QR onboarding** | First boot prints a QR code; scanning creates the Feishu app (event subscription included), credentials persist |
| 🔒 **Authorization narrowing** | `senderAllowlist` / `groupAllowlist` / `approvers` narrow further than the app's visibility scope |
| 🧩 **Deep dsh adaptation** | Everything goes through host service contracts: `agents`, `agentPresets`, `agentDefaultModel`, `settings`, `workspaceRegistry`, `loader`, `invariants`, `approval`, `goals` — self-contained, no host source needed |

## 🚀 Quick Start

```sh
npx @deepseek-ai/dsh plugin --profile web add github:moyu-good/dsh-lark-bridge \
  && npx @deepseek-ai/dsh web
```

The console prints a QR code → scan with Feishu to create the app → fill in your
DeepSeek API Key in Settings → Models → DM the bot or @ it in a group.

> Already using `dsh`? Drop the `npx @deepseek-ai/` prefix.

The package ships **prebuilt** (`lib/` is committed) — no build step on install.
A `prepare` hook rebuilds automatically only when the compiled output is missing
(e.g. a source clone without the committed output).

## 💬 Slash Commands

| Command | Description |
|---|---|
| `/stop` | Cancel the running turn |
| `/help` | Show this listing |
| `/preset` | View / switch agent preset (standard / code / minimal / cordis) |
| `/sessions` | List this chat's session history |
| `/tools` | View / deny / allow tools at runtime |
| `/schedules` | View this chat's scheduled reminders |
| `/audit` | Operation audit summary for the session |
| `/config` | View the bridge's live configuration |
| `/goal` | View / set the goal (host) |
| `/plan` | Enter / leave plan mode (host) |
| `/compact` | Compact older history (host) |
| `/feedback` | Record session feedback (host) |
| `/permission` | Switch permission preset (host) |

Panel descriptions are bilingual: **English** when the platform domain is
`open.larksuite.com` (international Lark), **Chinese** for `open.feishu.cn`
(domestic Feishu). Set `locale: zh|en` to force one.

## vs. other Feishu/Lark bridges

| Capability | **dsh-lark-bridge** | xmanrui/dsh-im | omdsh-dev/dsh-lark | AX1202/ax-feishu-bridge |
|---|---|---|---|---|
| Positioning | Deep Harness channel | Multi-platform gateway | Scan-to-use | Pi + DSH dual bridge |
| Native thinking process (Feishu CoT) | ✅ | — | — | — |
| Approval cards + decider trail | ✅ | — | — | remote approve |
| Live goal/todo cards | ✅ | — | — | — |
| Workflow fan-out + phase/log lines | ✅ | — | — | — |
| Compaction transparency | ✅ | — | — | — |
| Goal auto-resume after restart | ✅ | — | crash-safe | — |
| Bilingual slash panel sync | ✅ | — | — | panel buttons |

## ⚙️ Configuration

| Field | Default | Meaning |
|---|---|---|
| `appId`, `appSecret` | first-boot QR registration | Feishu/Lark app credentials |
| `domain` | Feishu | Open-platform domain; Lark: `https://open.larksuite.com` |
| `locale` | `auto` | Command language: `auto` (Lark→en, Feishu→zh) / `zh` / `en` |
| `cwd` | host process cwd | Absolute workspace directory for chat agents |
| `provider`, `model` | host `agentDefaultModel` | Model routing for chat agents |
| `preset` | roster default | Agent preset chat agents join |
| `sessionScope` | `chat` | `chat` / `chat-thread` / `chat-sender` |
| `output` | `cot` | `cot` (native thinking process) or `stream` (typewriter card) |
| `showProcess` | `true` | Show reasoning and tool calls |
| `reactionFeedback` | `true` | Live reaction feedback |
| `hideProcessWhenDone` | `false` | Hide finished process (`cot` only) |
| `attachImages` | `false` | Pass chat images to the model |
| `syncSlashCommands` | `true` | Publish commands to bot's `/` panel (reconciles: creates missing, removes stale, refreshes drifted descriptions) |
| `autoResumeGoals` | `false` | Re-arm an active goal when a session returns after a restart |
| `approvalReminderMs` | `0` | Nudge the chat when an approval card is unanswered this many ms (0 = off) |
| `denyTools` | `[]` | Tools chat agents may not call |
| `requireMention` | `true` | In groups, only respond when @-mentioned |
| `senderAllowlist` | `[]` | Open ids allowed to DM |
| `groupAllowlist` | `[]` | Only these `oc_…` group chats when non-empty |
| `approvers` | `[]` | Open ids allowed to answer approvals |
| `outbound.allowedFileDirs` | unset → file sending disabled | Directories `send_file` may read **local** paths from. Required for delivering generated artifacts (HTML reports, screenshots, documents). Example: `outbound: { allowedFileDirs: ['/home/user/work'] }` |

> ⚠️ **File delivery is default-deny.** Without `outbound.allowedFileDirs`,
> `send_file` with a local path fails with
> `local file source requires outbound.allowedFileDirs to be configured` —
> the agent appears to send, nothing arrives. URLs and raw buffers always work.

Credentials resolve in three layers, later wins: bundle patch config → settings
document plugin section → first-boot QR registration.

## 🔐 Required app permissions

A **newly created** Feishu app needs these scopes published before the panel
and messaging work. The QR onboarding flow grants them automatically; a
manually created app must add them in Developer Console → Permissions, then
**create and publish a version** (scopes added after the last publish are not
visible to the API until a new version ships):

| Scope | Needed for |
|---|---|
| `application:app_slash_command` (read + write) | Slash command panel — without it, `syncSlashPanel` fails with `99991672` and the `/` list stays empty |
| `im:message` | Send and receive messages |
| `im:message:readonly` | Read message content |
| `im:message.receive_v1` event | Receive message events (Events & Callbacks → long connection) |
| `im:resource` | Upload / send images and files |
| `im:chat:read` | Group chat info (group scenarios) |
| `im:message.reactions:read` / `write_only` | Live reaction feedback |

Debug with the API directly — the console page shows **granted**, the API shows
what the **published version** carries:

```sh
# 1. token
curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}" | jq -r .tenant_access_token
# 2. slash commands (should list your commands after sync)
curl -s "https://open.feishu.cn/open-apis/application/v7/app_slash_commands?page_size=50" \
  -H "Authorization: Bearer $TOKEN"
# 3. published scopes (check application:app_slash_command is present)
curl -s "https://open.feishu.cn/open-apis/application/v6/applications/$APP_ID/app_versions?lang=zh_cn" \
  -H "Authorization: Bearer $TOKEN"
```

The slash panel sync runs on session create/resume — after granting the scope,
send the bot one message to trigger it.

## 🧭 Architecture

```
Feishu / Lark ── WebSocket 长连接 ──►  dsh-lark-bridge (dsh 进程内的 feishu-channel 插件)
   (聊天/审批/图片)                        │
                                          ▼
                     host 服务契约: agents / sessions / tools / approval /
                     goal / workspace / settings / commands
                                          │
                                          ▼
                                     DeepSeek Harness 本体
```

The bridge runs **inside the dsh process** as the `feishu-channel` plugin — it is
not a separate server. `npx @deepseek-ai/dsh web` (or `--profile chat`) boots dsh
with this plugin composed; the plugin opens the WebSocket long connection and
drives everything from there. Any launcher (shell script, systemd, supervisor)
can host it; it has no dependency on any other agent framework.

## 🛠️ Development

```sh
pnpm install
pnpm run build    # clean + tsc + tsdown (emits into lib/, committed)
pnpm test         # vitest (259 tests)
node plugin-contract-test.mjs   # standalone contract tests
```

The repo is self-contained: only published packages
(`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@larksuite/channel`) are
dependencies, no host source needed.

**Packaging notes** (why `lib/` is committed):
- Git-dependency installs (`github:user/repo`) never ran a build, and without a
  committed `lib/` the plugin failed at boot with `ERR_MODULE_NOT_FOUND` — fixed
  by committing the compiled output.
- The `prepare` hook is a safety net for source clones: it exits immediately
  when `lib/` exists and only rebuilds when it is genuinely missing.
- `build` cleans `lib/` first (tsdown itself runs `clean: false` because its
  entry points live inside the output dir).

## 📋 Known limitations

- Configuration is read once at startup; changes need a restart
- Events during a long-connection outage are not replayed (transport has no cursor)
- The Feishu app must use **long-connection** event subscription (self-built app);
  webhook mode receives no events
- `schedule_create/list/delete` tools require composing `@deepseek-ai/dsh-schedule`
  in your dsh profile (the bridge already listens for `schedule/change` and
  renders `/schedules`; the tools are the model-side half)

## 📄 License

BSD-3-Clause. Architecture inspired by [dsh-lark](https://github.com/Roy-oss1/dsh-lark) (also BSD-3-Clause).
