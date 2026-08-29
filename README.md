<p align="center">
  <a href="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml"><img src="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-293%20passing-brightgreen" alt="tests">
  <a href="https://dshbase.com/plugins/moyu-good-dsh-lark-bridge/"><img src="https://img.shields.io/badge/dshbase-verified-blue" alt="dshbase verified"></a>
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
  <img src="https://img.shields.io/badge/transport-WebSocket%20long--connection-orange" alt="transport">
</p>

<h1 align="center">🕊️ dsh-lark-bridge</h1>

<p align="center">
  <b>Run a full DeepSeek Harness coding agent inside Feishu / Lark</b><br/>
  <i>Native thinking process · approval cards · live goal/todo cards · subagent fan-out ·
  bilingual slash panel — no public webhook URL needed.</i>
</p>

<p align="center">
  <a href="README.zh.md">中文文档</a> ·
  <a href="#-quick-start-in-60-seconds">Quick Start</a> ·
  <a href="#-features">Features</a> ·
  <a href="#-extend-it">Extend It</a> ·
  <a href="#-faq">FAQ</a>
</p>

---

## 🤔 What is this?

`dsh-lark-bridge` is a **Feishu/Lark IM channel for DeepSeek Harness** — a plugin that makes
your coding agent work right inside a chat. Each conversation (DM or group) drives its own
dsh agent, and everything the desktop UI shows lives in the chat:

- 🧠 **Native thinking process** — reasoning renders as Feishu's own "thinking" message;
  tool calls with icons, results as code blocks. No black box.
- ✅ **Interactive approval cards** — risky operations become Allow-once / Deny cards,
  decision and decider written back.
- 🎯 **Live goal & todo cards** — long-running tasks update a card in real time instead of
  going silent; goals auto-resume after restarts.
- 🔌 **WebSocket long connection** — no public callback URL, no reverse proxy.

Feishu is the carrier; the work is still done by DeepSeek Harness itself.

## 🚀 Quick Start in 60 Seconds

**Prerequisites:** Node 18+, a DeepSeek API key, and the Feishu app on your phone.

```sh
# 1. install the plugin into a dsh profile & boot
npx @deepseek-ai/dsh plugin --profile web add github:moyu-good/dsh-lark-bridge \
  && npx @deepseek-ai/dsh web

# 2. a QR code prints → scan it with Feishu
#    (this creates the app + event subscription automatically)

# 3. open the dsh console → Settings → Models → paste your DeepSeek API key

# 4. DM the bot, or @ it in a group. That's it.
```

> [!WARNING]
> **Do NOT** `npm i -g dsh-lark-bridge` — that name on npm belongs to an
> unrelated project. Our package is installable from this GitHub repo today;
> a scoped npm release (`@moyu-good/…`) is planned.

Daily ops: run `npx @deepseek-ai/dsh web` again, or host it under systemd/supervisor.
The package ships **prebuilt** (`lib/` committed) — nothing compiles on install.

## ✨ Features

Highlights — the ones other bridges don't have:

| | |
|---|---|
| 🧠 **Native Feishu CoT** | Reasoning renders as the platform's own thinking message (`cot`), typewriter card fallback (`stream`) |
| 📋 **Approval cards + decider trail** | Click to decide; who decided is written back |
| 🎯 **Live goal / todo cards + auto-resume** | Phase changes stream into chat; `autoResumeGoals` re-arms after restarts |
| 🔍 **Session history search** | `/sessions <keyword>` full-text search over this chat's stored history |
| 🌐 **Bilingual slash panel** | English on international Lark, Chinese on domestic Feishu — auto |

<details>
<summary><b>All capabilities</b></summary>

| | |
|---|---|
| 🗂️ One agent per conversation | `sessionScope`: whole chat / topic thread / single sender; sessions persist across restarts |
| ✅ Live reactions | `OK` → `THINKING` → `DONE`/`ERROR`, states replace each other, configurable |
| 📦 Compaction transparency | "Compacting…" → summary + released tokens; prunes report trimmed count |
| 🧑💻 Subagent fan-out | Workflow runs stream as text lines: run start, child open/end, run end |
| ⏰ Scheduled reminders | `/schedules` view (compose `@deepseek-ai/dsh-schedule` for the model-side tools) |
| ⚙️ Background job notifications | `run_in_background` jobs announce their terminal outcome |
| 🧩 Skill ecosystem surface | `/skills` lists workspace skills, `/skills <name>` peeks at one |
| 🤖 Model switching | `/model <provider>/<model>` through the host `saveSelection` seam (persistent) |
| 🖥️ PC-parity tooling | Compose `dsh-terminal*` / `code-runtime-worker-thread` / `dsh-mcp-client` → persistent PTY, Code Mode, external MCP servers |
| 🗺️ Workspace visibility | `/ws` lists workspaces and marks where new sessions land |
| 🖼️ Image input (opt-in) | `attachImages` passes chat images to the model |
| 📎 File delivery | Agent `send_file` delivers artifacts with caption (default-deny local dirs) |
| 🔑 QR onboarding | First boot prints a QR; scanning creates the app with event subscription |
| 🔒 Authorization narrowing | `senderAllowlist` / `groupAllowlist` / `approvers` |
| 🧩 Chronicle hook | `chronicleEndpoint`: fire-and-forget full-transcript POST per inbound message |
| 🛡️ Deep dsh adaptation | Everything through host service contracts — self-contained, no host source needed |

</details>

### vs. other Feishu/Lark bridges

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
| Session history search + skills/model/ws panels | ✅ | — | — | — |

## 💬 Slash Commands

| Command | Description |
|---|---|
| `/stop` | Cancel the running turn |
| `/help` | Show this listing |
| `/preset` | View / switch agent preset (standard / code / minimal / cordis) |
| `/permission` | View / switch permission mode (host) |
| `/goal` | View / set the goal (host) |
| `/plan` | Enter / leave plan mode (host) |
| `/compact` | Compact older history (host) |
| `/sessions` | Search this chat's session history |
| `/tools` | View / deny / allow tools at runtime |
| `/skills` | List skills, or peek at one |
| `/model` | View / switch the default model |
| `/ws` | List registered workspaces |
| `/jobs` | This chat's background jobs |
| `/schedules` | This chat's scheduled reminders |
| `/context` | Current context token pressure |
| `/audit` | Operation audit summary |
| `/config` | The bridge's live configuration |
| `/feedback` | Rate the last answer |

Set `locale: zh|en` to force a language; otherwise it follows the platform domain.

## ⚙️ Configuration

Essentials:

| Field | Default | Meaning |
|---|---|---|
| `appId`, `appSecret` | first-boot QR registration | Feishu/Lark app credentials |
| `cwd` | host process cwd | Absolute workspace directory for chat agents |
| `provider`, `model` | host default | Model routing for chat agents |
| `output` | `cot` | Native thinking message vs typewriter card |
| `requireMention` | `true` | In groups, respond only when @-mentioned |
| `outbound.allowedFileDirs` | unset → disabled | Local dirs `send_file` may read from |
| `chronicleEndpoint` | `''` | Optional external full-transcript ledger |

Full option reference: [README.zh.md 配置](README.zh.md#️-配置) · credentials resolve in three
layers (bundle patch config → settings document plugin section → first-boot QR registration).

<details>
<summary><b>Required app permissions (manual app creation)</b></summary>

| Scope | Needed for |
|---|---|
| `application:app_slash_command` (read + write) | Slash panel — without it sync fails with `99991672` |
| `im:message` / `im:message:readonly` | Send / read messages |
| `im:message.receive_v1` event | Receive messages (Events → long connection) |
| `im:resource` | Upload images and files |
| `im:chat:read` | Group info |
| `im:message.reactions:read` / `write_only` | Reaction feedback |

QR onboarding grants these automatically; manually created apps must publish a new
version after adding scopes. Panel sync runs on session create/resume — send the bot
one message after granting.

</details>

## 🧭 Architecture

```
Feishu / Lark ── WebSocket long connection ──►  dsh-lark-bridge (feishu-channel plugin
   (chat/approval/images)                        INSIDE the dsh process)
                                                      │  host service contracts:
                                                      │  agents / sessions / tools /
                                                      ▼  approval / goal / settings
                                              DeepSeek Harness itself
```

Any launcher works (shell, systemd, supervisor) — no dependency on any other agent framework.

## 🧩 Extend It

Three invariants keep the bridge maintainable:

1. **Grafted channel, not re-integration** — the bridge only normalizes messages; every
   capability comes from official opt-in dsh plugin families composed in your profile.
   Zero bridge code = zero upgrade cost when upstream ships features.
2. **Everything through host service contracts** — `agents`, `agentPresets`, `approval`,
   `goals`, `settings`… self-contained against published packages only.
3. **Every change archives a design card first** — see [`docs/design/`](docs/design/README.md);
   implementation notes are backfilled, and blocked investigations are archived as assets too.

**Repo map**

```
src/
  bridge.ts        message pipeline: normalize → authorize → ack → agent turn → render
  commands.ts      slash commands (i18n bilingual)
  cot.ts outbound.ts  thinking-process & answer rendering
  chronicle.ts     optional external-ledger ingest hook (integration example)
  config.ts        schema + defaults
tests/             vitest suites (293) incl. harness-based fakes
scripts/           verify-dsh-contract.mjs — asserts no drift vs upstream master
plugin-contract-test.mjs   43 assertions on the host contract surface
```

**Quality gates**

```sh
pnpm test                        # 293 unit/integration tests
node plugin-contract-test.mjs    # 43 host-contract assertions
node scripts/verify-dsh-contract.mjs   # drift check against upstream master
pnpm typecheck && pnpm run build # tsc + tsdown (lib/ is committed)
```

CI runs all of the above on every push and pull request, with the upstream drift check
pinned to dsh master — if upstream changes a contract, the build tells you before users do.

**Adding a feature?** Write the design card first (template in `docs/design/`), implement,
backfill the change record. For an integration that only needs message visibility, prefer
the `chronicleEndpoint` hook over modifying the pipeline — see `src/chronicle.ts`.

## 📦 Release & Upgrade Policy

Two tracks, deliberately:

| Track | Follows | Used for |
|---|---|---|
| **preview** | the latest upstream — incl. prereleases (`alpha` / `rc`) from GitHub releases or `master` | development, experiments, validating new capabilities |
| **stable** | the pinned stable line (npm dist-tag `latest`, final `rc`s) | production deployments facing real users |

**Rules**

1. New upstream capability is assessed on the **preview** track first: bring it
   into the development copy, run `node scripts/verify-dsh-contract.mjs` against
   the target version, exercise the feature, and only promote to **stable** after
   the quality gates below are green.
2. A production deployment never rides an `alpha` release. Stable deployments pin
   the stable line and upgrade deliberately, by the runbook, each time.
3. This repo follows the same policy: `main` tracks upstream `master` for contract
   compatibility (CI pins the drift check to upstream master); tagged releases
   (`@moyu-good/dsh-lark-bridge@<version>`) are the stable artifacts.
4. Upstream changed a host contract → the drift check turns red **before** users
   see it. Treat that red build as the upgrade signal, not as noise.

**Quality gates before promotion**: `pnpm test` → `node plugin-contract-test.mjs` →
`node scripts/verify-dsh-contract.mjs` → `pnpm typecheck && pnpm run build` →
real-loop smoke on the target deployment.

## ❓ FAQ

<details>
<summary><b>Do I need a public IP or webhook?</b></summary>
No. The transport is a WebSocket long connection; the app must use long-connection event
subscription (self-built app).
</details>

<details>
<summary><b>Which models work?</b></summary>
Any model routable by your dsh deployment — the bridge is model-agnostic and `/model`
switches at runtime.
</details>

<details>
<summary><b>The agent says it sent a file but nothing arrives</b></summary>
File delivery is default-deny: configure <code>outbound.allowedFileDirs</code>. URLs and
raw buffers always work.
</details>

<details>
<summary><b>The slash panel is empty or partial after a restart</b></summary>
Boot registers constant commands; the full panel sync runs on the first message of a
session. Send the bot anything. If it stays empty, check the
<code>application:app_slash_command</code> scope and publish an app version.
</details>

<details>
<summary><b>What survives a restart?</b></summary>
Sessions resume from their logs; active goals re-arm (<code>autoResumeGoals</code>);
permission and preset choices ride with the session state.
</details>

## 🌍 Listings & Community

- [dshbase.com](https://dshbase.com/plugins/moyu-good-dsh-lark-bridge/) — listed & **verified**
  (headless L3: install + load + Q&A) · [中文页](https://dshbase.com/zh/plugins/moyu-good-dsh-lark-bridge/)
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2160) — merged
- [dsh-suite catalog](https://github.com/whyihaveyou/dsh-suite/issues/32) — accepted (orchestration)

Issues and PRs welcome — design cards first, please.

## 📋 Known limitations

- Transport-level config (credentials, requireMention, allowlists) is read once at startup;
  other config edits hot-reload via dsh Config-only HMR (`/config` shows live values)
- Events during a long-connection outage are not replayed (no cursor); outbound sends are
  queued by the replay port
- `schedule_*` model tools need composing `@deepseek-ai/dsh-schedule` in your profile

## 📄 License

BSD-3-Clause. Architecture inspired by [dsh-lark](https://github.com/Roy-oss1/dsh-lark) (also BSD-3-Clause).
