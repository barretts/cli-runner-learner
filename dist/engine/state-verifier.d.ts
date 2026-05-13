import type { StateSnapshot, StateDiff } from "../types.js";
/**
 * Capture the current state of a working directory.
 * Works with both git repos and plain directories (limited info for non-git).
 */
export declare function captureState(workDir: string): Promise<StateSnapshot>;
/**
 * Compare before/after snapshots and produce a structured diff.
 */
export declare function compareStates(workDir: string, before: StateSnapshot, after: StateSnapshot): Promise<StateDiff>;
/**
 * Initialize git tracking in a directory if not already a repo.
 */
export declare function initStateTracking(workDir: string): Promise<void>;
/**
 * Commit current state with a label for rollback.
 */
export declare function checkpointState(workDir: string, label: string): Promise<string>;
/**
 * Rollback to a previous checkpoint.
 */
export declare function rollbackToCheckpoint(workDir: string, commitHash: string): Promise<void>;
