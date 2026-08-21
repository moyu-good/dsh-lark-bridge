# Changelog

All notable changes to dsh-lark-bridge are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
