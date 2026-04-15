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
  await writeAtomicJson(stateFilePath(state.tool_id), state);
}

export async function loadLearnState(toolId: string): Promise<LearnSessionState | null> {
  try {
    const raw = await readFile(stateFilePath(toolId), "utf-8");
    return JSON.parse(raw) as LearnSessionState;
  } catch {
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
