import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomicJson } from "./profile-manager.js";
import { getProfileDir } from "../paths.js";
function stateFilePath(toolId) {
    return join(getProfileDir(), `${toolId}.learn-state.json`);
}
export function initLearnState(toolId, command, opts) {
    return {
        schema_version: "1.0",
        session_id: `${toolId}-learn-${Date.now()}`,
        tool_id: toolId,
        tool_command: command,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "RUNNING",
        current_round: 0,
        max_rounds: opts.maxRounds,
        confidence_threshold: opts.confidenceThreshold,
        confidence_history: [],
        completed_probes: [],
        healing_rounds: [],
        failure_signatures_seen: [],
        config: {
            settle_timeout_ms: opts.settleTimeoutMs,
            max_probe_session_ms: opts.maxProbeSessionMs,
            heal_mode: opts.healMode,
            max_heal_rounds: opts.maxHealRounds,
        },
    };
}
export async function checkpointLearnState(state) {
    state.updated_at = new Date().toISOString();
    const path = stateFilePath(state.tool_id);
    console.log(`[learn-state] Checkpoint: ${state.session_id} round=${state.current_round} status=${state.status} conf=[${state.confidence_history.map(c => (c * 100).toFixed(1) + '%').join(',')}]`);
    console.log(`[learn-state]   Path: ${path}`);
    await writeAtomicJson(path, state);
}
export async function loadLearnState(toolId) {
    const path = stateFilePath(toolId);
    console.log(`[learn-state] Loading: ${path}`);
    try {
        const raw = await readFile(path, "utf-8");
        const state = JSON.parse(raw);
        console.log(`[learn-state] Loaded: session=${state.session_id}, status=${state.status}, round=${state.current_round}, probes=${state.completed_probes.length}`);
        return state;
    }
    catch {
        console.log(`[learn-state] No existing state for ${toolId}`);
        return null;
    }
}
export async function clearLearnState(toolId) {
    try {
        await unlink(stateFilePath(toolId));
    }
    catch {
        // file doesn't exist, nothing to clean
    }
}
//# sourceMappingURL=learn-state.js.map