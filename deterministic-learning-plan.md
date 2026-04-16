# Improving Deterministic Learning in CLI-Runner-Learner

Based on the architectural blueprint and the current implementation of the `cli-runner-learner` system, the core of "deterministic learning" relies on programmatic, heuristic fallbacks rather than probabilistic LLM inference. To create a more rigorous forced learning cycle, we must enhance the system's deterministic capabilities.

Here is the plan to improve the deterministic learning cycle:

### 1. Upgrade from "Blind Cycling" to Deterministic Fuzzing
*   **Current State:** In `src/engine/probe-planner.ts`, when an LLM is unavailable or the budget is exhausted, the system falls back to a static `FALLBACK_CYCLE` (`["observe", "enter", "input", "prompt_response"]`), where the `input` strategy blindly sends the string `"hello"`.
*   **Improvement:** Transition to a dynamic fuzzing strategy (as outlined in Phase VIII of the architecture document). `src/engine/discovery.ts` already extracts `subcommands` and `common_flags` via regex. The deterministic probe planner should dynamically generate its fallback cycle using these discovered capabilities. Instead of blindly sending `"hello"`, it should iteratively construct execution probes based on the tool's actual schema (e.g., trying each extracted subcommand sequentially). This turns the fallback into a structured fuzzing loop that systematically maps the tool's boundaries.

### 2. Implement State Verification During the Learning Phase
*   **Current State:** The Git-based side-effect tracking in `src/engine/state-verifier.ts` is currently only invoked via the `--work-dir` option during the `clr run` phase (the "driving" phase). The `clr learn` phase only observes terminal output.
*   **Improvement:** Wire the `state-verifier.ts` snapshotting directly into the *probing phase*. By taking a `git status` snapshot before and after a probe is executed during learning, the system can deterministically measure physical file system side effects. If a probe generates an output classified as `completed` but actually modified or deleted files (a Negative Side Effect), the learner can explicitly map that terminal state to a state-changing action, rather than relying solely on transient terminal text or zero-exit codes.

### 3. Separate PTY Streams for Deterministic Classification
*   **Current State:** `src/engine/classifier.ts` attempts to deterministically classify errors using a heuristic list of regex `ERROR_PATTERNS` (e.g., `/fatal\b/i`, `/ENOENT/`). This is brittle, as standard output can easily contain these words contextually.
*   **Improvement:** Standard POSIX applications separate output into `stdout` and `stderr`. The PTY harness (`harness/pty-recorder.exp`) and the overarching session manager should be updated to multiplex or track these streams distinctly. This allows the classifier to deterministically tag any segment outputted to `stderr` as an `error` state, bypassing the need for regex matching or LLM inference to detect application failures.

### 4. Advanced Deterministic Schema Mapping
*   **Current State:** The deterministic `regexDiscovery` fallback in `src/engine/discovery.ts` uses basic regex matching to guess flags and commands from raw help text.
*   **Improvement:** Adopt the strategy outlined in Phase IV of the architectural plan: programmatically translate unstructured help documentation into strict `JSON Schema`. Standardize the parsing heuristics to detect standard GNU and POSIX `-`/`--` argument formatting and standard `[OPTIONS] [COMMANDS]` syntax blocks. By deterministically inferring which inputs require arguments (e.g., `<value>`) and which are boolean flags, the system drastically reduces the trial-and-error required to establish a tool's baseline syntax.

### 5. Persist Deterministic Anti-Patterns (Negative Feedback)
*   **Current State:** `src/engine/pattern-extractor.ts` extracts and saves patterns that appear frequently across multiple runs with high confidence (positive reinforcement).
*   **Improvement:** Implement a mechanism to persist *negative* knowledge. If a deterministically generated fuzzing probe crashes the tool (evidenced by a non-zero exit code or explicit stderr output), the exact syntax used should be saved to the profile as an "Anti-Pattern" or "Invalid Syntax". This mimics Reinforcement Learning with Verifiable Rewards (RLVR), ensuring the agent is mathematically penalized for bad syntax and explicitly prevents it from attempting known-bad command structures in future driver sessions.
