# Changelog

All notable changes to dsh-lark-bridge are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.1] — 2026-09-13

### Fixed
- **Stalls are now bounded or self-reporting.** Three different causes shared
  one symptom — the message is acknowledged with a reaction and then nothing
  happens, with no reply, no error and no log until the process is restarted:
  - `briefing`: the prefix was read with `readFileSync`. The file can live on
    a bridged filesystem, where a synchronous read blocks the whole event
    loop for as long as the read takes. Now async.
  - `runtime`: `addReaction`/`removeReaction` had no deadline. Reactions are
    cosmetic and must never hold up a turn; both now time out at 10s.
  - `sync/feishu-cloud`: every drive/auth call now carries a 15s deadline.
  - `bridge`: one log line per inbound message, plus a report from any stage
    that overruns 10s, so a stall names where it is instead of being inferred.
- **`journey/e2e-fleet.mjs`** resolved the sync lib from an absolute checkout
  path, so it could not run anywhere but the machine that wrote it. Now
  resolved relative to the script.

### Added
- **`scripts/check-repo-hygiene.mjs`** — the hygiene scan the MR flow requires,
  shipped in the repository. It covers machine-specific paths and pasted
  credentials, and takes deployment-specific terms from a local
  `.leak-patterns` file (gitignored) or the `REPO_HYGIENE_PATTERNS` secret in
  CI. The term list deliberately stays out of the repo: a committed list of
  what to avoid is itself the leak.
- **Release workflow** — a `v*` tag runs the same gate as CI, checks that the
  tag agrees with `package.json`, and publishes the CHANGELOG section as the
  release notes.
- `pnpm hygiene` runs the scan locally.

### Changed
- Hygiene now runs first in CI, before the build: a leaked path or credential
  is the one failure a follow-up commit cannot undo.

## [0.8.0] — 2026-09-10

### Added
- **Cross-surface mirror (W-11)**: assistant turns initiated from the web UI
  or desktop surface of the same harness process — outside the bridge's own
  pipeline — are now mirrored into the bound Feishu chat at turn end, with a
  `🌐【web】` surface marker and a 3000-char cap. Feishu-originated messages
  were always shared through the session library; this closes the reverse
  direction (web → Feishu), the last leg of "send from either side, both
  sides see it" (2026-09-10 user report).

## [0.7.6] — 2026-09-10

### Fixed
- **Standby endpoints back off silently**: with web + desktop both connected,
  the standby bridge posted a "活跃端是 XX，本端已退避" chat line on EVERY
  inbound message — from a phone client this reads as the bot answering to
  itself (2026-09-10 user report). Standby now steps down quietly (operator
  console only); the roster stays on `/bot devices`.

## [0.7.5] — 2026-09-09

### Added
- **`/manual`** — the full user guide, in chat: what the bot is, daily usage,
  every command with categories, the account-switch flow, fleet/device
  management, billing phases, and troubleshooting. Source of truth is
  `src/user-guide.ts`; `docs/用户手册.md` mirrors it for repo readers (a
  sync test keeps them in step). The first-contact guide now points new
  users at `/manual`.

## [0.7.4] — 2026-09-09

### Added
- **`/balance`** — query the DeepSeek open-platform balance the deployment
  bills through (`DEEPSEEK_API_KEY` in the process env; the web deploy
  exports it in `run-dsh-web.sh`). Verified against the live endpoint
  (2026-09-09): per-currency totals with the granted/topped-up breakdown
  shown only when non-zero, service availability, the query moment in
  Beijing time, and the live peak/off-peak phase. Panel + `/help` entry
  included.

## [0.7.3] — 2026-09-09

### Added
- **Interactive account-switcher card**: `/bot account` with a non-empty
  roster now renders a card — every saved account with 使用 / 忘记 buttons,
  so switching is two taps instead of typing a name. Card clicks pass the
  fleet single-writer gate (standby endpoints ignore with a toast) and the
  operator authorization check before running the same switch/forget the
  text command runs; the result lands as a toast plus a chat line, and
  secrets never reach card markup.

### Changed
- `CommandOutcome` may carry an interactive card; empty reply + card means
  the card is the whole answer.

## [0.7.2] — 2026-09-09

### Added
- **Peak/off-peak billing awareness** (`src/pricing.ts`): DeepSeek's official
  API bills weekday-morning/afternoon hours (Beijing 9:00–12:00, 14:00–18:00)
  at DOUBLE the off-peak rate — lunch breaks, evenings, and weekends are all
  half price (verified against the official pricing page, 2026-09-09). The
  live phase is computed in Asia/Shanghai wall clock and surfaces in two
  places: a model prompt section (`dsh-lark-bridge:pricing`) with the rule,
  the current phase, and the "schedule deferrable heavy work off-peak" nudge;
  and one human-facing line in the first-contact guide.

## [0.7.1] — 2026-09-09

### Fixed
- **Slash-panel single writer**: the panel belongs to the Feishu APP, and a
  fleet shares one app — web and desktop both booting rewrote it with their
  own (differently composed) host command sets, so the menu stopped matching
  whichever endpoint actually executes the commands. Only the arbitration's
  active endpoint now syncs the panel; standbys skip with a console line and
  re-sync once promoted (election or `/bot activate`).
- `/bot` panel/help description now enumerates its subcommands (set · unset ·
  peers · sync-plugins · account · export · import · devices · retire ·
  activate · name) instead of the vague two-word summary.

### Added
- **Identity in the first line of the prompt**: the bridge fetches the app's
  real display name from Feishu (`bot/v3/info`, `FeishuCloud.botInfo()`) and
  leads the model's identity section and the first-contact guide with it,
  plus which fleet endpoint is answering (`「MyBot」（本端：web · web）`).
  Asked "who are you", the model now quotes the name the human sees in the
  chat header instead of inventing one.

## [0.7.0] — 2026-09-09

### Added
- **Desktop form auto-detection**: the Desktop 2.0.0 app hosts the harness
  inside its Electron main process and sets no `DSH_*` environment, so the
  form/profile were wrong (or needed manual env wiring). `detectRuntimeForm()`
  keys on the Electron runtime marker; `DSH_FORM` keeps override priority, and
  the profile defaults to `desktop` on the desktop form. The desktop side can
  now join the fleet with zero environment setup.
- **Endpoint-scoped fleet arbitration**: the cloud arbitration active slot and
  the presence ledger are keyed by `deviceId:form:profile` instead of the bare
  deviceId. One machine running web AND desktop holds two Feishu connections;
  a machine-only check let both answer every message twice. Pre-0.7 documents
  fall back to machine + recorded form, so an old arbitration file upgrades
  in place without a silent double-reply window. Election, `/bot activate`,
  `/bot devices`, and the inbound backoff notice are all endpoint-aware.
- **`/bot account save|use|forget`** — named Feishu-app credential sets in the
  shared sync directory (`accounts.json`, secrets at rest, masked in every
  reply). Switching accounts is one command instead of two `/bot set` calls
  with a pasted secret; the transport keys land in the shared settings so the
  normal restart path picks them up on both forms.
- **Native Feishu agent tools** (registered per chat agent next to
  `send_file`, with a prompt section): `feishu_notify` (proactive message
  into the current chat or an explicit `chat_id`, riding the replay-wrapped
  transport), `feishu_drive_write` / `feishu_drive_read` /
  `feishu_drive_list` (the app cloud-drive space as a durable cross-device
  scratchpad). Drive tools refuse cleanly without credentials.

## [0.6.1] — 2026-09-04

### Fixed
- `/bot activate` on a machine that had never retired was a no-op — it now
  always claims the active slot (activation IS the takeover gesture for a
  fresh machine joining the fleet). Found by the end-to-end fleet
  simulation (18/18 after fix), not by unit tests.

## [0.6.0] — 2026-09-04

### Added
- **Presence ledger + automatic election** (M3 completion): every live
  machine renews its presence line in the cloud arbitration file each
  minute; `/bot devices` renders the full roster with online/offline state.
  When the active machine goes silent past the timeout, the freshest
  machine with the smallest deviceId is elected automatically on the next
  inbound message (re-read before claiming; absence of the carrier never
  blocks replying).
- `/bot name [readable-name]` — set the roster name for this machine.

## [0.5.0] — 2026-09-03

### Added
- **Feishu drive as the cross-machine carrier** (M2): `/bot export
  --to-feishu` uploads the migration file to the app's own drive (app-scoped,
  zero copying); `/bot import --from-feishu` pulls it on the new machine.
  Real-credentials round-trip verified (upload → read-back → cleanup).
- **Device identity + cloud arbitration** (M3 groundwork): every machine
  mints a stable `deviceId` on first boot; `/bot activate` claims the active
  slot in a cloud arbitration file, and inbound messages on other machines
  stand down with a one-line notice (60s-cached lookup, absence never blocks
  replying — prefer double replies over a silent fleet).

## [0.4.1] — 2026-09-03

### Added
- **Device manager** (`/bot devices` / `/bot retire` / `/bot activate`): a
  machine can step out of the reply path without stopping the service —
  retired ends answer with a one-line notice instead of an agent turn. The
  flag is per-machine local state, never synced. The roster shows this
  machine, heartbeat-live peers, and migration provenance.

### Fixed
- Heartbeats reported `dev` as the bridge version under bare-process
  launches (systemd); the bridge now reads its own package.json.

## [0.4.0] — 2026-09-03

### Added
- **Device migration** (`/bot export` / `/bot import`): one JSON file carries
  shared settings and per-profile plugin lists to a new machine. Credentials
  are masked by default (`include-secrets` to embed); masked values are never
  written back on import — the reply lists what to re-enter. Live state
  (peer heartbeats, control tokens, node_modules, sessions) never travels by
  construction; imports from another host always remind you to retire the old
  bridge first (one Feishu app on two live machines = doubled replies).
- **Dual-end sync (web ⇄ desktop)**: bot settings live in a single source under
  `~/.dsh/dsh-lark-bridge/settings.json` (atomic write + lock + backups), a
  localhost-only control API (one-time boot token) serves each end's profile
  manifest, and `/bot sync-plugins` diffs the two profiles and installs missing
  plugins through the upstream `dsh plugin` CLI — the chat-side fix for
  dsh-desktop#93, without ever sharing a live plugin tree (#1485).
- `/bot` command: dual-end status (peers heartbeat), shared settings
  view/set/unset with masked secrets, and dry-run → apply plugin sync.
- One-command CLI bootstrap: `dsh-lark-bridge start` installs dsh if needed,
  wires the plugin into a profile, patches config, and boots the bridge
  (`status` / `logs` / `stop` / `restart` too). (#cli)

## [0.3.1] — 2026-08-16

### Added
- send_file local delivery with `outbound.allowedFileDirs` whitelist.

### Fixed
- Packaging: ship prebuilt `lib/` and auto-build on git install (fixes install
  for git-based deployments).

## [0.3.0] — 2026-08-14

### Added
- Card-based `ask_user_question` provider and plan-mode exit review.
- Live goal card from `goal/change` snapshots.
- Live todo card from `todo_write` snapshots.
- Compaction summary/prune notices.
- Reaction feedback (`OK → THINKING → DONE/ERROR`).
- Bilingual slash panel and `/help`.
- Replay port: queue outbound during a connection gap, flush on reconnect.
- Safe-restart + auto-resume of active goals across deploys.
- Approval card reminders for unanswered cards.
- Keepalive watchdog with unrecoverable alert.
- Slash commands: `/preset`, `/sessions`, `/tools`, `/schedules`, `/audit`,
  `/config`, `/feedback`, `/context`, `/jobs`, `/stop`.
- send_file tool for artifact delivery.
- Session search via `/sessions <keyword>`.
- Background job terminal notices.
- Subagent settlement notices.
- Workflow phase/log lines.
- WebSocket long connection (no callback URL).

## [0.1.0] — 2026-08-14

### Added
- First release: Feishu/Lark IM channel for DeepSeek Harness.
