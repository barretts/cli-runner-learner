/**
 * OutputAdapter interface and adapter selection.
 *
 * Profiles handle interaction (Layer 1 via drive()).
 * Adapters handle output parsing (Layer 2).
 */

import type { DriveResult, ToolProfile } from "../types.js";
import type { TaskDef, TaskResult, ParserFailure } from "./types.js";
import { PassthroughAdapter } from "./adapters/passthrough.js";
import { SentinelAdapter } from "./adapters/sentinel.js";
import { InteractiveAdapter } from "./adapters/interactive.js";

export interface OutputAdapter {
  id: string;

  /**
   * Parse a DriveResult into a structured TaskResult.
   */
  extractResult(
    driveResult: DriveResult,
    task: TaskDef,
    profile: ToolProfile,
  ): Promise<TaskResult | ParserFailure>;

  /**
   * Optional: modify input before passing to drive().
   * Used by SentinelAdapter to inject sentinel output instructions.
   */
  prepareInput?(input: string, task: TaskDef): string;
}

const ADAPTERS: Record<string, () => OutputAdapter> = {
  passthrough: () => new PassthroughAdapter(),
  sentinel: () => new SentinelAdapter(),
  interactive: () => new InteractiveAdapter(),
};

/**
 * Select an adapter for a task based on profile interaction mode and overrides.
 *
 * Priority: task.adapter_override > profile.interaction_mode mapping > passthrough
 */
export function selectAdapter(profile: ToolProfile, task: TaskDef): OutputAdapter {
  if (task.adapter_override && task.adapter_override in ADAPTERS) {
    return ADAPTERS[task.adapter_override]();
  }

  if (profile.interaction_mode === "args") {
    return ADAPTERS.sentinel();
  }

  if (profile.interaction_mode === "interactive") {
    return ADAPTERS.interactive();
  }

  return ADAPTERS.passthrough();
}
