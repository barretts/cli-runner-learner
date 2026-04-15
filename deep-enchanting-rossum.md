# CLI Runner Learner -- Round 3 Plan

## Context

Rounds 1-2 proved the full loop: probe -> record -> classify -> generalize -> drive. We successfully automated Claude TUI (interactive) and crush batch mode (args). Round 2 added VT screen emulation, interaction modes, thinking state detection, and frame-based segmentation. This plan covers remaining work to make the system production-ready.

See `docs/findings-round2.md` for the full technical findings document.

---

## What Still Needs Work

### 1. VT Screen Output Filtering (P5)

**Problem:** The driver's VT replay returns the entire final screen -- startup banner, user prompt echo, response, and exit message all concatenated. For Claude: "Claude Code v2.1.109...test123...Resume this session with...". Only "test123" is the actual response.

**Approach:** Snapshot the VT screen state at key state transitions. Diff the "before input" snapshot against the "after response" snapshot to isolate new content. The driver already knows when it sends input (startup->working transition) -- take a snapshot there.

**Files:**
- `src/vt-screen.ts` -- add `snapshot(): string[]` and `diff(before, after): string[]`
- `src/runner/driver.ts` -- snapshot before sending input, diff after completion

### 2. Bubble Tea TUI Raw Mode (P6)

**Problem:** Crush interactive TUI enters raw mode (`[?1049h`, mouse tracking, Kitty keyboard protocol). It produces zero recv events during processing -- our PTY text injection doesn't reach its input handler. The harness records the initial setup sequences and exit cleanup, but nothing in between.

**Approach:** Two options:
- **A. Keystroke injection:** Send individual key bytes instead of bulk text. Map `sendText("hello\r")` to individual character writes with 10ms delays between them. This mimics how a real terminal sends keystrokes to raw-mode TUIs.
- **B. Accept the limitation:** Crush TUI interactive mode isn't needed -- CrushAdapter uses `crush run` (batch). Document the limitation and move on.

**Recommendation:** Option B for now. Keystroke injection is speculative and may not work if Bubble Tea's event loop doesn't poll the PTY fd during API calls. Add a `raw_mode_compat` flag to ToolProfile so the system knows to skip TUI learning for tools that don't produce output.

### 3. Batch Tool Pattern Extraction (P7)

**Problem:** Crush batch mode produces 0 learned patterns because output is too minimal and variable ("4", "Hello.", "Paris"). Pattern extraction requires repeated text across runs, but batch responses vary by input.

**Approach:** For `args` mode tools, extract structural patterns instead of content patterns:
- Exit code patterns (always 0 on success)  
- Output shape (single line, multi-line, JSON)
- Timing patterns (typical response time range)
- Error output patterns ("ERROR" prefix from crush)

**Files:**
- `src/engine/pattern-extractor.ts` -- add structural pattern extraction for args-mode profiles
- `src/types.ts` -- extend `StateIndicator` with `type: "exit_code"` and `type: "output_shape"`

### 4. Session Persistence for Multi-Step Pipelines (P8)

**Problem:** CrushAdapter in 3pp-fix-database uses `--session <id>` for a 4-step pipeline (analyze, generate, validate, extract). Each step reuses the session. Our driver currently handles single-shot interactions only.

**Approach:** Add a `DriveSequence` that chains multiple `drive()` calls with shared session args:
```typescript
interface DriveStep { input: string; expect_state?: ToolState; }
interface DriveSequenceOpts { steps: DriveStep[]; session_args?: string[]; }
```

Each step appends `--session <id>` to args (for args-mode tools) or sends input interactively. Session ID is extracted from step 1's output via a configurable regex.

**Files:**
- `src/runner/driver.ts` -- add `driveSequence()` function
- `src/types.ts` -- add DriveStep, DriveSequenceOpts

### 5. Integration with 3pp-fix-database (P9)

**Problem:** The ultimate goal is replacing CrushAdapter's 4-spawn pipeline with profile-driven driver calls.

**Approach:** Create a thin adapter in 3pp-fix-database that:
- Loads the crush-run profile from cli-runner-learner
- Maps TaskDef steps to DriveSequence steps
- Extracts the sentinel-tagged result from VT screen output
- Replaces the `extractSessionTranscript` 15s overhead

**Blocked by:** P5 (output filtering), P8 (session persistence)

---

## Implementation Order

1. P5: VT screen output filtering (unblocks clean output for all tools)
2. P7: Structural pattern extraction (improves batch tool profiles)
3. P8: Session persistence / multi-step (unblocks 3pp integration)
4. P9: 3pp-fix-database integration
5. P6: Bubble Tea raw mode (deferred -- document limitation)

---

## Verification

After P5+P7+P8:
1. `node dist/cli.js run --tool claude --input "say test"` -- output should be ONLY the response, not the startup banner
2. `node dist/cli.js run --tool crush-run --input "what is 2+2"` -- output "4", profile should have structural patterns
3. Multi-step crush drive with session persistence -- 4 sequential steps, shared session
4. Compare claude.json and crush-run.json profiles -- different interaction modes, different pattern types
