/**
 * Orchestration layer types.
 * Ported from 3pp-fix-database/src/types.ts with vuln-specific fields removed.
 */
export const DEFAULT_POLICY = {
    max_worker_attempts_per_task: 2,
    max_heal_rounds_per_window: 2,
    max_total_heal_rounds: 8,
    signature_repeat_limit: 2,
    failure_threshold: 0.2,
    heal_schedule: "auto",
    batch_strategy: "fibonacci",
    concurrency: 1,
};
export function isParserFailure(v) {
    return "kind" in v;
}
// ---- Failure Classes ----
export const ORCH_FAILURE_CLASSES = [
    "tool_crash",
    "timeout",
    "output_format",
    "verification_failed",
    "wrong_output",
    "prompt_gap",
    "transient_infra",
];
//# sourceMappingURL=types.js.map