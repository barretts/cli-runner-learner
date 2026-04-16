/**
 * Generic verification pipeline with composable checks.
 */

import { execFile } from "node:child_process";
import type { DriveResult } from "../types.js";
import type { TaskDef, VerifyProfile, VerifyStep } from "./types.js";
import { globMatch } from "../term-utils.js";

export interface VerifyResult {
  passed: boolean;
  step_name: string;
  detail: string;
  duration_ms: number;
}

export async function runVerification(
  driveResult: DriveResult,
  task: TaskDef,
  profile: VerifyProfile,
): Promise<{ passed: boolean; results: VerifyResult[] }> {
  const results: VerifyResult[] = [];

  for (const step of profile.steps) {
    const result = await runStep(step, driveResult, task);
    results.push(result);
    if (!result.passed) {
      return { passed: false, results };
    }
  }

  return { passed: true, results };
}

async function runStep(
  step: VerifyStep,
  driveResult: DriveResult,
  task: TaskDef,
): Promise<VerifyResult> {
  const start = Date.now();

  switch (step.check) {
    case "exit_code":
      return {
        passed: driveResult.success,
        step_name: step.name,
        detail: driveResult.success
          ? "Tool completed successfully"
          : `Final state: ${driveResult.final_state}`,
        duration_ms: Date.now() - start,
      };

    case "output_contains": {
      const pattern = step.pattern ?? "";
      const found = globMatch(`*${pattern}*`, driveResult.output, true);
      return {
        passed: found,
        step_name: step.name,
        detail: found
          ? `Output contains "${pattern}"`
          : `Output does not contain "${pattern}"`,
        duration_ms: Date.now() - start,
      };
    }

    case "file_exists": {
      if (!driveResult.state_diff) {
        return {
          passed: false,
          step_name: step.name,
          detail: "No state diff available (work_dir not set?)",
          duration_ms: Date.now() - start,
        };
      }
      const expectedFiles = step.files ?? [];
      const allFiles = [
        ...driveResult.state_diff.new_files,
        ...driveResult.state_diff.modified_files,
      ];
      const missing = expectedFiles.filter((f) => !allFiles.includes(f));
      return {
        passed: missing.length === 0,
        step_name: step.name,
        detail: missing.length === 0
          ? `All expected files present: ${expectedFiles.join(", ")}`
          : `Missing files: ${missing.join(", ")}`,
        duration_ms: Date.now() - start,
      };
    }

    case "command": {
      if (!step.command) {
        return {
          passed: false,
          step_name: step.name,
          detail: "No command specified",
          duration_ms: Date.now() - start,
        };
      }

      try {
        const result = await runCommand(
          step.command,
          task.work_dir,
          (step.timeout_sec ?? 30) * 1000,
        );
        return {
          passed: result.exitCode === 0,
          step_name: step.name,
          detail: result.exitCode === 0
            ? `Command succeeded: ${step.command}`
            : `Command failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
          duration_ms: Date.now() - start,
        };
      } catch (e) {
        return {
          passed: false,
          step_name: step.name,
          detail: `Command error: ${(e as Error).message}`,
          duration_ms: Date.now() - start,
        };
      }
    }

    default:
      return {
        passed: false,
        step_name: step.name,
        detail: `Unknown check type: ${step.check}`,
        duration_ms: Date.now() - start,
      };
  }
}

function runCommand(
  command: string,
  cwd?: string,
  timeout_ms = 30_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "sh",
      ["-c", command],
      { cwd: cwd ?? process.cwd(), timeout: timeout_ms, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !("code" in error)) {
          reject(error);
          return;
        }
        resolve({
          exitCode: (error as NodeJS.ErrnoException & { code?: number })?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}
