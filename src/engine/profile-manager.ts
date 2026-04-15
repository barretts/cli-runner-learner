import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolProfile, LearnedPattern, StateIndicator, StateDefinition } from "../types.js";

const PROFILES_DIR = resolve(new URL("../../profiles", import.meta.url).pathname);

export async function loadProfile(toolId: string): Promise<ToolProfile | null> {
  const path = join(PROFILES_DIR, `${toolId}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as ToolProfile;
  } catch {
    return null;
  }
}

export async function saveProfile(profile: ToolProfile): Promise<string> {
  await mkdir(PROFILES_DIR, { recursive: true });
  const path = join(PROFILES_DIR, `${profile.tool_id}.json`);
  const tmpPath = `${path}.tmp`;

  profile.last_updated = new Date().toISOString();

  await writeFile(tmpPath, JSON.stringify(profile, null, 2), "utf-8");
  await rename(tmpPath, path);
  return path;
}

export function bootstrapProfile(toolId: string, command: string, interactionMode: "interactive" | "args" = "interactive"): ToolProfile {
  return {
    schema_version: "1.0",
    tool_id: toolId,
    tool_command: command,
    last_updated: new Date().toISOString(),
    confidence: 0,
    probe_count: 0,
    needs_review: true,
    interaction_mode: interactionMode,

    launch: {
      default_args: [],
      env: {},
      needs_pty: true,
      startup_timeout_sec: 30,
    },

    states: {
      startup: {
        description: "Tool is initializing",
        indicators: [],
        timeout_sec: 30,
      },
      ready: {
        description: "Tool is waiting for input",
        indicators: [],
      },
      working: {
        description: "Tool is actively processing",
        indicators: [],
      },
      prompting: {
        description: "Tool wants user input",
        indicators: [],
        sub_prompts: [],
      },
      thinking: {
        description: "Tool is processing/reasoning",
        indicators: [],
      },
      completed: {
        description: "Tool finished",
        indicators: [{ type: "process_exit" }],
      },
      error: {
        description: "Tool errored",
        indicators: [{ type: "exit_code_nonzero" }],
      },
    },

    transitions: [
      { from: "startup", to: "ready", on: "ready_indicator" },
      { from: "startup", to: "prompting", on: "prompt_indicator" },
      { from: "ready", to: "working", on: "input_sent" },
      { from: "working", to: "prompting", on: "prompt_indicator" },
      { from: "working", to: "thinking", on: "thinking_indicator" },
      { from: "thinking", to: "working", on: "output_resumed" },
      { from: "working", to: "completed", on: "completion_indicator" },
      { from: "working", to: "ready", on: "ready_indicator" },
      { from: "*", to: "error", on: "error_indicator" },
      { from: "*", to: "completed", on: "process_exit" },
    ],

    timing: {
      typical_startup_sec: 5,
      idle_threshold_sec: 8,
      max_session_sec: 300,
    },

    learned_patterns: [],
  };
}

/**
 * Merge newly learned patterns into an existing profile.
 * Updates state indicators, confidence scores, and probe count.
 */
export function mergeLearnedPatterns(
  profile: ToolProfile,
  newPatterns: LearnedPattern[],
  metadata?: { tool_version?: string; terminal_cols?: number; terminal_rows?: number },
): ToolProfile {
  const updated = structuredClone(profile);
  updated.probe_count++;

  if (metadata) {
    updated.metadata = { ...updated.metadata, ...metadata };
  }

  for (const pattern of newPatterns) {
    // Add to learned_patterns list
    const existing = updated.learned_patterns.find(
      (p) => p.pattern === pattern.pattern && p.classified_as === pattern.classified_as,
    );

    if (existing) {
      // Update existing pattern: average confidence, increment occurrences
      existing.occurrences += pattern.occurrences;
      existing.confidence = (existing.confidence + pattern.confidence) / 2;
      existing.timestamp = pattern.timestamp;
    } else {
      updated.learned_patterns.push(pattern);
    }

    // Promote high-confidence patterns to state indicators
    const effectiveConfidence = existing?.confidence ?? pattern.confidence;
    if (effectiveConfidence >= 0.5) {
      const stateName = pattern.classified_as;
      if (stateName in updated.states) {
        const stateDef = updated.states[stateName];
        const indicator: StateIndicator = {
          type: "output_glob",
          pattern: pattern.pattern,
        };

        // Don't add duplicate indicators
        const alreadyExists = stateDef.indicators.some(
          (ind) => ind.type === "output_glob" && ind.pattern === pattern.pattern,
        );

        if (!alreadyExists) {
          stateDef.indicators.push(indicator);
        }
      }
    }
  }

  // Recompute overall confidence
  updated.confidence = computeProfileConfidence(updated);

  // Clear needs_review if confidence is high enough
  if (updated.confidence >= 0.5) {
    updated.needs_review = false;
  }

  return updated;
}

/**
 * Compute overall profile confidence from state-level pattern data.
 */
function computeProfileConfidence(profile: ToolProfile): number {
  // States that need text-pattern indicators to be useful
  const patternStates = ["startup", "ready", "working"];
  // States identified by structural events (process exit, exit code)
  const structuralStates = ["completed", "error"];

  let totalScore = 0;
  let stateCount = 0;

  for (const stateName of patternStates) {
    const state = profile.states[stateName];
    if (!state) continue;
    stateCount++;

    const statePatterns = profile.learned_patterns.filter(
      (p) => p.classified_as === stateName,
    );

    if (statePatterns.length === 0) continue;

    const avgConf =
      statePatterns.reduce((sum, p) => sum + p.confidence, 0) / statePatterns.length;
    totalScore += avgConf;
  }

  // Structural states get credit if they have indicators defined
  for (const stateName of structuralStates) {
    const state = profile.states[stateName];
    if (!state) continue;
    stateCount++;
    // These states work via event detection, not text patterns
    if (state.indicators.length > 0) {
      totalScore += 0.8;
    }
  }

  return stateCount > 0 ? totalScore / stateCount : 0;
}
