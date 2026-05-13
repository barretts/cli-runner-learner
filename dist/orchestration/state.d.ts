/**
 * Orchestrator state management: init, load, checkpoint, reconcile.
 * Ported from 3pp-fix-database/src/orchestrator.ts state management.
 */
import type { Manifest, Policy, OrchestratorState } from "./types.js";
export declare function initState(manifest: Manifest, policy: Policy): OrchestratorState;
/**
 * Load existing state or create fresh. If manifest changed (tasks added/removed),
 * reconcile: new tasks get PENDING, removed tasks stay (already completed).
 */
export declare function loadOrInitState(statePath: string, manifest: Manifest, policy: Policy): Promise<OrchestratorState>;
export declare function checkpoint(statePath: string, state: OrchestratorState): Promise<void>;
