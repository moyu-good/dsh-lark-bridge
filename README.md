<p align="center">
  <img src="icon.svg" width="56" alt="dsh-lark-bridge">
</p>

<h1 align="center">dsh-lark-bridge</h1>

<p align="center">
  <b>在飞书里跟一个能干活的编码 agent 说话。</b><br/>
  它跑在你自己机器上，动你的真实代码，思考过程全程可见。<br/>
  一条命令装好，扫码即用 —— 不需要公网地址，不需要服务器。
</p>

<p align="center">
  <a href="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml"><img src="https://github.com/moyu-good/dsh-lark-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@moyu-good/dsh-lark-bridge"><img src="https://img.shields.io/npm/v/@moyu-good/dsh-lark-bridge?label=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue" alt="license">
</p>

<p align="center">
  <a href="README.zh.md">中文</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-what-it-does">What it does</a> ·
  <a href="#-faq">FAQ</a>
</p>

---

## 🤔 What it does

**Who it's for** — someone with one laptop, who works over Feishu, and wants an AI agent to touch their real files. No server, no ops, no public URL.

**What it replaces** — the loop of *open the IDE → describe the task → watch it edit → switch back to chat to report*. That loop becomes one sentence in Feishu.

**Why not another bridge** — most Feishu-agent bridges hand you a bot that answers messages. This hands you an agent with a terminal, approval gates and session memory — and it shares the same session library as your DSH Desktop, so work begun in the chat is still there when you open the desktop app.

## 🧭 How it works

![Architecture: a Feishu message travels over a WebSocket long connection into the local bridge, drives one dsh agent per chat, and flows back](docs/assets/architecture.png)

- **In** — the message arrives over a WebSocket long connection. No callback URL, no reverse proxy, no public IP.
- **Through** — the bridge maps each chat (DM or group) to its own `dsh` agent, which reads and writes your real working directory.
- **Back** — thinking, approval requests and results return to the chat as native Feishu messages.
- **Shared** — the `web` and `desktop` runtime forms share one `~/.dsh` session library.

![Arbitration: a cloud ledger keyed per endpoint keeps one instance answering while the other stands by](docs/assets/arbitration.png)

A cloud ledger keyed per endpoint (`deviceId` + `form` + `profile`) keeps one instance per endpoint answering and elects a successor when the active one goes quiet. Both forms read and write the same sessions, so failing over never loses the conversation.

## ✨ Three things most bridges don't do

### Runs on your machine, in minutes, with no public address

One `pnpm dlx` command installs the plugin and boots the host; a QR code is the whole credential flow. The transport is an outbound WebSocket long connection — nothing has to reach you from the internet.

### You can see what it's thinking

Reasoning renders as Feishu's own *thinking* message. Tool calls arrive with their icon and the first lines of their result; the full output stays in the session log. Every turn closes with one plain line — how many tool calls it made, how long it took. Nothing has to be taken on faith. A message you send mid-turn lands in there too, right before the step it redirected.

### A long task is not "fire and forget"

Send a message while a turn is running and it follows `busyPolicy`: `queue` waits its turn, `steer` takes over at the next step boundary **without discarding work already done**, `inject` adds context without waking the driver. Risky operations become approval cards. Turn on `autoResumeGoals` and a goal picks itself back up after a restart.

## 🚀 Quick Start

**Prerequisites:** Node 22.19+ or 24+, [pnpm](https://pnpm.io/installation), a DeepSeek API key, Feishu on your phone.
**Harness:** dsh `>= 0.2.1-rc.1 < 0.3.0` (declared as `engines.dsh` in `package.json`).

```sh
# 1. install the plugin into a dsh profile and boot
pnpm dlx @deepseek-ai/dsh plugin --profile web add @moyu-good/dsh-lark-bridge \
  && pnpm dlx @deepseek-ai/dsh web

# 2. a QR code prints → scan it with Feishu
#    (this creates the app and its event subscription for you)

# 3. open the dsh console → Settings → Models → paste your DeepSeek API key

# 4. DM the bot, or @ it in a group. That's it.
```

Two traps, both real:

- **Use `pnpm`, not `npx`.** On one machine this was recorded at about 20 seconds versus about 25 minutes (npm's serial reify), and on a ≤4 GB machine the npm process died with "JavaScript heap out of memory" mid-install. Those are the author's numbers, not a benchmark this repository reproduces — treat the gap as *large*, not as *exactly 20 vs 25*.
- **Do not `npm i -g dsh-lark-bridge`.** That name on npm belongs to an unrelated project. This one is **`@moyu-good/dsh-lark-bridge`**.

<details>
<summary>First install fails on <code>protobufjs</code>? — two-minute fix</summary>

pnpm 10 blocks dependency build scripts by default and exits non-zero with `ERR_PNPM_IGNORED_BUILDS`. The blocked script belongs to `protobufjs` (a Feishu SDK dependency); it only prints a version-scheme warning — no file written, no network.

Open `<your-home>/.dsh/profiles/web/pnpm-workspace.yaml` and set `protobufjs: false` under `allowBuilds`. After the failed install pnpm writes the literal text `set this to true or false` there — replace it with `false`. Then **re-run the same command**: a failed install leaves the profile half-configured (bundles are not merged when the install exits non-zero), so editing the file alone does not finish the job.

`allowBuilds` (pnpm 10.26+) is the only key pnpm reads for this; `onlyBuiltDependencies` and the other legacy keys were removed in pnpm 11.

</details>

## 🎯 Three commands to try first

| Command | What you get |
|---|---|
| `/manual` | The full eight-section user guide, delivered in the chat |
| `/balance` | Live DeepSeek balance, per currency and timestamped, with the current peak/off-peak phase |
| `/bot devices` | Which endpoints are in the fleet, and which one is currently answering |

Daily ops: run `pnpm dlx @deepseek-ai/dsh web` again (subsequent runs hit the pnpm store), or host it under systemd / supervisor. The package ships **prebuilt** — nothing compiles on install.

<details>
<summary>💬 All capabilities</summary>

| | |
|---|---|
| 🗂️ **One agent per conversation** | `sessionScope`: whole chat / topic thread / single sender; sessions persist across restarts |
| 🧠 **Native Feishu CoT** | Reasoning renders as the platform's own thinking message (`cot`), typewriter card fallback (`stream`) |
| ✅ **Live reactions** | `OK` → `THINKING` → `DONE`/`ERROR`, states replace each other, configurable |
| 📋 **Approval cards + decider trail** | Click to decide; who decided is written back |
| 🎯 **Live goal / todo cards + auto-resume** | Phase changes stream into chat; `autoResumeGoals` (opt-in) re-arms after restarts |
| ✋ **Mid-turn steering** | `busyPolicy`: `queue` (default) waits its turn, `steer` takes over at the next step boundary without discarding the work, `inject` adds context without waking the driver |
| 📦 **Compaction transparency** | "Compacting…" → summary + released tokens; prunes report trimmed count |
| 🧑‍💻 **Subagent fan-out** | Workflow runs stream as text lines: run start, child open/end, run end |
| 👥 **Team panel** | When the host runs a team, one card shows the members, shared tasks and messages between them, updated in place |
| 🔍 **Session history search** | `/sessions <keyword>` full-text search over this chat's stored history |
| 🌐 **Multi-surface fleet sync** | `web` and `desktop` forms share one session library; per-endpoint cloud arbitration (`deviceId:form:profile`) — no double replies, automatic failover election |
| 🔄 **Interactive account switcher** | `/bot account` stores/switches/forgets Feishu-app credentials from a card; shared settings push it to every surface |
| 💰 **Balance & peak/off-peak awareness** | `/balance` live DeepSeek balance (per currency, timestamped); the prompt embeds the tariff table so batch work lands in half-price windows |
| 🛠️ **Native Feishu agent tools** | `feishu_notify` proactive messages, `feishu_drive_*` cloud-drive scratchpad reachable from any device |
| 🖥️ **Self-healing slash panel** | The panel has a single writer (the arbitration-active endpoint), bilingual, kept in step with what actually runs |
| 🧰 **Capability inventory** | `/tools` lists what this deployment can actually do — the visible tools and the MCP servers it talks to |
| 🎙️ **Media delivered in kind** | An ogg/opus recording arrives as a voice note, an mp4/m4v clip as a video — playable in the chat, not a download link |
| 🖼️ **Image input (opt-in)** | `attachImages` passes chat images to the model |
| 🕐 **Message timestamps** | showMessageTime (default on) stamps each inbound message and each quoted message with its local send time; set it to `false` to leave the text alone |
| ⏱️ **Time is visible, both ways** | Every tool call in the thinking process carries the clock time it started and every result over 1s carries its elapsed time; the closing line names the slowest step. The model is told each turn's current time and how long the chat had been quiet — so "继续" after eight hours and "继续" after three minutes are not the same instruction |
| 📎 **File delivery** | Agent `send_file` delivers artifacts with caption (default-deny local dirs) |
| 🔒 **Authorization narrowing** | `senderAllowlist` / `groupAllowlist` / `approvers` |
| ⏰ **Scheduled reminders** | `/schedules` view (compose `@deepseek-ai/dsh-schedule` for the model-side tools) |
| ⚙️ **Background job notifications** | `run_in_background` jobs announce their terminal outcome |
| 🧩 **Skill ecosystem surface** | `/skills` lists workspace skills, `/skills <name>` peeks at one |
| 🤖 **Model switching** | `/model <provider>/<model>` through the host `saveSelection` seam (persistent) |
| 🖥️ **PC-parity tooling** | Compose `dsh-terminal*` / `code-runtime-worker-thread` / `dsh-mcp-client` → persistent PTY, Code Mode, external MCP servers |
| 🗺️ **Workspace visibility** | `/ws` lists workspaces and marks where new sessions land |
| 🔑 **QR onboarding** | First boot prints a QR; scanning creates the app with event subscription |
| 🧩 **Chronicle hook** | `chronicleEndpoint`: fire-and-forget POST per accepted inbound **user** message (`source`/`text`/`chatId`); the bridge's replies never go to the ledger |

</details>

<details>
<summary>⌨️ Slash commands</summary>

Type `/help` in the chat for the live list.

| Command | Description |
|---|---|
| `/stop` | Cancel the running turn |
| `/new` | Start a new session (`/clear` is an alias) |
| `/manual` | The full user guide (start here if you're new) |
| `/sessions` | Search this chat's session history |
| `/session` | Everything about the session this chat is talking to: id, directory, the model route actually used, log size, context tokens and distance to the warning line, preset and busy policy |
| `/balance` | DeepSeek API balance, with the live peak/off-peak phase |
| `/tools` | View / deny / allow tools at runtime |
| `/skills` | List skills, or peek at one |
| `/model` | View / switch the default model (reaches sessions created after the switch) |
| `/think` | View / change THIS session's reasoning effort — applies to the next request |
| `/config` | The bridge's live configuration |
| `/plugins` | List deployed plugins and status |
| `/ws` | List registered workspaces |
| `/jobs` | This chat's background jobs |
| `/schedules` | This chat's scheduled reminders |
| `/context` | Current context token pressure |
| `/audit` | Operation audit summary |
| `/feedback` | Rate the last answer |
| `/preset` | View / switch agent preset (standard / code / minimal / cordis) |
| `/permission` | View / switch permission mode (host) |
| `/goal` | View / set the goal (host) |
| `/plan` | Enter / leave plan mode (host) |
| `/compact` | Compact older history (host) |
| `/bot` | Bridge admin: status, settings, accounts, plugin sync, devices |
| `/restart` | Restart the host process (only when the deployment wires it) |
| `/help` | Show the listing |

Set `locale: zh|en` to pin the slash-panel and help wording; otherwise it follows the platform domain. It does not translate what the agent says.

**`/bot` subcommands**: `set` / `unset` / `peers` / `sync-plugins` / `account` (save·use·forget, interactive card) / `export` / `import` / `devices` / `retire` / `activate` / `name`.

</details>

<details>
<summary>⚙️ Configuration & required permissions</summary>

| Field | Default | Meaning |
|---|---|---|
| `appId`, `appSecret` | first-boot QR registration | Feishu/Lark app credentials |
| `cwd` | host process cwd | Absolute workspace directory for chat agents |
| `provider`, `model` | host default | Model routing for chat agents |
| `output` | `cot` | Native thinking message vs typewriter card |
| `requireMention` | `true` | In groups, respond only when @-mentioned |
| `outbound.allowedFileDirs` | unset → disabled | Local dirs `send_file` may read from |
| `chronicleEndpoint` | `''` | Optional external ledger: one POST per accepted inbound user message |
| `announceSubagents` | `true` | Announce a delegation in the chat when it is made |
| `autoResumeGoals` | `false` | Re-arm an active goal after a restart — off unless you turn it on |
| `restartCommand` | unset → `/restart` unavailable | Command that restarts the host; runs in a detached child after 2.5 s (POSIX `sh`, Windows PowerShell) |

Credentials resolve in three layers: bundle patch config → settings document plugin section → first-boot QR registration.

<details>
<summary>Required app scopes (manual app creation only)</summary>

| Scope | Needed for |
|---|---|
| `application:app_slash_command` (read + write) | Slash panel — without it sync fails with `99991672` |
| `im:message` / `im:message:readonly` | Send / read messages |
| `im:message.receive_v1` event | Receive messages (Events → long connection) |
| `im:resource` | Upload images and files |
| `im:chat:read` | Group info |
| `im:message.reactions:read` / `write_only` | Reaction feedback |
| **`drive:drive`** | `/bot export --to-feishu`, `feishu_drive_*`, cloud arbitration |

QR onboarding grants these automatically; manually created apps must publish a new version after adding scopes. Panel sync runs on session create/resume — send the bot one message after granting.

</details>

</details>

<details>
<summary>📦 Moving to a new machine</summary>

The bridge carries its own migration path. On the old machine:

```text
/bot export include-secrets --to-feishu   # uploads to the app's own Feishu drive
/bot export include-secrets               # or a local file, credentials masked
```

The Feishu route needs no copying: the file lands in the app's own cloud space, and the new machine pulls it with `/bot import --from-feishu`. For the local route, copy the printed file to the same path on the new machine, install the plugin there, then:

```text
/bot import                       # preview: settings + plugin plan + warnings
/bot import apply                 # execute (add --from-feishu for the cloud slot)
```

What travels: shared settings and per-profile plugin lists. What never travels: peer heartbeats, control tokens, `node_modules`, session history.

Session history lives under `~/.dsh`. To carry it across, copy the session directories **only**:

```text
~/.dsh/sessions/     # the conversations themselves
~/.dsh/storages/     # session projection cache and workspace index
```

**Do not copy the whole of `~/.dsh`.** `~/.dsh/dsh-lark-bridge/device-state.json` holds this machine's `deviceId` and its retired flag — a copy would give the new machine the old machine's identity (both would answer the same chat) and could carry the retired flag along.

**Device lifecycle** — every machine mints a stable `deviceId` on first boot; `/bot devices` shows the roster. Instead of stopping the old service by hand, retire it: `/bot retire` puts it out of the reply path (messages get a one-line notice, not an agent turn); `/bot activate` brings it back. Every live machine renews its presence each minute, and if the active one goes silent, the freshest endpoint with the lowest endpoint key wins the election on the next inbound message. `/bot name <readable-name>` names a device for the roster.

</details>

<details>
<summary>❓ FAQ</summary>

<details>
<summary>Do I need a public IP or webhook?</summary>

No. The transport is a WebSocket long connection; the app must use long-connection event subscription (self-built app).

</details>

<details>
<summary>I have DSH Desktop and the web host — will they both answer?</summary>

No. Both share one `~/.dsh` session library, and cloud arbitration is keyed per endpoint (`deviceId:form:profile`): exactly one instance replies per endpoint at any moment, and if the active one goes silent the freshest endpoints elect a successor on the next message. `/bot devices` shows who.

</details>

<details>
<summary>Which models work?</summary>

Any model routable by your dsh deployment — the bridge is model-agnostic, and `/model` switches at runtime.

</details>

<details>
<summary>The agent says it sent a file but nothing arrives</summary>

File delivery is default-deny: configure `outbound.allowedFileDirs`. URLs and raw buffers always work.

</details>

<details>
<summary>The web console returns 401 when I open it directly</summary>

Each launch mints a new token, so a browser without the cookie gets 401. Open the full `http://127.0.0.1:18787/?token=…` URL the launcher prints once — that sets a long-lived cookie, after which the plain address works.

</details>

<details>
<summary>The slash panel is empty or partial after a restart</summary>

Boot registers constant commands; the full panel sync runs on the first message of a session. Send the bot anything. If it stays empty, check the `application:app_slash_command` scope and publish an app version.

</details>

<details>
<summary>How do I switch to a different Feishu app?</summary>

`/bot account save <name>` archives the current credentials; later `/bot account` and tap **Use** on the card, then `/restart` (web) or restart Desktop. Multiple credential sets can live side by side.

</details>

<details>
<summary>What survives a restart?</summary>

Sessions resume from their logs; permission and preset choices ride with the session state. Active goals re-arm only if you set `autoResumeGoals: true` (it defaults to false).

</details>

</details>

<details>
<summary>⚠️ Known limitations</summary>

- **The desktop form lacks question cards.** `hostQuestions` is not available in the `desktop` runtime form; the `web` form is unaffected.
- **Transport-level config is read once at startup.** Credentials, `requireMention` and allowlists need a restart; other config edits hot-reload via dsh's Config-only HMR (`/config` shows live values).
- **Events during a long-connection outage are not replayed** (no cursor); outbound sends are queued by the replay port.
- **`schedule_*` model tools** need `@deepseek-ai/dsh-schedule` composed in your profile.
- **File sending is deny-by-default** — directories must be listed in outbound.allowedFileDirs first. A refused send now says so in the chat instead of leaving only a caption behind.
- **How much of a long thing reaches the chat is a budget, not a constant** — tool results, tool arguments, mid-turn messages, quotes, job-output tails, approval-card arguments and /skills previews all read from the limits section; the defaults are sized for a working session, and every cap is adjustable.
- **Two processes sharing one endpoint key will both answer.** Arbitration compares the endpoint key (`deviceId` + `form` + `profile`); a `dsh web` process and a bare CLI process on the same machine and profile produce the same key, so neither sees the other as a rival. Run one host process per profile.

</details>

## 🧩 Extend it

Three invariants keep the bridge maintainable:

1. **Grafted channel, not re-integration** — the bridge only normalizes messages; every capability comes from official opt-in dsh plugin families composed in your profile. Zero bridge code = zero upgrade cost when upstream ships features.
2. **Everything through host service contracts** — `agents`, `agentPresets`, `approval`, `goals`, `settings`… self-contained against published packages only.
3. **Every change archives a design card first** — see [`docs/design/`](docs/design/README.md).

Repo map, the branch/MR flow and the version policy live in **[CONTRIBUTING.md](CONTRIBUTING.md)**. The gates CI runs on every push:

```sh
pnpm hygiene                    # repo hygiene (deployment terms stay local)
pnpm test                       # 704 tests in 70 spec files
pnpm contract-test              # 43 host-contract checks
pnpm contract-drift             # drift check against upstream dsh master
node scripts/check-readme-parity.mjs   # the two READMEs stay in step
```

The suite lives in `tests/` — vitest suites (70), including harness-based fakes. Upgrading the harness: run `pnpm contract-drift` before and after — it fails when a host seam the bridge mirrors has moved.

## 🤝 Contributing

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to get a change in.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability. Please do not open a public issue for it.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — how people are expected to treat each other here.
- **Issue templates** — under [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE). A report that fills in the environment section is answered faster.

Listed in 9 plugin directories, including [dshbase (verified)](https://dshbase.com/plugins/moyu-good-dsh-lark-bridge/). Most directories read the version from npm; **the repository tag is the truth** — install from npm (`@moyu-good/dsh-lark-bridge`) or straight from a tag.

## 📄 License

BSD-3-Clause. Architecture inspired by [dsh-lark](https://github.com/Roy-oss1/dsh-lark) (also BSD-3-Clause).
