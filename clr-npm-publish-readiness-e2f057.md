# Make `cli-runner-learner` consumable as an npm package / `npx` tool

Close the gaps that currently make `cli-runner-learner` (already published as `cli-runner-learner@0.2.3`) unsafe to install as a real dependency or invoke via `npx`, and migrate AgentHistoric off its hard-coded `CLR_ROOT` path so it consumes the package from npm.

## Current state (what's already fine)

- Published to npm, `bin: { clr: "dist/cli.js" }`, shebang present in `src/cli.ts`.
- `files` whitelist, `exports`, `main`, `types` all declared.
- GitHub Actions release workflow builds, tests, version-bumps, and publishes.
- Library surface in `src/index.ts` exports profile loader, skill/adapter generators, runner/driver, adapters, types.

## Gaps to close

### 1. Package metadata hygiene (`package.json`)

- **`license`** missing — npm registry shows `Proprietary`. LICENSE file exists; add `"license": "MIT"` (or whatever matches the LICENSE file).
- **`repository`, `homepage`, `bugs`, `author`, `keywords`** missing — add for discoverability.
- **`publishConfig: { "access": "public" }`** — match AgenticSkillMill pattern; remove the `--access public` flag from CI.
- **`cli.ts` version string is hardcoded `0.1.0`** — read from `package.json` at runtime so `clr --version` stays correct across bumps.

### 2. Executable bit on `dist/cli.js`

TypeScript emits `dist/cli.js` without the exec bit, so `npx clr` can fail on some platforms. Add:

- `"postbuild": "chmod +x dist/cli.js"` script, and/or
- `"prepack": "npm run build && chmod +x dist/cli.js"` so publishing always ships an executable artifact and local `npm link` works.

### 3. Runtime path resolution — **biggest correctness bug for dep use**

`src/cli.ts` and several engine/driver modules derive `PROJECT_ROOT` from `import.meta.url` and then read/write `transcripts/`, `profiles/`, `.logs/`, learn-state inside the installed package. When installed into `node_modules/` this:

- Pollutes the dependency install tree.
- Breaks under read-only installs (global npm, npx cache, Nix, Docker `node:*-alpine`).
- Makes per-project state bleed across consumers.

Fix (cwd-based, confirmed with user):

- Introduce a single resolver (`src/paths.ts`) exporting `getDataDir()`, `getTranscriptDir()`, `getProfileDir()`, `getStateDir()`, `getLogsDir()`.
- Default data dir: `process.cwd()/.clr/` with subdirs `transcripts/`, `profiles/`, `state/`, `logs/`.
- Overrides (in precedence order): `--data-dir` CLI flag → `CLR_DATA_DIR` env var → default.
- Bundled `profiles/*.json` in the installed package become **read-only seeds**. Resolution order for loading a profile by id: `<dataDir>/profiles/<id>.json` → `<packageRoot>/profiles/<id>.json`. Writes always go to `<dataDir>/profiles/`.
- Replace every `PROJECT_ROOT`-derived path in `cli.ts`, `engine/discovery.ts`, `engine/profile-manager.ts`, `runner/driver.ts`, `export/adapter-generator.ts`, `orchestration/orchestrator.ts`, `engine/learn-state.ts` with the resolver.
- Add `.clr/` to `.gitignore` template / note in README.

### 4. Trim what ships to npm

Current `npm pack --dry-run` includes transient artifacts that shouldn't be in a published package:

- `profiles/*.learn-state.json` (per-session state)
- `profiles/*.bak` (manual backups)
- `profiles/crush-run.json` (looks like a local draft)

Tighten the `files` allowlist or add an explicit `!profiles/*.bak`, `!profiles/*.learn-state.json` pattern. Keep only the curated seed profiles (`_template`, `agent`, `agent-print`, `claude`, `claude-print`, `crush`, `crush-print`, `gemini`, `opencode`).

### 5. Publish safety

- Add `"prepublishOnly": "npm run typecheck && npm run build"` so a direct `npm publish` (without CI) can't ship stale `dist/`.
- Add a minimal smoke test: `node dist/cli.js --help` exits 0. Wire into the release workflow before `npm publish`.

### 6. `node-pty` native build → prebuilt binaries

`node-pty` requires `python3 make gcc g++` at install time; today CI installs them explicitly and end users hit the same requirement (blocks Windows + slim containers).

Options, in order of preference:

- **Pin a `node-pty` version that ships prebuilds** (recent `1.x` publishes prebuilds for common triples via `prebuild-install`). Verify with `npm view node-pty dist.tarball` and test `npm install --ignore-scripts` on a fresh machine. If prebuilds resolve, nothing to do beyond the pin.
- If prebuilds are not reliable: add `prebuild-install` as a dependency with a `install` script fallback, or expose a `CLR_SKIP_PTY=1` escape hatch that lazy-imports `node-pty` only for commands that actually spawn PTYs (library consumers using only profile/skill/adapter helpers would no longer need the native build).
- Document Windows requirements (Visual Studio Build Tools) as a fallback in README.

### 7. README — npm + npx usage section

Add sections:

- **Install as CLI**: `npm i -g cli-runner-learner` → `clr --help`.
- **Run without install**: `npx cli-runner-learner --help` / `npx -p cli-runner-learner clr learn --command ...`.
- **Use as a library**: snippet importing `loadProfile`, `drive`, `Session`, `generateSkillMarkdown`, `profileToAdapterPreset` from the package.
- **Data dir** convention (`./.clr/`, `CLR_DATA_DIR`).
- **Native deps** note for `node-pty`.

### 8. AgentHistoric integration — consume from npm

Currently `@/home/barrett/code/AgentHistoric/scripts/lib/clr-runner.mjs:28` hard-codes `CLR_ROOT=/home/barrett/code/cli-runner-learner` and shells out to `node $CLR_ROOT/dist/cli.js`. Migrate:

- Add `"cli-runner-learner": "^0.3.0"` to `@/home/barrett/code/AgentHistoric/package.json:1-19` as a dependency (package.json is `private: true`, which is fine).
- Replace `CLR_CLI` resolution with `require.resolve("cli-runner-learner/package.json")` → derive `dist/cli.js`, **or** (preferred) `createRequire(import.meta.url).resolve("cli-runner-learner/dist/cli.js")`. Spawn with `process.execPath` (current node binary), not a shelled-out `node`.
- Keep `CLR_ROOT` env override for dev checkouts so local iteration still works.
- Drive the orchestrator via library API where possible (`import { runOrchestrate } from "cli-runner-learner"` — expose if not already). Fall back to spawning the bin only when we need subprocess isolation.
- Configure `stateDir` / transcript dir explicitly via the new `--data-dir` flag instead of relying on clr's internal `CLR_ROOT/transcripts`; update `correlateTranscripts()` accordingly.
- Bundled profiles (`agent-print.json`, `claude-print.json`, `crush-print.json`) should be loadable by id straight from the package seeds — no manual copying needed.

### 9. Version bump

Cut `0.3.0` (minor, because the data-dir change is a behavior break for anyone relying on the current in-package write paths). Update README migration note.

## Out of scope

- Rewriting the learning algorithms or adapter generator.
- Windows CI (document only).
- Splitting into monorepo packages.

## Verification

- `npm pack --dry-run` shows no `.bak` / `.learn-state.json` files.
- Fresh `npx cli-runner-learner@next --help` works in an empty directory and creates `./.clr/` only on first write.
- `npm install cli-runner-learner` in AgentHistoric, then `npm run test:regressions:clr:smoke` passes with no `CLR_ROOT` env var set.
- `clr --version` prints the real package version.
- Release workflow publishes a patch and the registry shows MIT license + repo link.
