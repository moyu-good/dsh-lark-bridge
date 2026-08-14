# dsh-lark-bridge

[English](README.md) | 中文

Feishu/Lark IM bot channel for DeepSeek Harness: each chat (DM or group) drives
its own DSH agent; the assistant's reasoning and tool calls render as the
platform's native thinking-process message, the final answer is sent as an
ordinary message, and host approval questions become interactive cards answered
by button clicks.

Transport uses `@larksuite/channel` over a WebSocket long connection — no public
callback URL required.

## Capabilities

- **One agent per conversation.** `sessionScope` picks the granularity: the whole
  chat (`chat`), one topic thread (`chat-thread`, so parallel topics stop
  overwriting each other's context), or one sender in a shared chat
  (`chat-sender`). Session ids are stable across restarts; stored sessions are
  resumed instead of started over.
- **Two output modes.** `cot` (default) renders the process as the platform's own
  agent messages — reasoning in a thinking area, tool calls with icons, results
  as code blocks — and sends the answer as an ordinary message. `stream` keeps
  the whole turn in one typewriter card for older clients.
- **Approval cards.** Host approval questions become cards with
  「Allow once / Reject」 buttons; a click settles the question, the card is
  rewritten with the decision and who made it.
- **QR onboarding.** With no credentials configured, first boot prints a QR code;
  scanning it creates the app through the official flow (event subscription
  included), and credentials persist through the host `settings` service.
- **Slash commands.** `/stop` cancels the running turn, `/help` lists what the
  chat accepts; `syncSlashCommands` publishes the channel's commands to the
  bot's `/` panel.
- **Images (opt-in).** `attachImages` downloads chat images into the host
  attachment store so they ride the model request; off, the model still learns
  an image was sent.
- **Workspace grouping.** Chat sessions attach to a host workspace instead of
  orphaning into the GUI's Ungrouped bucket.
- **Authorization narrows, it does not gate.** `senderAllowlist` /
  `groupAllowlist` / `approvers` default to empty — the app's visibility scope
  is the outer boundary, this channel only narrows within it.
- **Deep dsh adaptation.** Everything goes through narrow host-service contracts
  (`agents` / `agentPresets` / `agentDefaultModel` / `settings` /
  `workspaceRegistry` / `loader` / `invariants` / `approval`). The package is
  self-contained and never needs a host source checkout.

## Requirements

- Node `^22.19.0 || >=24.0.0`, pnpm 11.7.
- A DeepSeek Harness deployment (`dsh` 0.1.0-rc.6+). `@deepseek-ai/cordis`
  (`^4.0.1`) is a peer dependency provided by the host.
- A Feishu or Lark tenant. The app itself can be created by the first-boot QR
  flow.
- `cot` output needs a client new enough to render thinking processes: PC 7.70,
  mobile 7.74. Older clients use `output: 'stream'`.

## Quick start

```sh
npx @deepseek-ai/dsh plugin --profile web add --allow-build=dsh-lark-bridge github:moyu-good/dsh-lark-bridge \
  && npx @deepseek-ai/dsh web
```

The console prints a QR code. Scan it with Feishu and the app is created and the
channel connects without a restart. Fill in a DeepSeek API key under
Settings → Models, then DM the bot or @ it in a group.

Already using `dsh`? Drop both `npx @deepseek-ai/` prefixes.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `appId`, `appSecret` | first-boot QR registration | Feishu/Lark app credentials. |
| `domain` | Feishu | Open-platform domain; Lark: `https://open.larksuite.com`. |
| `cwd` | host process cwd | Absolute workspace directory for chat agents. |
| `provider`, `model` | host `agentDefaultModel` | Model routing for chat agents. |
| `preset` | roster default | Agent preset chat agents join, when a roster is composed. |
| `sessionScope` | `chat` | `chat` / `chat-thread` / `chat-sender`. |
| `output` | `cot` | `cot` (native thinking process + markdown answer) or `stream` (typewriter card). |
| `showProcess` | `true` | Show reasoning and tool calls; off sends the answer alone. |
| `hideProcessWhenDone` | `false` | Let the platform hide a finished process (`cot` only). |
| `attachImages` | `false` | Pass chat images to the model. Only for routes that accept them. |
| `syncSlashCommands` | `true` | Publish the channel's commands to the bot's `/` panel. |
| `denyTools` | `['ask_user_question', 'exit_plan_mode']` | Tools chat agents may not call. |
| `requireMention` | `true` | In groups, only respond when @-mentioned. |
| `senderAllowlist` | `[]` | Open ids allowed to DM; empty serves anyone the app is visible to. |
| `groupAllowlist` | `[]` | Only these `oc_…` group chats when non-empty; empty serves any group. |
| `approvers` | `[]` | Open ids allowed to answer approvals; empty lets whoever drives the chat. |

Credentials resolve in three layers, later wins: entry config in the bundle
patch (usually `!!js process.env.FEISHU_APP_ID`) → the settings document's
plugin section → first-boot QR registration.

## Known limitations

- Configuration is read once at startup; changes need a restart.
- Events arriving while the long connection is down are not replayed (the
  transport has no cursor).
- The Feishu app must use **long-connection** event subscription
  (self-built app); webhook mode receives no events.

## Development

```sh
pnpm install
pnpm run build    # tsc + tsdown
pnpm test         # vitest
node plugin-contract-test.mjs   # standalone contract tests (no dsh build chain)
```

The repository is self-contained: it compiles against published
`@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and `@larksuite/channel`, and
never needs a host source checkout.

## License

BSD-3-Clause. Architecture inspired by
[dsh-lark](https://github.com/Roy-oss1/dsh-lark) (also BSD-3-Clause).
