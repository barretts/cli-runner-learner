/**
 * Orchestrator state management: init, load, checkpoint, reconcile.
 * Ported from 3pp-fix-database/src/orchestrator.ts state management.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeAtomicJson } from "../engine/profile-manager.js";
import type {
  Manifest,
  Policy,
  OrchestratorState,
  PerTaskState,
  DEFAULT_POLICY,
} from "./types.js";

function manifestDigest(manifest: Manifest): string {
  const content = JSON.stringify(manifest.tasks.map((t) => t.id).sort());
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function newRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function initState(manifest: Manifest, policy: Policy): OrchestratorState {
  const tasks: Record<string, PerTaskState> = {};
  for (const task of manifest.tasks) {
    tasks[task.id] = {
      status: "PENDING",
      attempts: 0,
    };
  }

  return {
    version: "1.0",
    run_id: newRunId(),
    run_status: "RUNNING",
    manifest_digest: manifestDigest(manifest),
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    policy,
    tasks,
    healing_rounds: [],
  };
}

/**
 * Load existing state or create fresh. If manifest changed (tasks added/removed),
 * reconcile: new tasks get PENDING, removed tasks stay (already completed).
 */
export async function loadOrInitState(
  statePath: string,
  manifest: Manifest,
  policy: Policy,
): Promise<OrchestratorState> {
  let existing: OrchestratorState | null = null;
  try {
    const raw = await readFile(statePath, "utf-8");
    existing = JSON.parse(raw) as OrchestratorState;
  } catch {
    // no existing state
  }

  if (!existing) return initState(manifest, policy);

  // Reconcile: add new tasks, keep existing state for known tasks
  const digest = manifestDigest(manifest);
  if (existing.manifest_digest !== digest) {
    for (const task of manifest.tasks) {
      if (!(task.id in existing.tasks)) {
        existing.tasks[task.id] = { status: "PENDING", attempts: 0 };
      }
    }
    existing.manifest_digest = digest;
  }

  // Reset batch index on resume
  existing.current_batch_index = 0;
  existing.run_status = "RUNNING";
  existing.policy = policy;

  return existing;
}

export async function checkpoint(
  statePath: string,
  state: OrchestratorState,
): Promise<void> {
  state.updated_at = new Date().toISOString();
  await writeAtomicJson(statePath, state);
}
