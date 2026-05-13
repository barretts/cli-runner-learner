/**
 * Interactive adapter: for TUI tools driven via profile state machine.
 * Success = drive completed + (state_diff shows changes OR output non-empty).
 */
import type { DriveResult, ToolProfile } from "../../types.js";
import type { TaskDef, TaskResult } from "../types.js";
import type { OutputAdapter } from "../adapter.js";
export declare class InteractiveAdapter implements OutputAdapter {
    id: string;
    extractResult(driveResult: DriveResult, task: TaskDef, _profile: ToolProfile): Promise<TaskResult>;
}
