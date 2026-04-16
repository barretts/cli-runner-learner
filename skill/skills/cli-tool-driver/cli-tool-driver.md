---
name: cli-tool-driver
version: "1.0"
description: "Drive CLI tools using learned profiles. Covers launching, state detection, prompt handling, and output parsing for any tool learned by cli-runner-learner. Use when the user mentions: drive a tool, run a CLI agent, automate a command, export a skill, export an adapter, learn a tool, or interact with crush/opencode/claude/cursor."
---

# CLI Tool Driver

Automate CLI tools using profiles learned by cli-runner-learner. Each tool is modeled as a 7-state machine with learned recognition patterns, timing, and prompt handling.

---

## When To Use This Skill

- Automating an interactive CLI tool (crush, opencode, claude, cursor)
- Running batch prompts against a CLI agent
- Generating adapter presets for AgentThreader
- Learning a new tool's behavior automatically
- Reading a generated per-tool skill to understand how to drive it

---

{{include:domain/state-machine.md}}

---

{{include:domain/interaction-modes.md}}

---

{{include:domain/prompt-handling.md}}

---

## Learning a New Tool

To learn a new tool's behavior:

```bash
clr learn --tool <id> --command <binary> --heal auto --rounds 16
```

This runs a probing cycle that:
1. Discovers the tool (parses `--help`, detects subcommands, flags, interaction mode)
2. Runs probe strategies (observe, input, multi_turn, shortcut, ctrl_c, explore)
3. Classifies transcript segments into the 7 states
4. Extracts stable patterns from classified data
5. Heals classification failures with LLM-guided adjustments
6. Saves a profile to `profiles/<id>.json`

### Healing

When confidence stalls, the healer diagnoses failures:
- **state_gap**: A state has zero learned patterns → tries different probe strategies
- **pattern_noise**: Patterns appear in multiple states → adjusts timing, filters chrome
- **classification_ambiguous**: Low-confidence segments → refines heuristics
- **probe_timeout**: Tool took too long → adjusts settle timeout

## Exporting Skills

Generate a standalone skill markdown from a learned profile:

```bash
clr export-skill --tool crush
# → generated/skills/crush.md
```

The skill teaches any agent how to drive the tool: launch command, state recognition patterns, transitions, timing, sub-prompts, subcommands, and flags.

## Exporting Adapter Presets

Generate an AgentThreader-compatible adapter preset:

```bash
clr export-adapter --tool crush
# → generated/adapters/crush-preset.ts

clr export-adapter --tool crush --format json
# → generated/adapters/crush-preset.json
```

The preset maps the learned profile to AgentThreader's `AdapterPreset` interface, providing prompt delivery mode, args, timeout config, error patterns, session management, and operational notes.

## Driving a Learned Tool

Once a profile is learned, drive the tool programmatically:

```bash
clr drive --tool crush --input "What can you do?"
```

The driver:
1. Loads the tool's profile
2. Spawns the tool in a PTY
3. Waits for the `ready` state (matches profile indicators)
4. Sends the input
5. Monitors state transitions (working → thinking → working → ready)
6. Handles sub-prompts automatically
7. Extracts the output when the tool returns to `ready` or `completed`

## Profile Structure

Each learned profile contains:

| Field | Purpose |
|-------|---------|
| `tool_id`, `tool_command` | Identity |
| `interaction_mode` | `interactive` or `args` |
| `launch` | Args, env, PTY needs, startup timeout |
| `states` | 7 state definitions with indicators |
| `transitions` | State graph edges with triggers |
| `timing` | Startup, idle, max session durations |
| `learned_patterns` | High-confidence text patterns per state |
| `discovery` | Help text, subcommands, flags |
| `reduce_motion_env` | Env vars to suppress animations |
