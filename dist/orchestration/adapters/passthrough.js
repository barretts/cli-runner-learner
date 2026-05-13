/**
 * Passthrough adapter: DriveResult IS the result.
 * Simplest adapter -- no structured parsing.
 */
export class PassthroughAdapter {
    id = "passthrough";
    async extractResult(driveResult, task, _profile) {
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
//# sourceMappingURL=passthrough.js.map