/**
 * Sentinel adapter: extracts structured JSON from tool output
 * wrapped in sentinel markers.
 *
 * Used for tools in --print / args mode that emit structured results.
 * Ported sentinel extraction from 3pp-fix-database/src/parser.ts.
 */
import type { DriveResult, ToolProfile } from "../../types.js";
import type { TaskDef, TaskResult, ParserFailure } from "../types.js";
import type { OutputAdapter } from "../adapter.js";
export declare class SentinelAdapter implements OutputAdapter {
    id: string;
    prepareInput(input: string, _task: TaskDef): string;
    extractResult(driveResult: DriveResult, task: TaskDef, _profile: ToolProfile): Promise<TaskResult | ParserFailure>;
}
