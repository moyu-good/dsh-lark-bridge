# Contributing to dsh-lark-bridge

Thanks for considering a contribution. The project is small and focused; here's
how to work on it well.

## Ground rules

1. **The bridge is a channel, not a host.** Capability belongs in the dsh
   host (`@deepseek-ai/dsh` ecosystem); the bridge renders host capabilities
   as Feishu interactions. When a feature feels like "the host should do
   this", it probably belongs upstream.
2. **Persona stays neutral.** The chat-agent system prompt must never contain
   deployment-specific or personal preferences (names, paths, private rules).
   Those belong in the deployment's `cordis.patch.yml`. A good test: would a
   stranger who clones the repo get the same correct behavior?
3. **Contract drift is a hard gate.** `scripts/verify-dsh-contract.mjs` checks
   the bridge's `src/host.ts` type surface against the dsh upstream. It must
   stay green. If you extend the host surface, mirror it upstream first.
4. **Tests are the proof.** The bridge has a contract test
   (`plugin-contract-test.mjs`), a full vitest suite, and a clean build chain
   (`tsc` + `tsdown`). New behavior ships with tests.

## Three invariants

These keep the bridge maintainable. They are the reason it survives upstream
churn.

1. **Grafted channel, not re-integration.** The bridge only normalizes
   messages; every capability comes from official opt-in dsh plugin families
   composed in your profile. Zero bridge code = zero upgrade cost when upstream
   ships features.
2. **Everything through host service contracts.** `agents`, `agentPresets`,
   `approval`, `goals`, `settings`… self-contained against published packages
   only — never against host source.
3. **Every change archives a design card first.** See
   [`docs/design/`](docs/design/README.md). Implementation notes are backfilled,
   and blocked investigations are archived as assets too.

## Repo map

```
src/
  bridge.ts        message pipeline: normalize → authorize → ack → agent turn → render
  host.ts          host contract surface (the thing verify-dsh-contract checks)
  commands.ts      slash commands (i18n bilingual)
  cot.ts outbound.ts  thinking-process & answer rendering
  feishu-tools.ts    native Feishu agent tools (notify / cloud drive)
  sync/            dual-end sync: settings source of truth, peers, control API,
                   migration, account book, endpoint arbitration
  pricing.ts       live DeepSeek peak/off-peak phase
  user-guide.ts    single source of the /manual content
  chronicle.ts     inbound-message ledger hook (integration example; user text only)
  config.ts        schema + defaults
tests/             vitest suites (59 .spec.ts files) incl. harness-based fakes
scripts/           verify-dsh-contract.mjs — asserts no drift vs upstream master
plugin-contract-test.mjs   43 contract checks on the host contract surface
```

## Setup

```sh
pnpm install         # pnpm@11.7.0 is the declared package manager
pnpm build           # tsc + tsdown → lib/
pnpm test            # vitest run
pnpm contract-test   # 43 host-contract checks
pnpm contract-drift  # drift check against upstream dsh master
```

No network calls are needed for the test suite; the transport is faked.

## Quality gates

All five must be green before a merge:

```sh
pnpm hygiene                     # repo hygiene scan (deployment terms stay local)
pnpm test                        # 594 unit/integration tests, 59 spec files
pnpm contract-test               # 43 host-contract checks
pnpm contract-drift              # drift check against upstream dsh master
pnpm typecheck && pnpm build     # tsc + tsdown (lib/ is committed)
```

CI runs all of the above on every push and pull request, with the upstream drift
check pinned to dsh master — if upstream changes a contract, the build tells you
before users do.

**Counting tests:** `ls tests/*.spec.ts | wc -l` for spec files (59);
`grep -rhoE '\b(it|test)\(' tests/*.spec.ts | wc -l` for declared cases (594).
`ls tests | wc -l` counts non-spec files too and will give you the wrong number.

## Adding a feature

Write the design card first (template in `docs/design/`), implement, then
backfill the change record.

For an integration that only needs inbound message visibility, prefer the
`chronicleEndpoint` hook over modifying the pipeline — see `src/chronicle.ts`
(it sends the user's text, not the bridge's replies).

## Development & MR flow

`main` is the stable baseline and only receives **reviewed merge requests**. All
development happens on feature branches (`feat/<name>`), never directly on
`main`.

Per-MR checklist:

1. Branch from `main`; keep the change small and single-purpose.
2. Full quality gate green (all five commands above).
3. Repo hygiene scan — `pnpm hygiene` — must exit 0. Deployment-specific terms
   go in a local `.leak-patterns` file (see `.leak-patterns.example`), **never in
   the repo**.
4. Reviewer approves → merge to `main` → deploy from `main`.
5. Production incidents revert on the spot (history stays in git); the reverted
   branch is rebased and re-MR'd with a fix.

Releases are tags. Pushing a `v*` tag runs the same gate as CI, verifies the tag
matches `package.json`, and publishes the CHANGELOG section as the release notes
— so a tag can never point at a commit that would have failed CI.

This is enforced because past direct-to-`main` experiments had to be rolled back
as a multi-commit revert in one batch — feature branches keep `main` shippable
at all times.

## Version & release policy

Two tracks, written down so nobody guesses:

- **preview track** — development/experimentation. Pull the latest upstream
  (GitHub releases including alpha/rc, or `master`) and the newest bridge
  features; breakage is expected here.
- **stable track** — production deployments. Pin the npm `latest` /
  release-candidate line. **Production never runs an `alpha`.**

Promoting preview → stable requires the full quality gate to pass, plus a live
smoke test.

### Moving to a new harness version

The bridge consumes the harness through the plugin seam, so a harness upgrade can
move the seam under it. The check is one command:

```sh
pnpm contract-drift    # compares the bridge's host mirrors with upstream
```

It fetches the harness source it declares a contract against and fails when an
entry the bridge mirrors has moved or vanished — run it before and after an
upgrade. When it fails, the fix belongs in the bridge (`src/bridge.ts`,
`src/questions.ts`), not in a pin: the bridge follows the newest harness, and the
host-contract mirrors in those files are the single place that records what the
seam looked like when it was last verified.

Two rules keep the upgrade honest:

1. **Upgrade the engine by switching trees, not by layering one on top.** A dsh
   profile resolves the harness's own packages from the tree the CLI runs out of,
   so pointing the launcher at a new checkout is the whole switch. Side-by-side
   trees fight over the profile's `node_modules`.
2. **A profile declares only its own additions** (this bridge, extra plugins).
   Harness packages are not profile dependencies — declaring them pins the
   profile to a version and hides the seam behind a stale copy.
3. **After upgrading, re-verify the contract.** A seam that moved without the
   drift gate going red means nobody checked.

## Submitting

- Open a PR against `main`.
- CI runs tests + contract checks. It must pass.
- Describe what changed and why, and note any behavior change for deployments
  (new defaults, renamed config).
- Update `README.en.md` (and `README.md` when user-facing text changes) — the two
  share a section skeleton; keep the headings in step.
- Add a `CHANGELOG.md` entry under Unreleased for user-visible changes.

## Code of conduct

Be respectful. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
