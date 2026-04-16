import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StateSnapshot, StateDiff } from "../types.js";

const exec = promisify(execFile);

async function git(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: workDir, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function isGitRepo(workDir: string): Promise<boolean> {
  try {
    await git(workDir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the current state of a working directory.
 * Works with both git repos and plain directories (limited info for non-git).
 */
export async function captureState(workDir: string): Promise<StateSnapshot> {
  const timestamp = new Date().toISOString();

  if (!(await isGitRepo(workDir))) {
    return {
      commit_hash: null,
      timestamp,
      tracked_files: 0,
      untracked_files: [],
      modified_files: [],
      is_clean: true,
    };
  }

  let commitHash: string | null = null;
  try {
    commitHash = await git(workDir, ["rev-parse", "HEAD"]);
  } catch {
    // No commits yet
  }

  const statusOutput = await git(workDir, ["status", "--porcelain"]);
  const statusLines = statusOutput ? statusOutput.split("\n") : [];

  const untracked: string[] = [];
  const modified: string[] = [];

  for (const line of statusLines) {
    const code = line.substring(0, 2);
    const file = line.substring(3);
    if (code === "??") {
      untracked.push(file);
    } else {
      modified.push(file);
    }
  }

  let trackedCount = 0;
  try {
    const lsOutput = await git(workDir, ["ls-files"]);
    trackedCount = lsOutput ? lsOutput.split("\n").length : 0;
  } catch {
    // empty repo
  }

  return {
    commit_hash: commitHash,
    timestamp,
    tracked_files: trackedCount,
    untracked_files: untracked,
    modified_files: modified,
    is_clean: statusLines.length === 0,
  };
}

/**
 * Compare before/after snapshots and produce a structured diff.
 */
export async function compareStates(
  workDir: string,
  before: StateSnapshot,
  after: StateSnapshot,
): Promise<StateDiff> {
  let rawDiff = "";
  const newFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  if (await isGitRepo(workDir)) {
    try {
      rawDiff = await git(workDir, ["diff"]);
    } catch {
      // no diff available
    }

    const statusOutput = await git(workDir, ["status", "--porcelain"]);
    for (const line of statusOutput ? statusOutput.split("\n") : []) {
      const code = line.substring(0, 2);
      const file = line.substring(3);
      if (code === "??" || code[0] === "A" || code[1] === "A") {
        newFiles.push(file);
      } else if (code[0] === "D" || code[1] === "D") {
        deletedFiles.push(file);
      } else if (code.trim()) {
        modifiedFiles.push(file);
      }
    }
  }

  const summaryParts: string[] = [];
  if (newFiles.length > 0) summaryParts.push(`${newFiles.length} new`);
  if (modifiedFiles.length > 0) summaryParts.push(`${modifiedFiles.length} modified`);
  if (deletedFiles.length > 0) summaryParts.push(`${deletedFiles.length} deleted`);
  const diffSummary = summaryParts.length > 0 ? summaryParts.join(", ") : "no changes";

  return {
    before,
    after,
    new_files: newFiles,
    modified_files: modifiedFiles,
    deleted_files: deletedFiles,
    diff_summary: diffSummary,
    raw_diff: rawDiff.substring(0, 10000),
  };
}

/**
 * Initialize git tracking in a directory if not already a repo.
 */
export async function initStateTracking(workDir: string): Promise<void> {
  if (await isGitRepo(workDir)) return;
  await git(workDir, ["init"]);
  await git(workDir, ["add", "-A"]);
  try {
    await git(workDir, ["commit", "-m", "initial state checkpoint"]);
  } catch {
    // empty directory -- nothing to commit
  }
}

/**
 * Commit current state with a label for rollback.
 */
export async function checkpointState(workDir: string, label: string): Promise<string> {
  await git(workDir, ["add", "-A"]);
  try {
    await git(workDir, ["commit", "-m", `checkpoint: ${label}`]);
  } catch {
    // nothing to commit
  }
  return git(workDir, ["rev-parse", "HEAD"]);
}

/**
 * Rollback to a previous checkpoint.
 */
export async function rollbackToCheckpoint(workDir: string, commitHash: string): Promise<void> {
  await git(workDir, ["reset", "--hard", commitHash]);
}
