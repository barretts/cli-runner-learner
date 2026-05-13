/**
 * Orchestrator healer: diagnoses task failures and patches prompts.
 * Different from the learn healer -- this diagnoses TASK execution failures,
 * not LEARNING failures.
 */
import { safeParse } from "../llm/json-repair.js";
import { ORCH_FAILURE_CLASSES } from "./types.js";
/**
 * Diagnose a single task failure into a failure class.
 */
export function diagnoseTaskFailure(lastError, driveSuccess) {
    const err = lastError.toLowerCase();
    if (err.includes("timeout") || err.includes("timed out") || err.includes("deadline")) {
        return "timeout";
    }
    if (err.includes("econnrefused") || err.includes("econnreset") || err.includes("etimedout") || err.includes("stream error")) {
        return "transient_infra";
    }
    if (err.includes("parse") || err.includes("sentinel") || err.includes("json") || err.includes("invalid_json")) {
        return "output_format";
    }
    if (err.includes("verification")) {
        return "verification_failed";
    }
    if (!driveSuccess || err.includes("crash") || err.includes("exit") || err.includes("spawn")) {
        return "tool_crash";
    }
    return "prompt_gap";
}
/**
 * Heal a batch of failed tasks. Uses LLM if available, otherwise deterministic.
 */
export async function healBatch(failed, state, manifest, llmClient) {
    if (llmClient && !llmClient.exhausted) {
        try {
            const prompt = buildHealerPrompt(failed, state, manifest);
            const raw = await llmClient.complete(prompt.system, prompt.user);
            const parsed = parseHealDecision(raw);
            if (parsed)
                return parsed;
        }
        catch {
            // LLM failed -- fall through to deterministic
        }
    }
    return deterministicHeal(failed);
}
function deterministicHeal(failed) {
    // Group by failure signature to find the dominant failure class
    const sigCounts = new Map();
    for (const f of failed) {
        sigCounts.set(f.failure_signature, (sigCounts.get(f.failure_signature) ?? 0) + 1);
    }
    // Find dominant failure class from the signatures
    let dominantClass = "prompt_gap";
    for (const f of failed) {
        const cls = diagnoseTaskFailure(f.last_error, true);
        dominantClass = cls;
        break; // use first failure's class as representative
    }
    // Check for repeated signatures (non-convergence)
    const maxAttempts = Math.max(...failed.map((f) => f.attempts));
    if (maxAttempts >= 2) {
        return {
            decision: "ESCALATE",
            failure_class: dominantClass,
            root_cause: `Tasks failed ${maxAttempts} times with no improvement`,
            patches: [],
            escalations: failed.map((f) => ({ task_id: f.task_id, reason: f.last_error })),
        };
    }
    switch (dominantClass) {
        case "timeout":
            return {
                decision: "RETRY",
                failure_class: "timeout",
                root_cause: "Tasks hit timeout limit",
                patches: failed.map((f) => ({
                    target: "timing",
                    operation: "replace",
                    content: "double",
                    task_id: f.task_id,
                })),
                retry_tasks: failed.map((f) => f.task_id),
            };
        case "transient_infra":
            return {
                decision: "RETRY",
                failure_class: "transient_infra",
                root_cause: "Transient infrastructure error (network, rate limit)",
                patches: [],
                retry_tasks: failed.map((f) => f.task_id),
            };
        case "output_format":
            return {
                decision: "RETRY",
                failure_class: "output_format",
                root_cause: "Tool output could not be parsed",
                patches: [{
                        target: "shared_context",
                        operation: "append",
                        content: "IMPORTANT: Emit your final answer as valid JSON. Do not use markdown code fences around the JSON.",
                    }],
                retry_tasks: failed.map((f) => f.task_id),
            };
        case "tool_crash":
            // Retry once for transient crashes, then escalate
            return {
                decision: "RETRY",
                failure_class: "tool_crash",
                root_cause: "Tool process crashed or exited unexpectedly",
                patches: [],
                retry_tasks: failed.map((f) => f.task_id),
            };
        case "verification_failed":
            return {
                decision: "ESCALATE",
                failure_class: "verification_failed",
                root_cause: "Task output failed verification checks",
                patches: [],
                escalations: failed.map((f) => ({ task_id: f.task_id, reason: f.last_error })),
            };
        default:
            return {
                decision: "RETRY",
                failure_class: "prompt_gap",
                root_cause: "Task prompt may need more specificity",
                patches: [{
                        target: "shared_context",
                        operation: "append",
                        content: "Be explicit and thorough in your response. If unsure about any step, explain your reasoning.",
                    }],
                retry_tasks: failed.map((f) => f.task_id),
            };
    }
}
// ---- LLM-based healing ----
function buildHealerPrompt(failed, state, manifest) {
    return {
        system: `You are an orchestrator healer. Tasks were dispatched to LLM CLI tools (claude, gemini, opencode, etc.) and some failed. Diagnose the root cause and suggest patches.

Available failure classes: ${ORCH_FAILURE_CLASSES.join(", ")}

Available patch targets:
- shared_context: text appended to ALL task inputs (use for global guidance)
- task_input: replacement input for a specific task (include task_id)
- timing: adjust task timeout (include task_id)

Respond with ONLY a JSON object:
{
  "decision": "RETRY | ESCALATE | NOT_FIXABLE",
  "failure_class": "<class>",
  "root_cause": "<one sentence>",
  "patches": [{"target": "<target>", "operation": "append|replace", "content": "<text>", "task_id": "<optional>"}],
  "learned_rule": "<optional insight>",
  "escalations": [{"task_id": "<id>", "reason": "<why>"}],
  "retry_tasks": ["<task_ids to reset to PENDING>"]
}

Use RETRY when you can suggest a concrete prompt or timing change.
Use ESCALATE when the failure is structural (tool can't do this task).
Use NOT_FIXABLE when retrying would be wasteful.`,
        user: `Failed tasks (${failed.length}):

${failed.map((f) => `Task: ${f.task_id} (tool: ${f.tool_id}, attempts: ${f.attempts})
  Signature: ${f.failure_signature}
  Error: ${f.last_error}
  ${f.diagnostic_lines ? `Diagnostics:\n${f.diagnostic_lines}` : "(no diagnostics)"}`).join("\n\n")}

Healing history: ${state.healing_rounds.length} rounds so far.
${state.shared_context_patches?.length ? `Active shared_context patches: ${state.shared_context_patches.length}` : "No shared_context patches yet."}`,
    };
}
const VALID_DECISIONS = new Set(["RETRY", "ESCALATE", "NOT_FIXABLE"]);
const VALID_FAILURE_CLASSES = new Set(ORCH_FAILURE_CLASSES);
const VALID_PATCH_TARGETS = new Set(["shared_context", "task_input", "timing"]);
function parseHealDecision(raw) {
    const obj = safeParse(raw);
    if (!obj)
        return null;
    const decision = String(obj.decision ?? "");
    if (!VALID_DECISIONS.has(decision))
        return null;
    const failureClass = String(obj.failure_class ?? "");
    if (!VALID_FAILURE_CLASSES.has(failureClass))
        return null;
    const patches = [];
    if (Array.isArray(obj.patches)) {
        for (const p of obj.patches) {
            const target = String(p.target ?? "");
            if (VALID_PATCH_TARGETS.has(target) && p.content) {
                patches.push({
                    target: target,
                    operation: (String(p.operation ?? "append") === "replace" ? "replace" : "append"),
                    content: String(p.content),
                    task_id: p.task_id ? String(p.task_id) : undefined,
                });
            }
        }
    }
    const escalations = [];
    if (Array.isArray(obj.escalations)) {
        for (const e of obj.escalations) {
            if (e.task_id) {
                escalations.push({
                    task_id: String(e.task_id),
                    reason: String(e.reason ?? "escalated by healer"),
                });
            }
        }
    }
    const retryTasks = [];
    if (Array.isArray(obj.retry_tasks)) {
        for (const id of obj.retry_tasks) {
            retryTasks.push(String(id));
        }
    }
    return {
        decision: decision,
        failure_class: failureClass,
        root_cause: String(obj.root_cause ?? ""),
        patches,
        learned_rule: obj.learned_rule ? String(obj.learned_rule) : undefined,
        escalations: escalations.length > 0 ? escalations : undefined,
        retry_tasks: retryTasks.length > 0 ? retryTasks : undefined,
    };
}
//# sourceMappingURL=healer.js.map