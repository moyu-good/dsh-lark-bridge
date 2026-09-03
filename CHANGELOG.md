# Changelog

All notable changes to dsh-lark-bridge are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
