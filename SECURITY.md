# Security Policy

The bridge turns Feishu/Lark chat into a control surface for a shell-capable
coding agent. That makes security the top priority.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately:

- GitHub: use the repository's private vulnerability reporting
  (Security → Report a vulnerability), or
- Email the maintainer (see the GitHub profile).

Include the version, a description of the flaw, and a minimal reproduction.
We aim to acknowledge within 48h and ship a fix as fast as possible.

## What matters

- **Authorization boundaries.** Who may reach the bot, who may answer
  approvals, which rooms are served. The platform's visibility scope is the
  outer boundary; the bridge's allowlists narrow it. Keep them honest.
- **Prompt injection.** Untrusted message/card content must never steer the
  bridge itself. Approval and file-send flows are the risky seams — changes
  there need extra scrutiny.
- **Secret handling.** App credentials flow through env / configured
  credential stores. Never log secrets; never put them in chat-visible paths.
- **Denial of service.** An attacker who can reach the bot can burn tokens and
  disk. Rate/shape what the platform does not already gate.

## Supported versions

The latest release on `main` is supported. Pre-release (`-rc.*`) versions are
supported on a best-effort basis for security fixes.
