/**
 * Interactive adapter: for TUI tools driven via profile state machine.
 * Success = drive completed + (state_diff shows changes OR output non-empty).
 */
export class InteractiveAdapter {
    id = "interactive";
    async extractResult(driveResult, task, _profile) {
        const hasChanges = driveResult.state_diff != null && (driveResult.state_diff.new_files.length > 0 ||
            driveResult.state_diff.modified_files.length > 0 ||
            driveResult.state_diff.deleted_files.length > 0);
        const hasOutput = driveResult.output.trim().length > 0;
        const succeeded = driveResult.success && (hasChanges || hasOutput);
        return {
            task_id: task.id,
            status: succeeded ? "DONE" : "FAILED",
            output: driveResult.output,
            evidence: {
                final_state: driveResult.final_state,
                duration_ms: driveResult.duration_ms,
                transcript_path: driveResult.transcript_path,
                state_diff: driveResult.state_diff,
            },
            failure_class: succeeded ? undefined : driveResult.success ? "wrong_output" : "tool_crash",
        };
    }
}
//# sourceMappingURL=interactive.js.map