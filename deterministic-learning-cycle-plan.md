# Deterministic Learning Cycle Improvement Plan

## Project Context (Current Loop)
- **Learn flow**: discover -> probe -> classify -> extract -> merge -> profile -> drive.
- **Non-determinism sources**: LLM-assisted discovery/classification/probe planning, heuristic thresholds, transcript segmentation, output normalization, and pattern promotion.
- **Deterministic fallback** exists (probe planning cycle, regex discovery, heuristics), but results vary with timing, tool output drift, and LLM variability.

## Objectives
1. Make learn results repeatable for the same tool+version+inputs.
2. Preserve useful LLM enhancements while bounding variance.
3. Improve confidence scoring and convergence stability.

## Determinism Levers (Design Targets)
- **Stable inputs**: freeze env, args, terminal size, and timing parameters per run.
- **Consistent segmentation**: deterministic segmenter and gap thresholds.
- **Repeatable probing**: fixed probe schedule or seeded strategy selection.
- **Deterministic classifiers**: normalize outputs, apply ordered rule sets, consistent thresholds.
- **Deterministic pattern extraction**: fixed n-gram sizes, stable ordering, and tie-breaking.
- **Consistent profile merging**: stable confidence aggregation and promotion rules.
- **LLM bounded variability**: temperature 0, structured outputs, caching and replay.

## Proposed Improvements
### 1) Deterministic Configuration Capsule
- Add a `learning_config` object stored in the profile and emitted in transcripts:
  - terminal cols/rows, settle timeout, max session, probe round count, segmentation gap.
  - tool version, env allowlist, working dir hash.
- Use this capsule to **validate** reproducibility (warn on mismatches).

### 2) Fixed Probe Strategy with Seeded Variation
- Default to a deterministic probe schedule for baseline runs:
  - observe -> enter -> input("hello") -> prompt_response.
- Optional: allow LLM plan **only after** deterministic baseline or with `--seed` and plan caching.

### 3) Classification Stability
- Normalize transcript text more aggressively:
  - strip ANSI, collapse whitespace, remove timestamps, normalize prompts.
- Order heuristic checks consistently and **pin thresholds** in config.
- Record rule hit details in `reason` to allow exact replay.

### 4) Pattern Extraction Determinism
- Fix n-gram sizes and use stable sorting before promotion.
- Promote patterns only after a minimum number of occurrences **and** stable confidence over N rounds.
- Make glob generalization deterministic (ordered substitutions, stable tie-breaks).

### 5) Profile Merge Convergence Rules
- Use weighted moving average with explicit decay.
- Require multiple confirmations to flip states or add indicators.
- Track “pattern provenance” (rounds and segment IDs) for replay.

### 6) LLM Guardrails
- Enforce temperature 0, top_p 1, and structured output schemas.
- Cache LLM calls by (prompt, tool_id, tool_version, round) and replay on retry.
- Allow a `--no-llm` deterministic mode as first-class behavior.

### 7) Replay + Verification Harness
- Add a `replay` command to re-run learning on a saved transcript set.
- Provide a `determinism score`:
  - % identical classified segments, % identical patterns, profile hash equality.

## Implementation Plan (Phased)
### Phase 1: Deterministic Baseline
- Persist learning_config in profile and transcript metadata.
- Add a `--deterministic` flag that disables LLM and fixes probe schedule.
- Freeze terminal size for sessions and save in metadata.

### Phase 2: Stability Enhancements
- Update classifier to normalize text consistently and pin thresholds.
- Make pattern extraction deterministic with stable sorting and promotion rules.
- Add pattern provenance and multi-round confirmation before promotion.

### Phase 3: Bounded LLM Variance
- Add LLM call cache keyed by deterministic inputs.
- Enforce structured outputs and deterministic sampling parameters.
- Add “LLM replay” mode for identical outputs when prompts match.

### Phase 4: Replay + Metrics
- Implement `clr replay --tool <id> --transcripts <glob>`.
- Emit determinism score report to logs and profile.

## Success Metrics
- **Repeatability**: identical profile JSON for same inputs across 3 runs.
- **Stability**: >= 95% segment state agreement across runs.
- **Convergence**: reach confidence threshold in <= N rounds consistently.

## Risks & Mitigations
- **Over-constraint**: may miss nuanced prompts -> allow opt-in LLM after baseline.
- **Tool drift**: versions change outputs -> store tool_version and warn.
- **Timing variance**: use fixed timeouts and record timing profiles for replay.
