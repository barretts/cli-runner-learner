/**
 * Orchestrator healer: diagnoses task failures and patches prompts.
 * Different from the learn healer -- this diagnoses TASK execution failures,
 * not LEARNING failures.
 */
import type { LLMClient } from "../llm/client.js";
import type { Manifest, OrchestratorState, OrchHealDecision, OrchFailureClass } from "./types.js";
export interface FailedTaskSummary {
    task_id: string;
    tool_id: string;
    failure_signature: string;
    last_error: string;
    diagnostic_lines?: string;
    attempts: number;
}
/**
 * Diagnose a single task failure into a failure class.
 */
export declare function diagnoseTaskFailure(lastError: string, driveSuccess: boolean): OrchFailureClass;
/**
 * Heal a batch of failed tasks. Uses LLM if available, otherwise deterministic.
 */
export declare function healBatch(failed: FailedTaskSummary[], state: OrchestratorState, manifest: Manifest, llmClient: LLMClient | null): Promise<OrchHealDecision>;
