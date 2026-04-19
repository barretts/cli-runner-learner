# `cli-runner-learner` — post-publish follow-ups

Captures the manual cutover steps and deferred technical work that remain after the 0.3.0 publish-readiness changes landed in `cli-runner-learner/` and `AgentHistoric/`.

## 1. Cutover steps (manual, one-time)

### 1a. Publish `0.3.0`

- Commit the pending working-tree changes in `@/home/barrett/code/cli-runner-learner` on a feature branch; PR → main.
- On merge, `@/home/barrett/code/cli-runner-learner/.github/workflows/release.yml` bumps patch (→ `0.3.1`) and publishes.
- Verify on registry: `npm view cli-runner-learner@latest version`, `license`, `repository` populated; `bin` executable in the tarball.

### 1b. Smoke the published package

- `npx cli-runner-learner@latest --version` in a tmp dir — should not create `.clr/`.
- `npx cli-runner-learner@latest record --command ls --max-session 3000 --settle-timeout 1000` — should create `./.clr/transcripts/…`.
- Try on a machine without build tools to confirm the native-build error is clear (expected failure until node-pty prebuilds are solved — see §3).

### 1c. Migrate AgentHistoric off `CLR_ROOT`

- In `@/home/barrett/code/AgentHistoric`: `npm install` (pulls the new `cli-runner-learner` dep).
- Run `npm run test:regressions:clr:smoke` **without** `CLR_ROOT` to confirm `require.resolve` path works end-to-end.
- Once green, remove `CLR_ROOT` references from docs / wrapper scripts:
  - `@/home/barrett/code/AgentHistoric/scripts/clr-wrappers/agent-print.sh`
  - `@/home/barrett/code/AgentHistoric/docs/agenthistoric-clr-integration-972743.md` and related phase docs
  - Any `CLR_ROOT=` in CI workflows.
- Keep the `CLR_ROOT` env override in `scripts/lib/clr-runner.mjs` itself — useful for local dev checkouts.

### 1d. AgentThreader consumer (if applicable)

- `@/home/barrett/code/AgentThreader` may also want `cli-runner-learner` as a dep now that the library exports (`Session`, `drive`, adapter/skill generators) are public and path-safe. No code depends on it yet per the current grep; add only if a real consumer emerges.

## 2. Lock down the publish hygiene

Minor polish that didn't fit the first pass:

- **Prebuilt release artifacts**: `release.yml` currently uploads `dist/*` to the GitHub Release. Verify this is intentional — if we want reproducible install from a tag (without hitting npm), publish a tarball via `npm pack` and attach that instead.
- **Provenance**: add `npm publish --provenance` (requires `id-token: write` permission in the workflow). Gives signed supply-chain attestations on the registry.
- **`engines.node` vs CI node-version**: both pinned to `20`. If we want to support 22 LTS, add a matrix build (`20`, `22`) to the release workflow before publish.
- **`files` allowlist audit**: `compiled/` is shipped. Decide whether end users need the pre-compiled skill variants (claude, cursor, windsurf, opencode, codex) or if only `skill/` is needed. Dropping `compiled/` would reduce the tarball meaningfully.
- **`adapter-overrides.json`**: currently a top-level file bundled in the package. If we want consumer projects to provide their own, document precedence (`<dataDir>/adapter-overrides.json` → package default) and implement the resolver in `@/home/barrett/code/cli-runner-learner/src/export/adapter-generator.ts`.

## 3. `node-pty` native-build escape hatch (deferred)

The biggest friction for `npx` / dependency users. Today `npm install` fails without `python3 + make + g++`, which blocks Windows users and slim containers.

Options, in descending preference:

- **Track `node-pty` 1.2.x prebuilds**: the 1.2.0-beta line has been shipping intermittent prebuilds. Pin when stable + prebuilds land for linux-x64, linux-arm64, darwin-{x64,arm64}, win32-x64.
- **Lazy-import `node-pty`**: move the `import pty from "node-pty"` in `@/home/barrett/code/cli-runner-learner/src/runner/session.ts` behind a dynamic `await import()` inside `Session.start()`. Library consumers that only touch `loadProfile`, `generateSkillMarkdown`, `profileToAdapterPreset`, or the sentinel/interactive output adapters no longer trigger the native build at runtime, and `CLR_SKIP_PTY=1` could short-circuit optional features gracefully.
- **Publish our own prebuilt binaries**: use `prebuildify` + `node-gyp-build` wrapping `node-pty`. High maintenance cost; do this only if §3.1 and §3.2 don't cover the user base.

## 4. Test coverage gaps

The package has no unit tests today — only `npm run smoke` (`clr --help`). Before we rely on npm installs in AgentHistoric CI, add:

- Unit test for `@/home/barrett/code/cli-runner-learner/src/paths.ts` covering default cwd, `CLR_DATA_DIR` override, profile resolution order (user → bundled).
- Unit test for `loadProfile`/`saveProfile` resolution using a temp `CLR_DATA_DIR`.
- Smoke test for `record`, `classify`, `inspect` against a fixture transcript (no PTY required).
- Add `"test": "node --test test/**/*.test.mjs"` and wire into `release.yml` before publish.

## 5. Documentation follow-ups

- Update `@/home/barrett/code/cli-runner-learner/README.md` with a short migration note: "0.3.0 moves runtime files from the package dir to `./.clr/`. Set `CLR_DATA_DIR` to preserve existing profiles from 0.2.x."
- Add a one-liner `CHANGELOG.md` (or enable `generate_release_notes: true` — already on — and stop there).
- Cross-link from AgentHistoric docs (`docs/agenthistoric-clr-integration-972743.md`) to the npm package page.

## Priorities

- **Must do before next AgentHistoric CI run**: §1a, §1b, §1c.
- **Should do this quarter**: §3 (lazy-import), §4 (paths + profile tests).
- **Nice to have**: §2 (provenance, node matrix), §5.

## Out of scope for this plan

- Rewriting the learning algorithms or adapter generator.
- Monorepo split.
- Windows CI matrix (wait on §3 first).
