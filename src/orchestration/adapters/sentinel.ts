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
import { repairJson } from "../../llm/json-repair.js";
import { stripTermEscapes } from "../../term-utils.js";

const SENTINEL_START = "<<<TASK_RESULT>>>";
const SENTINEL_END = "<<<END_TASK_RESULT>>>";

const SENTINEL_INSTRUCTIONS = `

When you are done, emit your result as JSON between these exact markers:
${SENTINEL_START}
{ "status": "DONE", "summary": "<brief description of what was done>" }
${SENTINEL_END}

If you cannot complete the task, use status "FAILED" with a summary explaining why.`;

export class SentinelAdapter implements OutputAdapter {
  id = "sentinel";

  prepareInput(input: string, _task: TaskDef): string {
    return input + SENTINEL_INSTRUCTIONS;
  }

  async extractResult(
    driveResult: DriveResult,
    task: TaskDef,
    _profile: ToolProfile,
  ): Promise<TaskResult | ParserFailure> {
    const clean = stripTermEscapes(driveResult.output);
    const block = extractSentinelBlock(clean, SENTINEL_START, SENTINEL_END);

    if (!block) {
      // No sentinel found -- fall back to passthrough behavior
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
        failure_class: driveResult.success ? undefined : "output_format",
      };
    }

    const repaired = repairJson(block);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(repaired) as Record<string, unknown>;
    } catch (e) {
      return {
        kind: "invalid_json",
        error: `JSON parse failed: ${(e as Error).message}`,
        raw: repaired,
      };
    }

    const status = String(parsed.status ?? "DONE");

    return {
      task_id: task.id,
      status: status === "FAILED" ? "FAILED" : status === "BLOCKED" ? "BLOCKED" : "DONE",
      output: driveResult.output,
      summary: parsed.summary ? String(parsed.summary) : undefined,
      evidence: {
        final_state: driveResult.final_state,
        duration_ms: driveResult.duration_ms,
        transcript_path: driveResult.transcript_path,
        state_diff: driveResult.state_diff,
      },
      failure_class: status === "FAILED" ? "prompt_gap" : undefined,
    };
  }
}

/**
 * Extract all blocks between start/end sentinels. Returns the LAST match
 * (last block wins, per agent-threader spec).
 */
function extractSentinelBlock(
  text: string,
  startSentinel: string,
  endSentinel: string,
): string | null {
  const blocks: string[] = [];
  let searchFrom = 0;

  while (true) {
    const startIdx = text.indexOf(startSentinel, searchFrom);
    if (startIdx === -1) break;

    const contentStart = startIdx + startSentinel.length;
    const endIdx = text.indexOf(endSentinel, contentStart);
    if (endIdx === -1) break;

    blocks.push(text.slice(contentStart, endIdx));
    searchFrom = endIdx + endSentinel.length;
  }

  return blocks.length > 0 ? blocks[blocks.length - 1] : null;
}
