import type { ToolProfile, DriveOpts, DriveResult } from "../types.js";
/**
 * Profile-driven state machine that interacts with a CLI tool
 * using learned patterns from the tool profile.
 */
export declare function drive(profile: ToolProfile, opts: DriveOpts): Promise<DriveResult>;
