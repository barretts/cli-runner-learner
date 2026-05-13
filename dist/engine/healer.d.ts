import type { ToolProfile, ProbeResult, LearnFailureClass, LearnHealDecision } from "../types.js";
import type { LLMClient } from "../llm/client.js";
export interface LearnDiagnosis {
    failure_class: LearnFailureClass;
    signature: string;
    detail: string;
}
/**
 * Stable failure signature for learning failures.
 * Adapted from 3pp-fix-database parser.ts stableFailureSignature.
 * Strips volatile parts so identical failures cluster together.
 */
export declare function stableLearnFailureSignature(failureClass: string, signal: string): string;
/**
 * Examine probe results and profile state to diagnose WHY learning is stuck.
 * Returns a list of specific failures with stable signatures.
 */
export declare function diagnoseLearnFailures(probes: ProbeResult[], profile: ToolProfile): LearnDiagnosis[];
export interface HealerContext {
    profile: ToolProfile;
    completedProbes: ProbeResult[];
    confidenceHistory: number[];
    failureSignatures: string[];
    diagnosticLines?: string;
    config: {
        settle_timeout_ms: number;
        max_probe_session_ms: number;
    };
}
/**
 * Diagnose and heal learning failures.
 * With LLM: send context to healer model, parse structured decision.
 * Without LLM: deterministic heuristic healing.
 */
export declare function heal(ctx: HealerContext, llmClient: LLMClient | null): Promise<LearnHealDecision>;
/**
 * Apply healer patches to a profile. Returns a new profile (no mutation).
 * Patches are bounded: max 3 pattern additions, timing capped at 2x original.
 */
export declare function applyHealPatches(profile: ToolProfile, decision: LearnHealDecision, originalConfig?: {
    settle_timeout_ms: number;
    max_probe_session_ms: number;
}): {
    profile: ToolProfile;
    configOverrides: Record<string, number>;
};
