# Changelog

All notable changes to dsh-lark-bridge are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The schedule panel is a control surface, not a one-line echo.** `/schedules`
  used to print `· [周期(1800s)] <前 120 字 prompt>` and nothing else: a task
  scheduled `daily` rendered as `周期(undefineds)` because the bridge knew only
  the three historical kinds, the host's own `title` / `scheduledAt` /
  `lastDelivery` were dropped on the floor, and there was no way to change or
  remove a task from the chat. The panel now lists each task by name with its
  rule as a phrase (`每 30 分钟`, `每天 09:00`, `每周一、三 09:00`, `cron …`),
  its next target with a relative "还有 27 分钟", and its last delivery;
  `/schedules 1` shows the full prompt and saved delivery history, `run 1`
  queues it into the session immediately, `edit 1 <text>` / `rename 1 <name>`
  rewrite it in place through the host's compare-and-set `update`, and
  `delete 1` removes it with its records. A deployment without the schedule
  service keeps the read-only list and says which action is unavailable.
- **A firing task says who is speaking.** The host delivers a reminder as an
  ordinary user-role message, so the chat saw a block of instructions arrive
  from nobody — a half-hourly check read as the human repeatedly asking. One
  line now precedes it (`⏰ 定时任务「补漏四段进度」· 每 30 分钟`), naming the
  task and its rule. `notifyOnScheduleDispatch` (default on) turns it off for
  a chat where the task's own output is already unmistakable.
- **`busyPolicy` chooses how a message arriving mid-turn is delivered.** The
  bridge only ever called `followup`, so an instruction sent while a turn was
  running ("stop, don't touch that file") sat in the inbox until the turn
  finished — by which time the direction was stale, and the only real
  intervention was `/stop`, which throws the whole turn away. The new setting
  takes `queue` (the default, and the previous behaviour), `steer` (delivered
  at the nearest step boundary, so progress is kept) or `inject` (context
  only, the driver is not woken). A host that does not expose `steer`/`inject`
  falls back to queueing and says so rather than failing.
- **A plugin icon and locale files.** `icon.svg`, `locale/en.json` and
  `locale/zh.json` give the bundle a face and a title wherever a plugin is
  listed, instead of falling back to the npm package name. Both are exported
  and listed in `files` so a published tarball carries them.
- **`engines.dsh`.** The manifest declared only `engines.node`, and its peer
  range names `@deepseek-ai/cordis` — which the compatibility check does not
  treat as a DSH version — so the package implicitly claimed to work with
  every harness version. It now states `>=0.2.1-rc.1 <0.3.0`.

### Fixed

- **A corrupt session log no longer deadlocks the conversation forever.**
  `reach()` treated every `resume()` failure as "this conversation was never
  served here" and fell through to `create()`, which then collided with the
  file that was still on disk: the user got `already exists` on every message
  and the real cause — `SessionPersistenceCorruptionError` with the line and
  seq numbers — was swallowed. Worse, `/new` was decided after `acquire()`, so
  the one escape hatch the error message implied did not work either.
  Corruption and unreadable-format failures are now recognised (by error name,
  with the message and the `cause` chain as fallbacks) and reported in their
  own words; the conversation is moved to a fresh session from then on, and
  the old archive is left exactly as it was — not renamed, not edited — so it
  can still be found under `/sessions` if it is ever repaired.

## [0.9.6] — 2026-10-21

Eighteen commits since 0.9.5, in four themes: what the bridge had promised
and did not do, the shapes it read from the host, the identity it gives this
machine, and the gates that were watching the wrong tree.

### Fixed

- **A rename no longer looks like a new machine.** The digest that tells
  this machine from another one folded the hostname in, while the comment
  right above it said the hostname is not identity because it drifts. A host
  that got renamed therefore looked like a copy of another machine: the
  identity was re-minted, and a retirement an operator had set by hand was
  cleared — the exact opposite of what that check was for. The digest now
  takes only identifiers that survive a rename, and a state recorded under
  the old rule is still recognised as this machine, so the change re-mints
  nothing. The tests that covered this had every case pass a digest in by
  hand, so the function production actually calls had never run in a test.

- **Two arrivals with the same file name no longer overwrite each other.**
  The inbound save became asynchronous so it would not hold the event loop
  while a file lands on a bridged workspace. That opened a window the
  synchronous version did not have: the check that a name is free and the
  write that takes it are separated by a wait, so two messages carrying the
  same name both see it as free and both write to it. The name is now
  claimed before the check on disk, because a claim taken across a wait is
  not a claim.

- **A command's answer matches what the host actually returns.** The skill
  list, the session list and the tool results were read with a flat shape
  the host does not use, so those answers were empty or ordered wrongly in
  production while their tests stayed green. The reads now use the host's
  own shape, and a regression test drives the real shape through.

- **A model switch no longer reports success when it did not happen.** The
  deployment's own selection is now the truth, with the configured default
  only as a fallback — otherwise a pinned model answered "switched" while
  the session kept running on the old one.

- **The capability listing no longer contradicts itself.** It answered with
  the tools a deployment still has, and a tool someone had switched off was
  listed beside the ones that are. The preset list is read from the host
  rather than kept as a written-out list.

- **A delivery that cannot be delivered is now said out loud.** A file
  declared by a session that is not the one talking did not reach the chat,
  and nothing said so. There is an announcement now. A team panel sends one
  message instead of one per event, and a concurrent arrival no longer
  freezes the first panel.

- **A format the chat cannot carry in that shape arrives as a file, and the
  result says so.** A recording arrives as a voice note only in a container
  the transport can actually hold; anything else is sent as a file with a
  note, instead of being uploaded as something it is not.


- **The manual and the chat copy of it are the same words now.** They were
  not: the manual listed a different set of commands in its quick
  reference, wrote one sentence with a word missing, and addressed the
  reader as "bot" where the chat copy says "I". The chat copy is what a
  user actually receives, so the manual was brought to it.

- **The mode list names modes that exist.** The quick reference offered
  "standard / PTC / minimal / create", and the deployment has
  "standard / code / minimal / cordis" — one name was wrong and one was
  not a mode the deployment has.


- **The two documents now say the same things.** The Chinese README's
  repository map said the test suites numbered zero; the English one put
  the number of tests where the number of suites belongs; and a section
  that explains how to move to a new engine version existed only in
  English. The gate asks about those now too, and the Chinese copy gained
  the missing section.

- **A command that only exists in a sentence is now watched too.** The
  subcommands of the admin command are written in prose, not in a table,
  so the table check could not see them. The gate now reads the set the
  code declares and checks that each one is written down, in both
  languages.

- **One command puts the counts where they belong.** The test count is
  written in three places per document, and every test added makes all of
  them wrong. A script now does the writing, and it is not part of the
  pipeline on purpose: in the pipeline the gate should fail when someone
  forgets, and only on a developer's machine should the fixing be
  automatic.


- **The chat carries the process, not the payload.** A tool call's arguments
  and a tool's output were both copied into the chat in full: the arguments
  of a file write are the whole file, so the file's contents were copied
  into a conversation that already had the file on disk. They are
  summarised now — the path, the command, the query — and a result shows
  its first lines with a count of what was left. The full text stays in
  the session log, where a run can be read afterwards.

- **A turn says when it is over.** Twenty-six tool calls scrolling past
  looked the same as a run that had stalled, because nothing said the run
  had finished. A turn now ends with one plain line: how many tool calls
  it made and how long it took. It is a message of its own rather than a
  line inside the process, because the platform hides the process when
  the run ends and the line would have vanished with it.

- **A delegation is announced where the question was asked.** A child
  running in its own session was visible only in the panel card, so a
  reader looking at the chat saw nothing happen until the answer arrived.
  The delegation is now said out loud in the chat when it is made, with
  the child's own label, and its progress follows on a thirty-second
  window. A chat that would rather see the panel alone can turn it off.


- **The listings say what is true, and they say all of it.** The repository
  was listed in three directories and the README named three. It is listed
  in nine, and the README now names nine, with how each one lists it —
  an issue, a pull request, a form, or an automatic crawl. Every link was
  fetched and confirmed reachable before it was written down. The version
  numbers those pages show are not repeated in the README, because most of
  them read the version from npm and npm still serves the older release;
  the README says so instead of quoting a number that goes stale.

### Added

- **What this deployment can actually do.** A command lists the tools that
  are available and the MCP servers it talks to — not only what someone
  switched off.

- **The files a turn declares are delivered.** A file a session declares as
  delivered is sent to the chat, once per declaration.

### Changed

- **The contract gate now watches the release in production.** It fetched
  the upstream branch, so it answered "will the bridge still fit the next
  release" and stayed silent about the release actually running, which is
  where a shape mismatch bites. It now checks the branch, the release the
  deployment runs, and the tree on the machine when there is one, and the
  conclusion line names the trees it checked.

## [0.9.5] - 2026-10-20

### Fixed

- **The published package no longer carries this machine's names.** The
  leak gate watched for private forms of address, this machine's paths and
  its hostname; it did not watch for the name of an internal system, the
  name of a local deployment script, or the name of the service unit. The
  package that went out as 0.9.4 contained all three, and the gate
  reported the repository clean. The pattern list now covers them, the
  text no longer carries them, and the gate's own list is refreshed in the
  workflow's secret so the check on the runner sees what the local check
  sees.

- **A change under the source that never reached the build output no
  longer passes.** The build output is committed and the running plugin
  loads it, so an edit that stopped at the source shipped the previous
  behaviour with a green check. The workflow now rebuilds and asks git for
  a difference, so a stale committed build fails the run. The check on
  the runner's own path, where the source maps differ, is included.

- **A push to a branch outside the listed names is checked.** The push
  trigger named two patterns; a branch outside them got no check at all,
  and the failure mode was invisible. Every branch is checked now.

- **The registry check no longer reads an answer out of a failed
  command.** It required the command to succeed and the output to look
  like a version, but it never compared the two, and the registry treats
  a version request as a range. A version that was never published could
  therefore be reported as published. The output must now equal the
  version, and a registry that cannot be reached is reported as unknown
  rather than as missing.

### Notes

- **0.9.4 carries those names in its published tarball.** It was cut
  before the fix above. Install from a later version, or from the git
  source of the current main, which is clean.

## [0.9.4] - 2026-10-20

### Added
- **A test for the sweep's failure path.** A session whose meter throws
  must not stall the sweep for the others, and the failure must leave a
  trace - a session that is silently skipped is a session nobody knows
  is unmeasured. The test pins both, and removing the warning that
  records the failure turns it red.
- **A timing-sensitive wait no longer times out on a loaded machine.** The
  new sweep test waited with the default one second, which the suite's own
  configuration calls out as the flake it is; the inbound handler is
  fire-and-forget, so the agent and its binding land after the message
  returns. The wait now uses the same thirty seconds the rest of the
  suite uses for that, and the test was run ten times to confirm.

### Fixed
- **The registry check reads npm's exit code.** It looked for a
  version-shaped string in npm's output and called the version published
  when it found one. npm prints its error text on stdout as well, and an
  unreachable registry names the address it could not reach - 127.0.0.1 -
  which looks like a version number, so a registry that could not be
  reached was read as a version that was published. The exit code is now
  read, and a version-shaped string counts only when the command
  succeeded. A registry that does not answer is reported as unknown
  rather than as missing.
- **The pressure sweep leaves a line with what it measured.** It said
  nothing when it succeeded, which made the fault it exists to catch
  indistinguishable from a quiet system. It now writes a line with the
  number the meter returned, when the number changes rather than on every
  poll, so a non-zero total is proof that the meter read the session.


## [0.9.3] - 2026-10-20

### Fixed

- **The release carries the package tarball.** The release had no assets at
  all, which left the note in the issue thread pointing at something that was
  not there. The tarball is built from the same tree the tag points at, and it
  is the package as the registry would receive it, so there is a way to
  install the release even before the registry carries it.

### Changed


## [0.9.2] - 2026-10-20

### Fixed

- **The bridge no longer guesses the host's argument shape.** 0.9.1 read the
  host method's argument count and picked a call shape from it. That count
  cannot tell the two shapes apart: a host that gives its `signal` a default
  value reports three arguments while still having the attachments slot, and
  the three-argument shape puts the signal where the attachments belong. That
  is issue #2's failure again, except silent - the host falls back to its
  default signal and the abort is lost with nothing to show for it. The third
  argument is now both: an empty array for the host that wants attachments
  there, and the signal's own members for the host that wants the signal
  there. Each host shape is pinned by a regression test, and restoring the
  argument-count choice turns the default-value case red.

- **The registry check no longer reads a version number out of an error.**
  npm's answer for a version that is not published contains the version
  number ("404 No match found for version 0.9.1"), so the check reported a
  missing version as published. The 404 is read first now. The check was
  verified against the real registry in six cases: a missing version, a
  published one, an empty answer, a refused connection, a version wrapped in
  colour codes, and the error text that carries the version.

- **The argument-count check in the contract gate counts the declaration.**
  It matched the first "async execute(" in the upstream source, so a comment
  showing an example call was counted instead of the method itself and a
  legal host was reported as drifted.

- **A failing read of a settled job's output leaves a trace.** It degraded
  to "no tail" silently, which is how a wrong caller shape stayed invisible.
  It still does not throw into the event stream.

- **The release step updates a release that already exists.** Creating one
  failed the job whenever the tag was pushed again - which is what a
  rewritten history does - and the release had been made all the same.

- **The install note's pnpm version was wrong.** The gate is
  `strictDepBuilds`, on by default since pnpm 10.3, and `allowBuilds` arrived
  in 10.26; neither is new in pnpm 11. The placeholder line is written by the
  failed install, not shipped with the profile.

- **The smoke check's reasoning no longer calls a locally inserted package
  an upstream default,** and names the release that removed the package the
  notes called long gone.

- **The token meter was reading nothing.** The upstream meter prices a
  context by replaying the session's event log, so it takes the session, not
  the session id. The bridge handed it an id, the replay found nothing, and
  every session measured zero tokens with no error to catch - the
  context-pressure warning never fired, while `/context` kept working and
  made it look healthy. The bridge now hands it the session, and the
  contract gate asserts the upstream shape.

- **The publish step names the registry** rather than leaving it to npm's
  default.

- **The public ledger no longer carries a private form of address,** and the
  upstream ledger entries were corrected where the earlier ones claimed a fix
  was in production when the running process was still on the old build.


## [0.9.1] — 2026-10-20

### Fixed

- **A bracketed placeholder path is no longer reported as a real one.** The
  leak gate read the Windows user segment with a character class that stopped
  at an angle bracket, so the bracketed stand-ins it exempts were unreachable
  there. Real paths are still reported.

- **Every slash command can die with a generic "cannot start session" line
  (issue #2).** The host's `commands.execute` grew an attachments slot in
  front of `signal`; the bridge still called the old three-argument shape, so
  the signal landed in the attachments slot, the real signal stayed
  `undefined`, and the host threw while reading `signal.aborted`. The bridge
  now passes an argument that satisfies both shapes at once: an empty array
  for the host that wants attachments there, and the signal's own members
  for the host that wants the signal there. Reading the host's argument
  count was not enough — a host that gives `signal` a default value reports
  three arguments while still having the attachments slot, and picking the
  three-argument shape for it puts the signal where the attachments belong,
  which is this same failure but silent. Each host shape is pinned by a
  regression test, and the regression is proven: restoring the
  argument-count choice turns the default-value case red.
- **A failing slash command now says "command execution failed" instead of
  "cannot start session".** The command path runs on the host, not on the
  model, so the outer session-creation catch was reporting a session problem
  for a command problem — which is what sent issue #2's reporter looking in
  the wrong place. The command path owns its own error surface now, and the
  stack still lands in the crash log.
- **The contract gate covers the commands service.** It had entries for a
  dozen upstream signatures but none for `commands.execute` — the exact gap
  issue #2 fell through. The gate now asserts the upstream signature
  directly, against the live upstream branch, so the next slot insertion
  fails in CI instead of in production. It also counts the arguments the
  way JavaScript counts them, because a signature can keep its text and
  change its length: giving `signal` a default value leaves the source
  unchanged and takes the count from four to three.
- **The pnpm install note now matches the pnpm reality**: after the failed
  install pnpm writes a line into the profile holding the literal text
  `set this to true or false` (not a boolean) and it must be replaced, and
  the same command has to be re-run
  afterwards — a failed install leaves the profile half-configured, because
  the plugin's bundles are not merged when the install exits non-zero.
- **The documented Node version now matches `engines.node`** (22.19+ or
  24+); the prerequisites line still said Node 18+.
- **The context-pressure meter was reading nothing.** The host's
  `tokenMeter.measure` takes the SESSION — it replays the session's own
  event log through `seq` and `eventAt()` — and the bridge was handing it
  the session id alone. The upstream replay loop then read nothing, the
  meter reported zero tokens for every session, and it did so WITHOUT
  RAISING, so the proactive "your context is getting full" warning could
  never fire. The `/context` command was unaffected: it already passed
  the session object. The meter is now handed the session, the contract
  test no longer certifies the id-only shape (it used to, and making the
  declaration more correct turned it red), and the upstream signature is
  asserted against the live upstream branch.
- **The release workflow can now actually publish, and its registry check can
  actually fail.** `npm publish --provenance` needs GitHub Actions' OIDC
  permission (`id-token: write`), which the workflow did not grant — the
  publish step would have failed with EUSAGE the moment a token was
  configured, and because the registry check only runs after a successful
  publish, it would have been skipped and the release would have reported
  success while nothing shipped. The check itself also told three
  different stories: an empty version resolved to `latest` and passed; an
  unreachable registry was reported as "not on npm"; and a 404 was
  indistinguishable from a timeout. Now an empty version is an error, the
  lookup retries with backoff, and only a 404 means "not published" —
  anything else is reported as unknown.
- **The context-pressure sweep has a behaviour test.** It drives the real
  bridge main loop over the fake channel, a fake token meter and a fake
  clock, and asserts that the meter receives the host's session object —
  with its `seq` and `eventAt()` — rather than the session id alone, that
  a session over the threshold warns once per crossing, and that dropping
  back below re-arms the warning. The fake meter prices a context by
  replaying the session's event log the way the host does, so handing it
  the id alone yields a silent zero — the failure the test is built to
  catch.
- **An unknown command-service arity now warns instead of guessing.**
  Reading the host method's arity fell back to the four-argument call for
  every shape that was not three — so a host that gives `signal` a
  default value (length 2) reproduced issue #2's exact failure, quietly.
  Unknown shapes now leave a trace in the log.
- **Audio, video and sticker attachments are no longer dropped silently.**
  They download into the workspace with a typed note, so the model sees that
  something arrived instead of a placeholder tag. A sticker that shares a
  filename with an existing one is stored beside it (`name-2.ext`) rather
  than overwriting it, and names are stripped of control characters.
- **Image notes no longer reach the model twice** — the note was appended on
  two paths.
- **A late session binding no longer clobbers a rotation's rebind** (which
  stranded routing and leaked the fresh agent); a rotation refuses under
  `close()` and takes its late agent down. A failed rotation now warns in the
  reply instead of failing silently.
- **A job-completion notice keeps its output tail.** The host's `readAt`
  takes a bare session-id string; the bridge passed an object, so the tail
  was always empty. The same fix applies to `/jobs` ownership listing.

### Added
- **`/new` (and its `/clear` alias) rotates the chat onto a fresh session.**
  The previous one stays available through `/sessions`; the rotation
  survives restarts via a small on-disk store, is refused mid-turn, and is
  registered on the slash panel and `/help`.
- **Job-completion notices name how long the job ran** — measured at
  settlement from the snapshot's `startedAt`.
- **`/restart` reports when the service came back and how long it was down**,
  and the next boot says so in the chat.
- **`/compact` replies are translated** into the chat's language, keeping the
  item and token counts.

### Changed
- **Install note corrected for the pnpm build-script gate (issue #4).** The
  gate is `allowBuilds` in the *installing* profile's `pnpm-workspace.yaml`; the
  legacy `onlyBuiltDependencies` key was removed in pnpm 11, and a package
  cannot grant the approval on the installer's behalf. The documented value
  is `protobufjs: false` — the blocked script only prints a version-scheme
  warning. The upstream CLI prints a pointer to that file for git-hosted
  plugins only, so an npm-published plugin documents the step itself.


## [0.9.0] — 2026-09-13

### Changed
- **Targets DeepSeek Harness 0.1.5.** The bridge now registers its question
  provider on the `user-questions/request` Cordis waterfall. Harness 0.1.5
  replaced the `ctx.userQuestions.registerProvider` registry that earlier
  versions exposed; a waterfall listener claims the request by returning an
  answer and delegates through `next()`. The request and answer payloads are
  unchanged, so the card flow is identical from the user's side.
  **Requires harness `>=0.1.5-rc.2`** — on 0.1.1 the seam is absent, the
  listener never fires, and the bridge logs `user-questions provider
  unavailable` while the model's question falls back to prose.

### Fixed
- The event is mirrored in a local `cordis` `Events` augmentation so the
  composition-time listener is type-checked against the same shape the host
  dispatches, instead of being cast past the compiler.

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
  exports it in `web 端的启动脚本`). Verified against the live endpoint
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
