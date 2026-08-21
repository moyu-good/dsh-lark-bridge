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

## Setup

```sh
npm install          # or pnpm install
npm run build        # tsc + tsdown → lib/
npm test             # vitest run
npm run contract-test
npm run contract-drift
```

No network calls are needed for the test suite; the transport is faked.

## Development flow

- Keep changes narrow; one concern per commit.
- Rebuild `lib/` when `src/` changes — the package ships compiled output so
  git/npm installs work with zero build steps.
- Update `README.md` (and `README.zh.md` when user-facing text changes).
- Add a `CHANGELOG.md` entry under Unreleased for user-visible changes.

## Submitting

- Open a PR against `main`.
- CI runs tests + contract checks. It must pass.
- Describe what changed and why, and note any behavior change for deployments
  (new defaults, renamed config).

## Code of conduct

Be respectful. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
