/**
 * Orchestrator: dispatches tasks to LLM CLI tools using learned profiles.
 * Ported batch loop and healing from 3pp-fix-database, drives tools via
 * clr's existing drive() function.
 */
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadProfile } from "../engine/profile-manager.js";
import { drive } from "../runner/driver.js";
import { extractDiagnosticLines } from "../term-utils.js";
import { stableLearnFailureSignature } from "../engine/healer.js";
import { DEFAULT_POLICY, isParserFailure } from "./types.js";
import { selectAdapter } from "./adapter.js";
import { runPool, nextFibonacciBatchSize, prevFibonacciBatchSize, FIBONACCI_BATCH_SIZES } from "./pool.js";
import { checkpoint } from "./state.js";
import { runVerification } from "./verify.js";
import { topoSort } from "./manifest.js";
import { healBatch } from "./healer.js";
export class Orchestrator {
    manifest;
    state;
    statePath;
    policy;
    profiles = new Map();
    adapters = new Map();
    llmClient;
    transcriptDir;
    totalHealRounds = 0;
    constructor(config) {
        this.manifest = config.manifest;
        this.state = config.state;
        this.statePath = config.statePath;
        this.policy = { ...DEFAULT_POLICY, ...config.manifest.policy, ...config.state.policy };
        this.llmClient = config.llmClient;
        this.transcriptDir = config.transcriptDir;
        this.totalHealRounds = config.state.healing_rounds.length;
    }
    async run() {
        await mkdir(this.transcriptDir, { recursive: true });
        // Load all referenced profiles
        const toolIds = new Set(this.manifest.tasks.map((t) => t.tool_id));
        for (const toolId of toolIds) {
            const profile = await loadProfile(toolId);
            if (!profile) {
                throw new Error(`No profile found for tool "${toolId}". Run 'clr learn --tool ${toolId} --command <path>' first.`);
            }
            this.profiles.set(toolId, profile);
        }
        // Select adapters per tool
        for (const task of this.manifest.tasks) {
            if (!this.adapters.has(task.id)) {
                const profile = this.profiles.get(task.tool_id);
                this.adapters.set(task.id, selectAdapter(profile, task));
            }
        }
        this.state.run_status = "RUNNING";
        await this.save();
        // Get tasks in dependency order, filter to actionable
        const ordered = topoSort(this.manifest.tasks);
        const pendingTasks = ordered.filter((t) => {
            const ts = this.state.tasks[t.id];
            return ts && (ts.status === "PENDING" || ts.status === "FAILED");
        });
        if (pendingTasks.length === 0) {
            console.log("[orch] No pending tasks. Run complete.");
            this.state.run_status = "COMPLETED";
            await this.save();
            return;
        }
        console.log(`[orch] ${pendingTasks.length} tasks to process`);
        let batchSize = this.state.current_batch_size ?? FIBONACCI_BATCH_SIZES[0];
        let batchIndex = this.state.current_batch_index ?? 0;
        if (batchIndex >= pendingTasks.length) {
            batchIndex = 0;
            batchSize = FIBONACCI_BATCH_SIZES[0];
        }
        while (batchIndex < pendingTasks.length) {
            // Filter batch to tasks whose dependencies are satisfied AND are still
            // pending. Without the status check, tasks that moved to DONE in earlier
            // batches would still be sliced into subsequent batches, causing later
            // tasks to be skipped because `batchIndex += batch.length` advances past
            // them.
            const ready = pendingTasks.filter((t) => {
                const ts = this.state.tasks[t.id];
                if (!ts)
                    return false;
                if (ts.status !== "PENDING" && ts.status !== "FAILED")
                    return false;
                return this.depsReady(t);
            });
            const batch = ready.slice(0, batchSize);
            if (batch.length === 0) {
                // All remaining tasks are blocked
                console.log("[orch] All remaining tasks are blocked by dependencies.");
                break;
            }
            const batchNum = Math.floor(batchIndex / Math.max(batchSize, 1)) + 1;
            console.log(`\n[orch] === Batch ${batchNum} (size=${batch.length}, concurrency=${this.policy.concurrency}) ===`);
            await runPool(batch, this.policy.concurrency, (task) => this.executeTask(task));
            // Evaluate batch results
            const failedInBatch = batch.filter((t) => {
                const ts = this.state.tasks[t.id];
                return ts && (ts.status === "FAILED" || ts.status === "BLOCKED");
            });
            const failureRate = failedInBatch.length / batch.length;
            if (failedInBatch.length === 0) {
                console.log(`[orch] Batch complete: ${batch.length}/${batch.length} succeeded`);
                if (this.policy.batch_strategy === "fibonacci") {
                    batchSize = nextFibonacciBatchSize(batchSize);
                }
            }
            else if (this.policy.heal_schedule !== "off") {
                console.log(`[orch] Batch: ${failedInBatch.length}/${batch.length} failed (rate=${(failureRate * 100).toFixed(0)}%)`);
                if (failureRate > this.policy.failure_threshold) {
                    if (this.policy.batch_strategy === "fibonacci") {
                        batchSize = prevFibonacciBatchSize(batchSize);
                    }
                }
                if (this.totalHealRounds < this.policy.max_total_heal_rounds) {
                    const healed = await this.runHeal(failedInBatch);
                    if (!healed) {
                        console.log("[orch] Healing did not converge. Continuing with remaining tasks.");
                    }
                }
                else {
                    console.log("[orch] Max heal rounds reached. Escalating remaining failures.");
                    for (const t of failedInBatch) {
                        const ts = this.state.tasks[t.id];
                        if (ts && ts.status === "FAILED")
                            ts.status = "ESCALATED";
                    }
                }
            }
            else {
                console.log(`[orch] Batch: ${failedInBatch.length}/${batch.length} failed (healing disabled)`);
            }
            batchIndex += batch.length;
            this.state.current_batch_index = batchIndex;
            this.state.current_batch_size = batchSize;
            // Re-filter pending list for next iteration
            const remaining = pendingTasks.filter((t) => {
                const ts = this.state.tasks[t.id];
                return ts && (ts.status === "PENDING" || ts.status === "FAILED");
            });
            if (remaining.length === 0)
                break;
            await this.save();
        }
        // Final status
        const doneCount = Object.values(this.state.tasks).filter((t) => t.status === "DONE").length;
        const escalated = Object.values(this.state.tasks).filter((t) => t.status === "ESCALATED").length;
        const failed = Object.values(this.state.tasks).filter((t) => t.status === "FAILED" || t.status === "BLOCKED").length;
        const allDone = failed === 0;
        this.state.run_status = allDone ? "COMPLETED" : "ABORTED";
        if (!allDone) {
            this.state.abort_reason = `${failed} tasks remain failed/blocked after all batches`;
        }
        console.log(`\n[orch] Run finished: ${doneCount} done, ${escalated} escalated, ${failed} failed`);
        await this.save();
    }
    depsReady(task) {
        for (const dep of task.depends_on) {
            const ts = this.state.tasks[dep];
            if (!ts || ts.status !== "DONE")
                return false;
        }
        return true;
    }
    async executeTask(taskDef) {
        const taskState = this.state.tasks[taskDef.id];
        if (!taskState)
            return;
        if (taskState.status === "DONE" || taskState.status === "ESCALATED")
            return;
        if (taskState.attempts >= this.policy.max_worker_attempts_per_task) {
            console.log(`[orch] ${taskDef.id}: max attempts (${taskState.attempts}), escalating`);
            taskState.status = "ESCALATED";
            await this.save();
            return;
        }
        if (!this.depsReady(taskDef)) {
            taskState.status = "BLOCKED";
            return;
        }
        const profile = this.profiles.get(taskDef.tool_id);
        const adapter = this.adapters.get(taskDef.id);
        taskState.status = "RUNNING";
        taskState.attempts++;
        const attemptStart = Date.now();
        console.log(`[orch] ${taskDef.id}: attempt ${taskState.attempts} with ${taskDef.tool_id} (${adapter.id} adapter)`);
        // Build input
        let input = taskDef.input;
        if (this.manifest.shared_context) {
            input = this.manifest.shared_context + "\n\n" + input;
        }
        if (this.state.shared_context_patches?.length) {
            input = this.state.shared_context_patches.join("\n") + "\n\n" + input;
        }
        if (this.state.prompt_patches?.[taskDef.id]) {
            input = this.state.prompt_patches[taskDef.id];
        }
        if (adapter.prepareInput) {
            input = adapter.prepareInput(input, taskDef);
        }
        // Drive the tool
        let driveResult;
        try {
            driveResult = await drive(profile, {
                input,
                max_session_ms: taskDef.timeout_sec * 1000,
                settle_timeout_ms: profile.timing.idle_threshold_sec * 1000,
                workDir: taskDef.work_dir ? resolve(taskDef.work_dir) : undefined,
                llmClient: this.llmClient,
            });
        }
        catch (e) {
            const err = e.message;
            console.log(`[orch] ${taskDef.id}: drive() threw: ${err.slice(0, 200)}`);
            taskState.status = "FAILED";
            taskState.last_error = err;
            taskState.failure_signature = stableLearnFailureSignature("tool_crash", err);
            this.addSignature(taskState, taskState.failure_signature);
            this.addHistory(taskState, taskDef.id, "FAILED", attemptStart, err);
            return;
        }
        // Extract result via adapter
        const result = await adapter.extractResult(driveResult, taskDef, profile);
        if (isParserFailure(result)) {
            console.log(`[orch] ${taskDef.id}: parse failure (${result.kind}): ${result.error.slice(0, 200)}`);
            taskState.status = "FAILED";
            taskState.last_error = result.error;
            taskState.last_output_tail = driveResult.output.slice(-500);
            taskState.failure_signature = stableLearnFailureSignature("output_format", result.error);
            this.addSignature(taskState, taskState.failure_signature);
            this.addHistory(taskState, taskDef.id, "FAILED", attemptStart, result.error);
            return;
        }
        // Verification
        if (taskDef.verify && this.manifest.verify_profiles?.[taskDef.verify]) {
            const verification = await runVerification(driveResult, taskDef, this.manifest.verify_profiles[taskDef.verify]);
            if (!verification.passed) {
                const failedStep = verification.results.find((r) => !r.passed);
                const detail = failedStep?.detail ?? "Verification failed";
                console.log(`[orch] ${taskDef.id}: verification failed: ${detail}`);
                taskState.status = "FAILED";
                taskState.last_error = detail;
                taskState.last_output_tail = driveResult.output.slice(-500);
                taskState.failure_signature = stableLearnFailureSignature("verification_failed", detail);
                this.addSignature(taskState, taskState.failure_signature);
                this.addHistory(taskState, taskDef.id, "FAILED", attemptStart, detail);
                return;
            }
        }
        // Success or task-reported failure
        if (result.status === "DONE") {
            console.log(`[orch] ${taskDef.id}: DONE${result.summary ? ` -- ${result.summary.slice(0, 100)}` : ""}`);
            taskState.status = "DONE";
            this.addHistory(taskState, taskDef.id, "DONE", attemptStart, result.summary);
        }
        else {
            console.log(`[orch] ${taskDef.id}: ${result.status}${result.summary ? ` -- ${result.summary.slice(0, 100)}` : ""}`);
            taskState.status = result.status === "BLOCKED" ? "BLOCKED" : "FAILED";
            taskState.last_error = result.summary;
            taskState.last_output_tail = driveResult.output.slice(-500);
            if (result.failure_class) {
                taskState.failure_signature = stableLearnFailureSignature(result.failure_class, result.summary ?? "");
                this.addSignature(taskState, taskState.failure_signature);
            }
            this.addHistory(taskState, taskDef.id, result.status, attemptStart, result.summary);
        }
    }
    async runHeal(failedTasks) {
        const summaries = failedTasks.map((t) => {
            const ts = this.state.tasks[t.id];
            const diagnosticText = ts?.last_output_tail
                ? extractDiagnosticLines(ts.last_output_tail)
                : undefined;
            return {
                task_id: t.id,
                tool_id: t.tool_id,
                failure_signature: ts?.failure_signature ?? "unknown",
                last_error: ts?.last_error ?? "unknown",
                diagnostic_lines: diagnosticText,
                attempts: ts?.attempts ?? 0,
            };
        });
        console.log(`\n[heal] Diagnosing ${failedTasks.length} failed tasks`);
        for (const s of summaries) {
            console.log(`  [${s.task_id}] sig=${s.failure_signature}, err=${s.last_error?.slice(0, 80)}`);
        }
        const decision = await healBatch(summaries, this.state, this.manifest, this.llmClient);
        this.totalHealRounds++;
        this.state.healing_rounds.push({
            round: this.totalHealRounds,
            scope: "batch",
            window_size: failedTasks.length,
            failed_tasks: failedTasks.map((t) => t.id),
            decision: decision.decision,
            patches_applied: decision.patches.length,
            timestamp: new Date().toISOString(),
        });
        console.log(`[heal] Decision: ${decision.decision} (${decision.failure_class})`);
        console.log(`[heal] Root cause: ${decision.root_cause}`);
        if (decision.decision === "RETRY") {
            // Apply patches
            for (const patch of decision.patches) {
                switch (patch.target) {
                    case "shared_context":
                        if (!this.state.shared_context_patches)
                            this.state.shared_context_patches = [];
                        this.state.shared_context_patches.push(patch.content);
                        console.log(`[heal] Patched shared context (+${patch.content.length} chars)`);
                        break;
                    case "task_input":
                        if (patch.task_id) {
                            if (!this.state.prompt_patches)
                                this.state.prompt_patches = {};
                            this.state.prompt_patches[patch.task_id] = patch.content;
                            console.log(`[heal] Patched task ${patch.task_id} input`);
                        }
                        break;
                    case "timing":
                        // Timing patches modify the task timeout
                        if (patch.task_id) {
                            const task = this.manifest.tasks.find((t) => t.id === patch.task_id);
                            if (task) {
                                const original = task.timeout_sec;
                                task.timeout_sec = Math.min(task.timeout_sec * 2, 600);
                                console.log(`[heal] ${patch.task_id} timeout: ${original}s -> ${task.timeout_sec}s`);
                            }
                        }
                        break;
                }
            }
            // Reset failed tasks for retry
            const retryIds = decision.retry_tasks ?? failedTasks.map((t) => t.id);
            for (const id of retryIds) {
                const ts = this.state.tasks[id];
                if (ts && ts.status === "FAILED") {
                    ts.status = "PENDING";
                }
            }
            if (decision.learned_rule) {
                console.log(`[heal] Learned rule: ${decision.learned_rule}`);
            }
            await this.save();
            return true;
        }
        // ESCALATE or NOT_FIXABLE
        if (decision.escalations) {
            for (const e of decision.escalations) {
                const ts = this.state.tasks[e.task_id];
                if (ts) {
                    ts.status = "ESCALATED";
                    ts.last_error = e.reason;
                }
            }
        }
        await this.save();
        return false;
    }
    addSignature(ts, sig) {
        if (!ts.failure_signatures_seen)
            ts.failure_signatures_seen = [];
        if (!ts.failure_signatures_seen.includes(sig)) {
            ts.failure_signatures_seen.push(sig);
        }
    }
    addHistory(ts, taskId, status, startTime, summary) {
        if (!ts.history)
            ts.history = [];
        ts.history.push({
            attempt: ts.attempts,
            status,
            timestamp: new Date().toISOString(),
            failure_signature: ts.failure_signature,
            summary: summary?.slice(0, 500),
            duration_ms: Date.now() - startTime,
        });
    }
    async save() {
        await checkpoint(this.statePath, this.state);
    }
}
//# sourceMappingURL=orchestrator.js.map