/**
 * OutputAdapter interface and adapter selection.
 *
 * Profiles handle interaction (Layer 1 via drive()).
 * Adapters handle output parsing (Layer 2).
 */
import type { DriveResult, ToolProfile } from "../types.js";
import type { TaskDef, TaskResult, ParserFailure } from "./types.js";
export interface OutputAdapter {
    id: string;
    /**
     * Parse a DriveResult into a structured TaskResult.
     */
    extractResult(driveResult: DriveResult, task: TaskDef, profile: ToolProfile): Promise<TaskResult | ParserFailure>;
    /**
     * Optional: modify input before passing to drive().
     * Used by SentinelAdapter to inject sentinel output instructions.
     */
    prepareInput?(input: string, task: TaskDef): string;
}
/**
 * Select an adapter for a task based on profile interaction mode and overrides.
 *
 * Priority: task.adapter_override > profile.interaction_mode mapping > passthrough
 */
export declare function selectAdapter(profile: ToolProfile, task: TaskDef): OutputAdapter;
