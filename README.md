# cli-runner-learner (`clr`)

Learn CLI tool behavior via PTY probing, then export skills and adapter presets for agentic automation. Spawns processes in a real PTY (via `node-pty`), records terminal I/O, classifies output into behavioral states, extracts patterns, and builds profiles that drive future interactions -- without hardcoded tool-specific logic. Exports learned knowledge as portable **skills** (markdown) and **adapter presets** (TypeScript/JSON) for use by any agent or orchestrator.

## How It Works

### Learning Cycle

The system follows a **forced learning cycle** to build a behavioral profile for any CLI tool:

1. **Discover** -- Run the tool with `--help` and parse its capabilities (subcommands, flags, interactivity).
2. **Probe** -- Launch the tool in a PTY, apply probe strategies (observe, input, multi_turn, shortcut, ctrl_c, explore), and record everything.
3. **Classify** -- Segment the terminal transcript and classify each segment into a behavioral state (startup, ready, working, thinking, prompting, completed, error).
4. **Extract** -- Pull out recurring output patterns (n-grams generalized into glob patterns) and associate them with states.
5. **Profile** -- Merge patterns into a tool profile. High-confidence patterns become state indicators.
6. **Export** -- Generate portable skills (markdown) and adapter presets (TypeScript/JSON) from the learned profile.
7. **Drive** -- Use the learned profile to interact with the tool autonomously: detect states via pattern matching, respond to sub-prompts, and track side effects.

### Orchestration

Once profiles are built, the **orchestrator** dispatches manifests of tasks to LLM CLI tools:

1. **Load profiles** -- Each task references a `tool_id` with a learned profile.
2. **Batch scheduling** -- Fibonacci-scaled batch sizing with concurrent execution.
3. **Drive** -- Each task is executed via the existing `drive()` function using the learned profile.
4. **Verify** -- Composable verification checks (exit code, output patterns, file existence, shell commands).
5. **Heal** -- When tasks fail, the healer diagnoses root causes and patches prompts or timing for retry.
6. **Checkpoint** -- State is atomically saved after every batch for resume-safe operation.

Profiles replace hardcoded adapters for interaction. The driver already knows how to navigate any profiled tool. Adapters remain thin and only handle output parsing.

### Skill & Adapter Export

Learned profiles are the source of truth, but consumers need portable artifacts:

- **Skills** -- Standalone markdown documents that teach an agent how to launch, interact with, and interpret the states of a CLI tool. Generated per-tool via `clr export-skill` or composed from fragments via the skill compilation pipeline.
- **Adapter presets** -- TypeScript or JSON objects conforming to AgentThreader's `AdapterPreset` interface. Generated via `clr export-adapter`. Includes prompt delivery mode, default/forbidden args, error patterns, session management, and operational notes.
- **Adapter overrides** -- Manual corrections in `adapter-overrides.json` fill gaps that learning cannot yet discover automatically (e.g., forbidden flags, noise patterns). As learning improves, the file shrinks toward zero.

When an Anthropic API key is available, an LLM enhances classification, discovery, probe planning, sub-prompt detection, and orchestrator healing. Without it, all features degrade gracefully to heuristic-only operation.

## Architecture

```
src/
  cli.ts                     CLI entry point (commander-based)
  index.ts                   Library exports (profiles, skill gen, adapter gen)
  types.ts                   Shared type definitions
  term-utils.ts              ANSI escape stripping, diagnostic extraction, glob matching
  vt-screen.ts               VT100 screen buffer emulator

  runner/
    session.ts               node-pty session: spawn, I/O, settle detection, JSONL transcripts
    state-machine.ts         Transition-driven state machine (consumes profile.transitions[])
    driver.ts                Profile-driven tool interaction loop

  engine/
    transcript.ts            JSONL transcript parsing, segmentation, timing
    classifier.ts            Heuristic + LLM segment classification
    pattern-extractor.ts     N-gram extraction with glob generalization
    profile-manager.ts       Profile CRUD, pattern merging, sub-prompt registration
    discovery.ts             Tool capability discovery via --help
    state-verifier.ts        Git-based side-effect tracking
    probe-planner.ts         Adaptive probe strategy planning
    healer.ts                Learn failure diagnosis, healing decisions, patch application
    learn-state.ts           Checkpoint/resume for learn sessions

  export/
    skill-generator.ts       Generate skill markdown from a learned profile
    adapter-generator.ts     Generate AdapterPreset (TS/JSON) from a learned profile

  orchestration/
    types.ts                 Orchestrator types (TaskDef, Manifest, Policy, State)
    orchestrator.ts          Main loop: batch scheduling, task execution, heal trigger
    adapter.ts               OutputAdapter interface and adapter selection
    adapters/
      passthrough.ts         DriveResult IS the result (simplest adapter)
      sentinel.ts            Sentinel-wrapped JSON extraction (--print mode tools)
      interactive.ts         Raw output + state_diff evidence (TUI tools)
    healer.ts                Task failure diagnosis, prompt patching (LLM + deterministic)
    pool.ts                  Concurrency pool, Fibonacci batch sizing
    manifest.ts              Manifest loading, validation, cycle detection, topo sort
    state.ts                 State init, load, checkpoint, reconcile
    verify.ts                Generic verification pipeline

  llm/
    client.ts                Claude CLI wrapper (spawns `claude -p`) with call budget
    prompts.ts               Prompt templates for all LLM tasks
    parsers.ts               JSON response parsing and validation
    json-repair.ts           JSON repair for LLM output (fences, comments, trailing commas)
    heal-prompts.ts          Learn healer prompt template and decision parser

skill/                         Skill source & build pipeline
  build/
    manifest.json            Skill manifest (skill → source + fragment refs)
    compile.mjs              Compiler: resolves {{include:...}}, emits to compiled/
  fragments/
    domain/                  Reusable knowledge fragments (state-machine, interaction-modes, prompt-handling)
  skills/
    cli-tool-driver/         Root skill: cli-tool-driver.md (includes domain fragments)

compiled/                      Build output (per-platform skill files, gitignored)
  claude/                    SKILL.md
  cursor/                    rules/*.mdc + skills/*/SKILL.md
  windsurf/                  rules/*.md + skills/*/SKILL.md
  opencode/                  *.md
  codex/                     SKILL.md

adapter-overrides.json       Manual adapter overrides (prompt delivery, forbidden flags, noise patterns)
profiles/                    Learned tool profiles (JSON)
transcripts/                 Raw session recordings (JSONL)
state/                       Orchestrator run state (JSON)
```

## Prerequisites

- **Node.js** >= 20
- **Git** (for side-effect tracking with `--work-dir`)
- **`claude` CLI** (optional, for LLM-enhanced features) -- Claude Code CLI on PATH
- **Native build toolchain** for `node-pty`: `python3`, `make`, a C++ compiler
  (`gcc`/`g++` on Linux, Xcode Command Line Tools on macOS, Visual Studio Build
  Tools on Windows). This is only required at install time.

## Install

### As a CLI (global)

```bash
npm install -g cli-runner-learner
clr --help
```

### Run without installing (npx)

```bash
npx cli-runner-learner --help
npx -p cli-runner-learner clr learn --command claude --tool claude
```

### As a library dependency

```bash
npm install cli-runner-learner
```

```js
import {
  loadProfile,
  drive,
  Session,
  generateSkillMarkdown,
  profileToAdapterPreset,
} from "cli-runner-learner";
```

### Data directory

By default `clr` writes transcripts, learned profiles, learn-state, logs, and
generated skill/adapter outputs under `./.clr/` (relative to the current working
directory). Override with the `CLR_DATA_DIR` environment variable:

```bash
CLR_DATA_DIR=/var/lib/clr clr orchestrate --manifest ./m.json --state-dir /var/lib/clr/state
```

Bundled seed profiles ship inside the npm package (read-only) and are the
fallback when no matching profile is present under `$CLR_DATA_DIR/profiles/`.

## Setup from source

```bash
npm install
npm run build
```

### Quick Install (CLI + Skills)

```bash
bash install-local.sh
```

This builds the CLI, compiles skills from fragments, and installs compiled outputs to auto-detected IDE directories:

| IDE | Install path |
|-----|-------------|
| Claude | `~/.claude/skills/cli-tool-driver/SKILL.md` |
| Cursor | `~/.cursor/rules/cli-tool-driver.mdc` + `~/.cursor/skills/cli-tool-driver/SKILL.md` |
| Windsurf | `~/.codeium/windsurf/rules/cli-tool-driver.md` + `~/.codeium/windsurf/skills/cli-tool-driver/SKILL.md` |
| Codex | `~/.codex/skills/cli-tool-driver/SKILL.md` |

Flags:

- `--skills-only` -- Skip build, just copy compiled skills
- `--compile-only` -- Just compile skills, don't install
- `--uninstall` -- Remove installed skills from all IDE directories

### LLM Configuration

LLM features use the `claude` CLI (`claude -p`), not the Anthropic SDK. If `claude` is on PATH, LLM-enhanced classification, probe planning, discovery, sub-prompt detection, and healing are available. If not, everything falls back to heuristics.

Default model: `opus` (passed as `--model opus` to the CLI). Override via `createLLMClient({ model: "sonnet" })`.

## CLI Commands

### `clr learn` -- Learn a tool's behavior

Runs the full learning cycle: discovery, probing, classification, pattern extraction, and profile generation.

```bash
clr learn --tool <id> --command <path> [options]
```

| Option | Default | Description |
|---|---|---|
| `--tool <id>` | required | Identifier for the profile (e.g., `claude`, `git-status`) |
| `--command <path>` | required | Path to the CLI tool binary |
| `--args <args>` | `""` | Default arguments (space-separated) |
| `--rounds <n>` | `4` | Maximum probe rounds |
| `--settle-timeout <ms>` | `5000` | Silence threshold to consider the tool settled |
| `--max-probe <ms>` | `45000` | Max duration per probe session |
| `--confidence <threshold>` | `0.8` | Stop learning when profile confidence reaches this |
| `--mode <mode>` | `interactive` | `interactive` (wait for prompt, type input) or `args` (append input as CLI args) |
| `--heal <mode>` | `off` | Healing mode: `off`, `auto` (LLM + heuristic), `manual` |
| `--max-heal-rounds <n>` | `4` | Maximum healing rounds before stopping |
| `--resume` | -- | Resume a previously interrupted learn session |

Examples:

```bash
# Learn an interactive tool
clr learn --tool claude --command claude

# Learn a non-interactive tool
clr learn --tool echo --command /bin/echo --mode args

# Learn with self-healing enabled
clr learn --tool claude --command claude --heal auto --rounds 8

# Resume a previously interrupted session
clr learn --tool claude --command claude --resume
```

### `clr run` -- Drive a tool using a learned profile

Sends input to a tool and captures its response, using the learned state machine to manage the interaction.

```bash
clr run --tool <id> --input <text> [options]
```

| Option | Default | Description |
|---|---|---|
| `--tool <id>` | required | Tool identifier (must have a learned profile) |
| `--input <text>` | required | Text input to send to the tool |
| `--settle-timeout <ms>` | `5000` | Silence threshold |
| `--max-session <ms>` | `120000` | Maximum session duration |
| `--work-dir <path>` | -- | Directory to track for side effects via git |

### `clr export-skill` -- Generate a skill from a learned profile

Produces a standalone skill markdown file from a tool's learned profile. The skill teaches any agent how to launch, interact with, and interpret the tool's states.

```bash
clr export-skill --tool <id> [options]
```

| Option | Default | Description |
|---|---|---|
| `--tool <id>` | required | Tool ID (must have a learned profile) |
| `--output <path>` | `generated/skills/<tool>.md` | Output file path |
| `--no-overrides` | -- | Skip manual overrides from `adapter-overrides.json` |

The generated skill includes: launch command, state machine (recognition patterns, transitions, timing), sub-prompts, subcommands, flags, forbidden flags, noise patterns, and operational notes.

### `clr export-adapter` -- Generate an adapter preset from a learned profile

Produces an AgentThreader-compatible `AdapterPreset` from a tool's learned profile.

```bash
clr export-adapter --tool <id> [options]
```

| Option | Default | Description |
|---|---|---|
| `--tool <id>` | required | Tool ID (must have a learned profile) |
| `--format <fmt>` | `ts` | Output format: `ts` (TypeScript) or `json` |
| `--output <path>` | `generated/adapters/<tool>-preset.<ext>` | Output file path |
| `--no-overrides` | -- | Skip manual overrides from `adapter-overrides.json` |

### `clr orchestrate` -- Orchestrate tasks across LLM CLI tools

Dispatches a manifest of tasks to LLM CLI tools using learned profiles. Supports batching, concurrency, dependency ordering, verification, healing, and checkpoint/resume.

```bash
clr orchestrate --manifest <path> [options]
```

| Option | Default | Description |
|---|---|---|
| `--manifest <path>` | required | Path to task manifest JSON |
| `--resume` | -- | Resume a previously interrupted run |
| `--concurrency <n>` | `1` | Number of concurrent tasks |
| `--dry-run` | -- | Print task plan without executing |
| `--state-dir <path>` | `./state` | Directory for state files |
| `--llm-budget <n>` | `20` | Max LLM calls for healer |
| `--status` | -- | Print current run state summary and exit |

Examples:

```bash
# Dry run to inspect the plan
clr orchestrate --manifest tasks.json --dry-run

# Execute with default settings
clr orchestrate --manifest tasks.json

# Execute with concurrency
clr orchestrate --manifest tasks.json --concurrency 3

# Resume an interrupted run
clr orchestrate --manifest tasks.json --resume

# Check status of a run
clr orchestrate --manifest tasks.json --status
```

### `clr discover` -- Discover tool capabilities

Parses a tool's `--help` output to extract subcommands, flags, and interactivity. Uses LLM for structured parsing when available, falls back to regex extraction.

```bash
clr discover --command <path>
```

### `clr record` -- Record a raw session

Spawns a tool in a PTY, waits for it to settle, sends ctrl-c to exit, and saves the transcript. Useful for manual inspection and debugging.

```bash
clr record --command <path> [--args <args>] [--settle-timeout <ms>] [--max-session <ms>] [--id <session-id>]
```

### `clr classify` -- Classify a recorded transcript

Segments a recorded transcript and classifies each segment into tool states.

```bash
clr classify --transcript <path> [--profile <tool-id>]
```

### `clr inspect` -- Inspect a raw transcript

Dumps a recorded transcript's segments and timing information.

```bash
clr inspect --transcript <path> [--raw]
```

## Task Manifest Format

```json
{
  "version": "1.0",
  "policy": {
    "concurrency": 2,
    "max_worker_attempts_per_task": 3,
    "heal_schedule": "auto",
    "batch_strategy": "fibonacci",
    "failure_threshold": 0.2
  },
  "shared_context": "You are working on a TypeScript project.",
  "verify_profiles": {
    "code-change": {
      "steps": [
        { "name": "tool-succeeded", "check": "exit_code" },
        { "name": "files-changed", "check": "file_exists", "files": ["src/index.ts"] }
      ]
    }
  },
  "tasks": [
    {
      "id": "refactor-auth",
      "tool_id": "claude",
      "input": "Refactor the auth module to use JWT",
      "work_dir": "/path/to/project",
      "timeout_sec": 300,
      "verify": "code-change",
      "depends_on": []
    },
    {
      "id": "add-tests",
      "tool_id": "gemini",
      "input": "Write unit tests for the JWT auth module",
      "work_dir": "/path/to/project",
      "timeout_sec": 300,
      "depends_on": ["refactor-auth"]
    }
  ]
}
```

**Task fields:**

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique task identifier |
| `tool_id` | yes | References a learned profile in `profiles/<tool_id>.json` |
| `input` | yes* | Prompt text to send to the tool |
| `input_ref` | no | Path to file containing input (alternative to `input`) |
| `depends_on` | yes | Task IDs that must complete before this one starts |
| `timeout_sec` | no | Per-task timeout (default: 300) |
| `work_dir` | no | Directory for side-effect tracking |
| `verify` | no | Name of a verify profile from manifest |
| `adapter_override` | no | Force adapter: `passthrough`, `sentinel`, or `interactive` |
| `priority` | no | Lower number = higher priority |
| `metadata` | no | Arbitrary key-value pairs |

**Policy fields:**

| Field | Default | Description |
|---|---|---|
| `concurrency` | `1` | Max parallel tasks per batch |
| `max_worker_attempts_per_task` | `2` | Max attempts before escalating |
| `max_heal_rounds_per_window` | `2` | Max heal rounds per batch window |
| `max_total_heal_rounds` | `8` | Max heal rounds for entire run |
| `failure_threshold` | `0.2` | Failure rate that triggers batch size reduction |
| `heal_schedule` | `auto` | `auto`, `off`, `task`, `batch` |
| `batch_strategy` | `fibonacci` | `fibonacci` (adaptive sizing) or `fixed` |

### Orchestrator Output Adapters

Adapters parse tool output into structured task results. Selected automatically based on profile interaction mode:

| Adapter | When used | Behavior |
|---|---|---|
| `passthrough` | Default fallback | DriveResult = TaskResult. Success if drive succeeded. |
| `sentinel` | `args` mode tools | Injects sentinel markers into input, extracts JSON between `<<<TASK_RESULT>>>` sentinels. |
| `interactive` | `interactive` mode tools | Success = drive completed + (state_diff shows changes OR output non-empty). |

Override per-task with `adapter_override`.

### Orchestrator Healing

When tasks fail, the orchestrator healer diagnoses root causes and applies patches:

| Failure Class | Description | Deterministic Fix |
|---|---|---|
| `tool_crash` | Tool process crashed or exited unexpectedly | Retry (transient) |
| `timeout` | Task hit deadline | Double timeout |
| `output_format` | Adapter could not parse output | Append JSON formatting hint |
| `verification_failed` | Verify steps failed | Escalate |
| `prompt_gap` | Prompt was insufficient | Append specificity hint |
| `transient_infra` | Network error, rate limit | Retry unchanged |

With an LLM, the healer sends full diagnostic context (failure signatures, error text, diagnostic lines) and gets structured patch decisions. Patches target:

- **shared_context** -- text appended to all task inputs
- **task_input** -- replacement input for a specific task
- **timing** -- adjust task timeout

### Batch Scheduling

Tasks are topologically sorted by `depends_on`, then processed in Fibonacci-scaled batches:

- Batch sizes: 1, 2, 3, 5, 8, 13, 21, 34, 55, 89
- On success: grow batch size
- On high failure rate (above `failure_threshold`): shrink batch size
- Blocked tasks (unmet dependencies) are deferred automatically

### Checkpoint and Resume

Orchestrator state is atomically saved to `<state-dir>/state.json` after every batch. Use `--resume` to continue an interrupted run. The state tracks per-task status, failure signatures, healing rounds, and prompt patches.

## Skill System

The skill system compiles reusable knowledge from fragments into platform-specific skill files for multiple IDEs/agents.

### Structure

```
skill/
  build/manifest.json          Declares skills and their fragment dependencies
  build/compile.mjs            Compiler (resolves includes, emits per-platform)
  fragments/domain/            Reusable markdown fragments
    state-machine.md           The 7-state model, transitions, working↔thinking overlap
    interaction-modes.md       Interactive vs args mode, prompt delivery
    prompt-handling.md         Sub-prompts, sentinel pattern, auto-response
  skills/cli-tool-driver/
    cli-tool-driver.md         Root skill (uses {{include:...}} directives)
```

### Fragment Inclusion

Skill source files use `{{include:domain/state-machine.md}}` directives that are resolved at compile time. Fragments can include other fragments (recursive resolution).

### Compilation

```bash
npm run compile              # Build compiled/ directory
npm run compile:validate     # Validate fragment references only
npm run compile:watch        # Rebuild on changes (file polling)
```

The compiler reads `skill/build/manifest.json`, resolves all `{{include:...}}` references, and emits platform-wrapped output to `compiled/`:

| Platform | Output |
|----------|--------|
| Claude | `compiled/claude/<skill>/SKILL.md` |
| Cursor | `compiled/cursor/rules/<skill>.mdc` + `compiled/cursor/skills/<skill>/SKILL.md` |
| Windsurf | `compiled/windsurf/rules/<skill>.md` + `compiled/windsurf/skills/<skill>/SKILL.md` |
| Opencode | `compiled/opencode/<skill>.md` |
| Codex | `compiled/codex/<skill>/SKILL.md` |

### Per-Tool Skills (Generated)

In addition to the compiled generic skill, `clr export-skill` generates a **per-tool** skill markdown from a specific learned profile. This includes the tool's actual recognition patterns, timing, subcommands, flags, sub-prompts, and operational notes -- everything an agent needs to drive that specific tool.

## Adapter Overrides

`adapter-overrides.json` provides manual corrections for adapter preset generation. Each entry is keyed by `tool_id` and can override:

| Field | Type | Description |
|-------|------|-------------|
| `promptDelivery` | `"stdin"` \| `"positional-arg"` \| `"flag"` | How to pass the prompt |
| `promptFlag` | string | Flag name when `promptDelivery` is `"flag"` |
| `defaultArgs` | string[] | Default CLI arguments for batch mode |
| `forbiddenArgs` | `{flag, reason}[]` | Args that cause failures |
| `stdinIgnore` | boolean | Tool does not read from stdin pipe |
| `toolCallsHiddenInStdout` | boolean | Need session show for full transcript |
| `needsLineBuffering` | boolean | Tokens arrive as separate writes |
| `maxTurns` | number | Turn limit for the tool |
| `noisePatterns` | string[] | Non-actionable stderr lines to filter |
| `transientErrorPatterns` | string[] | Retryable error patterns |
| `notes` | string[] | Operational notes for the preset |

Overrides are merged into both skill and adapter preset generation. The file is designed to shrink as learning capabilities improve.

## Library Exports

The package exports a programmatic API via `src/index.ts` for use by other packages (e.g., AgentThreader):

```typescript
import {
  loadProfile,
  saveProfile,
  bootstrapProfile,
  generateSkillMarkdown,
  profileToAdapterPreset,
  generateAdapterTypeScript,
  generateAdapterJSON,
  loadAdapterOverrides,
} from "cli-runner-learner";

import type {
  ToolProfile,
  GeneratedAdapterPreset,
  AdapterOverride,
} from "cli-runner-learner";
```

## Tool Profiles

Profiles are JSON files in `profiles/` that encode everything learned about a tool:

- **State indicators** -- Glob patterns that identify when the tool is in a given state
- **Transitions** -- Valid state transitions (e.g., `startup -> ready`, `working -> completed`)
- **Sub-prompts** -- Patterns for intermediate prompts (y/n confirmations, selections) with auto-responses
- **Timing** -- Typical startup time, idle thresholds, max session duration
- **Discovery** -- Parsed help text, subcommands, flags, interactivity
- **Learned patterns** -- Raw patterns with confidence scores and occurrence counts
- **Reduce-motion env** -- Environment variables to suppress animations during automated use

### Tool States

| State | Description |
|---|---|
| `startup` | Tool is initializing |
| `ready` | Tool is waiting for input |
| `working` | Tool is actively processing |
| `thinking` | Tool is reasoning/computing (subset of working) |
| `prompting` | Tool is asking for user input (sub-prompt) |
| `completed` | Tool finished successfully |
| `error` | Tool encountered an error |

### State Machine

The driver uses a transition-driven state machine defined by each profile's `transitions[]` array. Different tools can have different valid transitions -- an interactive REPL allows `working -> ready -> working` cycles, while a batch tool only allows `working -> completed`.

## LLM Integration

When `claude` CLI is available, the system uses it for:

- **Classification** -- LLM fallback when heuristic confidence is below 0.3
- **Discovery** -- Structured parsing of `--help` output into subcommands, flags, and interactivity
- **Probe planning** -- Adaptive strategy selection based on profile state and probe history
- **Sub-prompt detection** -- Identifies prompt types and suggests safe auto-responses
- **Orchestrator healing** -- Diagnoses task failures and generates prompt patches

All LLM calls are budgeted. Each call spawns `claude -p --output-format text --model opus --max-turns 1` with the prompt on stdin. Every feature works without the CLI -- the LLM is an enhancement layer, not a requirement.

## Self-Healing Learn Loop

When enabled with `--heal auto`, the learn loop becomes self-correcting. After each probe round, if confidence improvement stalls (delta < 2%), the system diagnoses why learning is stuck and applies targeted patches before retrying.

### How It Works

```
probe round -> classify -> extract patterns -> check confidence
                                                    |
                                              delta < 2%?
                                                    |
                                      diagnose failures -> heal -> apply patches
                                                    |
                                              RETRY / STOP / ACCEPT_PARTIAL
```

1. **Diagnosis** -- Examines the profile and probe history to identify specific failure classes
2. **Healing** -- With LLM: sends diagnostic context to a healer model for structured JSON decisions. Without LLM: applies deterministic heuristics
3. **Patch Application** -- Modifies the profile (classification hints, timing knobs, state descriptions) and suggests the next probe strategy
4. **Convergence Check** -- If the same failure signatures repeat after healing, the loop stops (non-convergent)

### Learn Failure Classes

| Class | Description | Deterministic Fix |
|---|---|---|
| `state_gap` | States with zero learned patterns | Probe targeting the empty state |
| `classification_ambiguous` | Segments classified with low confidence (<0.3) | Increase settle timeout by 50% |
| `probe_no_output` | Probe produced no classified segments | Try discovered subcommands or send `help` |
| `pattern_noise` | Patterns appearing across multiple states | (LLM only) |
| `probe_timeout` | Session hit max duration | (LLM only) |
| `tool_crash` | Tool exited with error state | (LLM only) |
| `convergence_plateau` | Confidence not improving across rounds | Stop |

### Learn Heal Patch Targets

| Target | Effect |
|---|---|
| `probe_strategy` | Override next probe strategy and input |
| `classification_hint` | Add glob pattern indicators to specific states |
| `timing_knob` | Adjust `settle_timeout_ms` or `max_probe_session_ms` |
| `profile_state` | Update state descriptions |

Patches are bounded for safety: max 3 pattern additions per heal round, patterns must be under 60 chars, timing adjustments capped at 2x the original values.

### Learn Checkpoint and Resume

Learn sessions are checkpointed to `profiles/<toolId>.learn-state.json` after every probe round and healing decision. Use `--resume` to continue an interrupted session:

```bash
# Start a long learning session
clr learn --tool claude --command claude --heal auto --rounds 12

# Interrupt with ctrl-c, then resume later
clr learn --tool claude --command claude --resume
```

### Failure Signatures

Failures are normalized into stable signatures by stripping paths, timestamps, UUIDs, and large numbers. Format: `<failure_class>:<normalized_signal>`. Identical failures cluster together across rounds. This mechanism is shared between the learn healer and the orchestrator healer.

## PTY Harness

The `Session` class (`src/runner/session.ts`) provides a cross-platform PTY environment via `node-pty`. It:

- Spawns the target command with full terminal emulation (macOS, Linux, Windows)
- Records all I/O to a JSONL transcript (hex-encoded bytes with timestamps)
- Emits structured events: `started`, `output`, `settled`, `exit`
- Supports rich keyboard input: Tab, Shift-Tab, Esc, arrows, Ctrl-C, Ctrl-D, Enter
- Detects "settled" state after configurable silence threshold
- Sets `REDUCE_MOTION=1` universally plus tool-specific reduce-motion env vars

## Side-Effect Tracking

The `--work-dir` option on `clr run` and task manifests uses git to track filesystem changes:

1. Captures a state snapshot before execution (commit hash, tracked/untracked/modified files)
2. Captures another snapshot after execution
3. Produces a diff summary: new files, modified files, deleted files, raw diff

Works with existing git repos. For non-git directories, returns a minimal snapshot.

## Development

```bash
npm run typecheck           # Type-check without emitting
npm run build               # Compile TypeScript to dist/
npm run cli -- <args>       # Run CLI from source via dist/
npm run compile             # Compile skills from fragments
npm run compile:validate    # Validate fragment references
npm run compile:watch       # Rebuild skills on changes
npm run setup               # Full build + install skills to IDEs
npm run setup:skills        # Install skills only (skip build)
npm run uninstall-skills    # Remove installed skills from IDEs
```

## Typical Workflow

```bash
# 1. Learn each tool you want to orchestrate
clr learn --tool claude --command claude --heal auto --rounds 8
clr learn --tool crush --command crush --heal auto --rounds 16

# 2. Verify profiles work
clr run --tool claude --input "hello"
clr run --tool crush --input "hello"

# 3. Export skills and adapter presets
clr export-skill --tool claude
clr export-skill --tool crush
clr export-adapter --tool claude --format json
clr export-adapter --tool crush --format ts

# 4. Compile and install skills to IDEs
npm run compile
bash install-local.sh --skills-only

# 5. Write a task manifest
cat > tasks.json << 'EOF'
{
  "version": "1.0",
  "tasks": [
    { "id": "task-1", "tool_id": "claude", "input": "Do the thing", "timeout_sec": 120, "depends_on": [] },
    { "id": "task-2", "tool_id": "crush", "input": "Check the thing", "timeout_sec": 120, "depends_on": ["task-1"] }
  ]
}
EOF

# 6. Dry run to check the plan
clr orchestrate --manifest tasks.json --dry-run

# 7. Execute
clr orchestrate --manifest tasks.json --concurrency 2

# 8. If interrupted, resume
clr orchestrate --manifest tasks.json --resume
```
