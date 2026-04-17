import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LearnSessionState, ProbeStrategy, ToolState } from "../types.js";
import { writeAtomicJson, PROFILES_DIR } from "./profile-manager.js";

function stateFilePath(toolId: string): string {
  return join(PROFILES_DIR, `${toolId}.learn-state.json`);
}

export function initLearnState(
  toolId: string,
  command: string,
  opts: {
    maxRounds: number;
    confidenceThreshold: number;
    settleTimeoutMs: number;
    maxProbeSessionMs: number;
    healMode: string;
    maxHealRounds: number;
  },
): LearnSessionState {
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

export async function checkpointLearnState(state: LearnSessionState): Promise<void> {
  state.updated_at = new Date().toISOString();
  const path = stateFilePath(state.tool_id);
  console.log(`[learn-state] Checkpoint: ${state.session_id} round=${state.current_round} status=${state.status} conf=[${state.confidence_history.map(c => (c*100).toFixed(1)+'%').join(',')}]`);
  console.log(`[learn-state]   Path: ${path}`);
  await writeAtomicJson(path, state);
}

export async function loadLearnState(toolId: string): Promise<LearnSessionState | null> {
  const path = stateFilePath(toolId);
  console.log(`[learn-state] Loading: ${path}`);
  try {
    const raw = await readFile(path, "utf-8");
    const state = JSON.parse(raw) as LearnSessionState;
    console.log(`[learn-state] Loaded: session=${state.session_id}, status=${state.status}, round=${state.current_round}, probes=${state.completed_probes.length}`);
    return state;
  } catch {
    console.log(`[learn-state] No existing state for ${toolId}`);
    return null;
  }
}

export async function clearLearnState(toolId: string): Promise<void> {
  try {
    await unlink(stateFilePath(toolId));
  } catch {
    // file doesn't exist, nothing to clean
  }
}
