/**
 * Orchestration layer types.
 * Ported from 3pp-fix-database/src/types.ts with vuln-specific fields removed.
 */

import type { DriveResult, StateDiff, ToolState } from "../types.js";

// ---- Policy ----

export interface Policy {
  max_worker_attempts_per_task: number;
  max_heal_rounds_per_window: number;
  max_total_heal_rounds: number;
  signature_repeat_limit: number;
  failure_threshold: number;
  heal_schedule: "auto" | "off" | "task" | "batch";
  batch_strategy: "fibonacci" | "fixed";
  concurrency: number;
  batch_size?: number;
}

export const DEFAULT_POLICY: Policy = {
  max_worker_attempts_per_task: 2,
  max_heal_rounds_per_window: 2,
  max_total_heal_rounds: 8,
  signature_repeat_limit: 2,
  failure_threshold: 0.2,
  heal_schedule: "auto",
  batch_strategy: "fibonacci",
  concurrency: 1,
};

// ---- Verification ----

export interface VerifyStep {
  name: string;
  check: "exit_code" | "output_contains" | "file_exists" | "command";
  pattern?: string;
  files?: string[];
  command?: string;
  timeout_sec?: number;
}

export interface VerifyProfile {
  steps: VerifyStep[];
}

// ---- Task & Manifest ----

export interface TaskDef {
  id: string;
  tool_id: string;
  input: string;
  input_ref?: string;
  depends_on: string[];
  timeout_sec: number;
  work_dir?: string;
  verify?: string;
  adapter_override?: string;
  priority?: number;
  metadata?: Record<string, string>;
}

export interface Manifest {
  version: "1.0";
  policy?: Partial<Policy>;
  verify_profiles?: Record<string, VerifyProfile>;
  shared_context?: string;
  shared_context_ref?: string;
  tasks: TaskDef[];
}

// ---- Task Result ----

export interface TaskResult {
  task_id: string;
  status: "DONE" | "FAILED" | "BLOCKED";
  output: string;
  summary?: string;
  evidence?: {
    state_diff?: StateDiff;
    final_state?: ToolState;
    duration_ms?: number;
    transcript_path?: string;
  };
  failure_class?: OrchFailureClass;
}

export interface ParserFailure {
  kind: "no_sentinel" | "invalid_json" | "parse_error";
  error: string;
  raw?: string;
}

export function isParserFailure(v: TaskResult | ParserFailure): v is ParserFailure {
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
] as const;

export type OrchFailureClass = typeof ORCH_FAILURE_CLASSES[number];

// ---- Per-Task State ----

export type PerTaskStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "BLOCKED" | "ESCALATED";

export interface TaskHistory {
  attempt: number;
  status: string;
  timestamp: string;
  failure_signature?: string;
  summary?: string;
  duration_ms?: number;
}

export interface PerTaskState {
  status: PerTaskStatus;
  attempts: number;
  failure_signature?: string;
  failure_signatures_seen?: string[];
  last_error?: string;
  last_output_tail?: string;
  history?: TaskHistory[];
}

// ---- Orchestrator State ----

export type RunStatus = "RUNNING" | "COMPLETED" | "ABORTED";

export interface HealingRound {
  round: number;
  scope: "task" | "batch";
  window_size: number;
  failed_tasks: string[];
  decision: string;
  patches_applied: number;
  timestamp: string;
}

export interface OrchestratorState {
  version: "1.0";
  run_id: string;
  run_status: RunStatus;
  abort_reason?: string;
  manifest_digest: string;
  started_at: string;
  updated_at: string;
  policy: Policy;
  tasks: Record<string, PerTaskState>;
  healing_rounds: HealingRound[];
  current_batch_index?: number;
  current_batch_size?: number;
  prompt_patches?: Record<string, string>;
  shared_context_patches?: string[];
}

// ---- Healing ----

export interface OrchHealPatch {
  target: "shared_context" | "task_input" | "timing";
  operation: "replace" | "append";
  content: string;
  task_id?: string;
}

export interface OrchHealDecision {
  decision: "RETRY" | "ESCALATE" | "NOT_FIXABLE";
  failure_class: OrchFailureClass;
  root_cause: string;
  patches: OrchHealPatch[];
  learned_rule?: string;
  escalations?: Array<{ task_id: string; reason: string }>;
  retry_tasks?: string[];
}
