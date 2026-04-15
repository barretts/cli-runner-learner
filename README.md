# cli-runner-learner (`clr`)

Autonomous learning system and orchestrator for interactive CLI tools. Spawns processes in a real PTY, records terminal I/O, classifies output into behavioral states, extracts patterns, and builds profiles that drive future interactions -- without hardcoded tool-specific logic. Orchestrates multiple LLM CLI tools (claude, gemini, opencode, crush, agent) through a manifest-driven task runner with adaptive healing.

## How It Works

### Learning Cycle

The system follows a **forced learning cycle** to build a behavioral profile for any CLI tool:

1. **Discover** -- Run the tool with `--help` and parse its capabilities (subcommands, flags, interactivity).
2. **Probe** -- Launch the tool in a PTY, apply probe strategies (observe, send input, send ctrl-c), and record everything.
3. **Classify** -- Segment the terminal transcript and classify each segment into a behavioral state (startup, ready, working, thinking, prompting, completed, error).
4. **Extract** -- Pull out recurring output patterns (n-grams generalized into glob patterns) and associate them with states.
5. **Profile** -- Merge patterns into a tool profile. High-confidence patterns become state indicators.
6. **Drive** -- Use the learned profile to interact with the tool autonomously: detect states via pattern matching, respond to sub-prompts, and track side effects.

### Orchestration

Once profiles are built, the **orchestrator** dispatches manifests of tasks to LLM CLI tools:

1. **Load profiles** -- Each task references a `tool_id` with a learned profile.
2. **Batch scheduling** -- Fibonacci-scaled batch sizing with concurrent execution.
3. **Drive** -- Each task is executed via the existing `drive()` function using the learned profile.
4. **Verify** -- Composable verification checks (exit code, output patterns, file existence, shell commands).
5. **Heal** -- When tasks fail, the healer diagnoses root causes and patches prompts or timing for retry.
6. **Checkpoint** -- State is atomically saved after every batch for resume-safe operation.

Profiles replace hardcoded adapters for interaction. The driver already knows how to navigate any profiled tool. Adapters remain thin and only handle output parsing.

When an Anthropic API key is available, an LLM enhances classification, discovery, probe planning, sub-prompt detection, and orchestrator healing. Without it, all features degrade gracefully to heuristic-only operation.

## Architecture

```
src/
  cli.ts                     CLI entry point (commander-based)
  types.ts                   Shared type definitions
  term-utils.ts              ANSI escape stripping, diagnostic extraction, glob matching
  vt-screen.ts               VT100 screen buffer emulator

  runner/
    session.ts               Async wrapper around the PTY harness
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

harness/
  pty-recorder.exp           Tcl/Expect script that spawns tools in a real PTY

profiles/                    Learned tool profiles (JSON)
transcripts/                 Raw session recordings (JSONL)
state/                       Orchestrator run state (JSON)
```

## Prerequisites

- **Node.js** >= 20
- **Tcl/Expect** (`expect` command available in PATH)
- **Git** (for side-effect tracking with `--work-dir`)
- **`claude` CLI** (optional, for LLM-enhanced features) -- Claude Code CLI on PATH

## Setup

```bash
npm install
npm run build
```

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

### Task Manifest Format

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

## Tool Profiles

Profiles are JSON files in `profiles/` that encode everything learned about a tool:

- **State indicators** -- Glob patterns that identify when the tool is in a given state
- **Transitions** -- Valid state transitions (e.g., `startup -> ready`, `working -> completed`)
- **Sub-prompts** -- Patterns for intermediate prompts (y/n confirmations, selections) with auto-responses
- **Timing** -- Typical startup time, idle thresholds, max session duration
- **Discovery** -- Parsed help text, subcommands, flags, interactivity
- **Learned patterns** -- Raw patterns with confidence scores and occurrence counts

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

The Expect script (`harness/pty-recorder.exp`) provides a real PTY environment. It:

- Spawns the target command with full terminal emulation
- Records all I/O to a JSONL transcript (hex-encoded bytes with timestamps)
- Emits structured events: `STARTED`, `OUTPUT`, `SETTLED`, `EXIT`
- Accepts commands via stdin: `SEND:enter`, `SEND:ctrl-c`, `SEND:text:<payload>`, `KILL`
- Detects "settled" state after configurable silence threshold

## Side-Effect Tracking

The `--work-dir` option on `clr run` and task manifests uses git to track filesystem changes:

1. Captures a state snapshot before execution (commit hash, tracked/untracked/modified files)
2. Captures another snapshot after execution
3. Produces a diff summary: new files, modified files, deleted files, raw diff

Works with existing git repos. For non-git directories, returns a minimal snapshot.

## Development

```bash
npm run typecheck    # Type-check without emitting
npm run build        # Compile TypeScript to dist/
npm run cli -- <args>  # Run CLI from source via dist/
```

## Typical Workflow

```bash
# 1. Learn each tool you want to orchestrate
clr learn --tool claude --command claude --heal auto --rounds 8
clr learn --tool gemini --command gemini --heal auto --rounds 8

# 2. Verify profiles work
clr run --tool claude --input "hello"
clr run --tool gemini --input "hello"

# 3. Write a task manifest
cat > tasks.json << 'EOF'
{
  "version": "1.0",
  "tasks": [
    { "id": "task-1", "tool_id": "claude", "input": "Do the thing", "timeout_sec": 120, "depends_on": [] },
    { "id": "task-2", "tool_id": "gemini", "input": "Check the thing", "timeout_sec": 120, "depends_on": ["task-1"] }
  ]
}
EOF

# 4. Dry run to check the plan
clr orchestrate --manifest tasks.json --dry-run

# 5. Execute
clr orchestrate --manifest tasks.json --concurrency 2

# 6. If interrupted, resume
clr orchestrate --manifest tasks.json --resume
```
