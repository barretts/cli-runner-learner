/**
 * Generic verification pipeline with composable checks.
 */
import type { DriveResult } from "../types.js";
import type { TaskDef, VerifyProfile } from "./types.js";
export interface VerifyResult {
    passed: boolean;
    step_name: string;
    detail: string;
    duration_ms: number;
}
export declare function runVerification(driveResult: DriveResult, task: TaskDef, profile: VerifyProfile): Promise<{
    passed: boolean;
    results: VerifyResult[];
}>;
