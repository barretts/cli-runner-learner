/**
 * Passthrough adapter: DriveResult IS the result.
 * Simplest adapter -- no structured parsing.
 */

import type { DriveResult, ToolProfile } from "../../types.js";
import type { TaskDef, TaskResult, ParserFailure } from "../types.js";
import type { OutputAdapter } from "../adapter.js";

export class PassthroughAdapter implements OutputAdapter {
  id = "passthrough";

  async extractResult(
    driveResult: DriveResult,
    task: TaskDef,
    _profile: ToolProfile,
  ): Promise<TaskResult> {
    return {
      task_id: task.id,
      status: driveResult.success ? "DONE" : "FAILED",
      output: driveResult.output,
      evidence: {
        final_state: driveResult.final_state,
        duration_ms: driveResult.duration_ms,
        transcript_path: driveResult.transcript_path,
        state_diff: driveResult.state_diff,
      },
      failure_class: driveResult.success ? undefined : "tool_crash",
    };
  }
}
