/**
 * Passthrough adapter: DriveResult IS the result.
 * Simplest adapter -- no structured parsing.
 */
import type { DriveResult, ToolProfile } from "../../types.js";
import type { TaskDef, TaskResult } from "../types.js";
import type { OutputAdapter } from "../adapter.js";
export declare class PassthroughAdapter implements OutputAdapter {
    id: string;
    extractResult(driveResult: DriveResult, task: TaskDef, _profile: ToolProfile): Promise<TaskResult>;
}
