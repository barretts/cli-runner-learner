import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolProfile, ToolDiscovery, LearnedPattern, StateIndicator, StateDefinition, SubPrompt } from "../types.js";

export const PROFILES_DIR = resolve(new URL("../../profiles", import.meta.url).pathname);

/**
 * Atomic JSON write: temp file + rename on same filesystem.
 * Prevents corrupt state on crash mid-write.
 */
export async function writeAtomicJson(filePath: string, data: unknown): Promise<void> {
  const dir = resolve(filePath, "..");
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

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
  const path = join(PROFILES_DIR, `${profile.tool_id}.json`);
  profile.last_updated = new Date().toISOString();
  await writeAtomicJson(path, profile);
  return path;
}

export function bootstrapProfile(
  toolId: string,
  command: string,
  interactionMode: "interactive" | "args" = "interactive",
  discovery?: ToolDiscovery,
): ToolProfile {
  // Infer interaction mode from discovery if available
  const mode = discovery?.interactive ? "interactive" : interactionMode;

  const profile: ToolProfile = {
    schema_version: "1.0",
    tool_id: toolId,
    tool_command: command,
    last_updated: new Date().toISOString(),
    confidence: 0,
    probe_count: 0,
    needs_review: true,
    interaction_mode: mode,

    launch: {
      default_args: [],
      env: {},
      needs_pty: true,
      startup_timeout_sec: discovery?.interactive ? 30 : 10,
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

  if (discovery) {
    profile.discovery = discovery;
    if (discovery.parsed_description) {
      profile.states.ready.description = `Ready: ${discovery.parsed_description}`;
    }
    if (!discovery.interactive) {
      profile.timing.idle_threshold_sec = 3;
      profile.timing.max_session_sec = 60;
    }
  }

  return profile;
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
  console.log(`[profile] Merging ${newPatterns.length} new patterns into profile (probe_count=${profile.probe_count}, existing=${profile.learned_patterns.length})`);
  const updated = structuredClone(profile);
  updated.probe_count++;

  if (metadata) {
    updated.metadata = { ...updated.metadata, ...metadata };
  }

  let mergedCount = 0;
  let addedCount = 0;
  let promotedCount = 0;

  for (const pattern of newPatterns) {
    // Add to learned_patterns list
    const existing = updated.learned_patterns.find(
      (p) => p.pattern === pattern.pattern && p.classified_as === pattern.classified_as,
    );

    if (existing) {
      // Update existing pattern: average confidence, increment occurrences
      const oldConf = existing.confidence;
      existing.occurrences += pattern.occurrences;
      existing.confidence = (existing.confidence + pattern.confidence) / 2;
      existing.timestamp = pattern.timestamp;
      mergedCount++;
      console.log(`[profile]   Merged: [${pattern.classified_as}] "${pattern.pattern}" conf ${(oldConf*100).toFixed(0)}% -> ${(existing.confidence*100).toFixed(0)}%, occ=${existing.occurrences}`);
    } else {
      updated.learned_patterns.push(pattern);
      addedCount++;
      console.log(`[profile]   Added: [${pattern.classified_as}] "${pattern.pattern}" conf=${(pattern.confidence*100).toFixed(0)}%, occ=${pattern.occurrences}`);
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
          promotedCount++;
          console.log(`[profile]   Promoted to indicator: [${stateName}] "${pattern.pattern}"`);
        }
      }
    }
  }

  console.log(`[profile] Merge summary: ${addedCount} added, ${mergedCount} merged, ${promotedCount} promoted to indicators`);
  console.log(`[profile] Total learned patterns: ${updated.learned_patterns.length}`);

  // Recompute overall confidence
  updated.confidence = computeProfileConfidence(updated);

  // Clear needs_review if confidence is high enough
  if (updated.confidence >= 0.5) {
    updated.needs_review = false;
  }

  return updated;
}

export interface DetectedSubPrompt {
  prompt_text: string;
  prompt_type: "yes_no" | "selection" | "text_input" | "confirmation" | "unknown";
  suggested_response: string;
  confidence: number;
}

/**
 * Register a detected sub-prompt into a profile's prompting state.
 * Creates an output_glob indicator from the prompt text and sets the auto-response.
 * Returns a new profile (does not mutate the input).
 */
export function registerSubPrompt(
  profile: ToolProfile,
  detected: DetectedSubPrompt,
): ToolProfile {
  const updated = structuredClone(profile);

  if (!updated.states.prompting) {
    updated.states.prompting = {
      description: "Tool wants user input",
      indicators: [],
      sub_prompts: [],
    };
  }

  if (!updated.states.prompting.sub_prompts) {
    updated.states.prompting.sub_prompts = [];
  }

  // Build a glob pattern from the prompt text (wildcard prefix/suffix for flexibility)
  const globPattern = `*${detected.prompt_text.trim().replace(/[[\]{}]/g, "\\$&")}*`;

  // Check for duplicates
  const existing = updated.states.prompting.sub_prompts.find(
    (sp) => sp.indicators.some((ind) => ind.pattern === globPattern),
  );
  if (existing) return updated;

  const id = `sub-prompt-${updated.states.prompting.sub_prompts.length}`;
  const subPrompt: SubPrompt = {
    id,
    indicators: [{
      type: "output_glob",
      pattern: globPattern,
      case_insensitive: true,
    }],
    auto_response: detected.suggested_response ? detected.suggested_response + "\r" : null,
    description: `${detected.prompt_type}: ${detected.prompt_text.substring(0, 80)}`,
  };

  updated.states.prompting.sub_prompts.push(subPrompt);
  return updated;
}

/**
 * Register structural indicators on the profile from classified segments.
 * Some states (like "ready" in TUI tools) are defined by structural events
 * (silence/settle) rather than text patterns. This function detects those
 * states from classification results and adds the appropriate indicators.
 */
export function registerStructuralIndicators(
  profile: ToolProfile,
  classifiedRuns: Array<{ segments: import("../types.js").ClassifiedSegment[] }>,
): ToolProfile {
  const updated = structuredClone(profile);

  for (const run of classifiedRuns) {
    for (const seg of run.segments) {
      if (seg.state === "ready" && seg.confidence >= 0.5) {
        const readyState = updated.states.ready;
        if (!readyState) continue;

        // Add silence_after_output_ms indicator if not already present
        const hasStructural = readyState.indicators.some(
          (ind) => ind.type === "silence_after_output_ms",
        );
        if (!hasStructural) {
          const silenceMs = seg.events.find(
            (e) => e.type === "meta" && e.event === "settled",
          )?.value;
          readyState.indicators.push({
            type: "silence_after_output_ms",
            value: silenceMs ?? 3000,
          });
        }
      }
    }
  }

  // Recompute confidence with structural indicators included
  updated.confidence = computeProfileConfidence(updated);
  return updated;
}

/**
 * Compute overall profile confidence from state-level pattern data.
 */
function computeProfileConfidence(profile: ToolProfile): number {
  // States that contribute to confidence via text patterns or structural indicators
  const patternStates = ["startup", "ready", "working", "thinking", "prompting"];
  // States identified purely by structural events (process exit, exit code)
  const structuralStates = ["completed", "error"];

  let totalScore = 0;
  let stateCount = 0;

  console.log(`[profile] Computing confidence breakdown:`);

  for (const stateName of patternStates) {
    const state = profile.states[stateName];
    if (!state) continue;
    stateCount++;

    // Check for text patterns
    const statePatterns = profile.learned_patterns.filter(
      (p) => p.classified_as === stateName,
    );

    if (statePatterns.length > 0) {
      const avgConf =
        statePatterns.reduce((sum, p) => sum + p.confidence, 0) / statePatterns.length;
      totalScore += avgConf;
      console.log(`[profile]   ${stateName}: ${statePatterns.length} patterns, avgConf=${(avgConf*100).toFixed(1)}%, indicators=${state.indicators.length}`);
    } else if (state.indicators.some((ind) => ind.type === "silence_after_output_ms")) {
      // Structural indicator: state is identified by silence/timing, not text.
      // Give partial credit -- the state is known but not text-anchored.
      totalScore += 0.6;
      console.log(`[profile]   ${stateName}: structural (silence) -> 0.60, indicators=${state.indicators.length}`);
    } else {
      console.log(`[profile]   ${stateName}: NO patterns, NO structural -> 0.00, indicators=${state.indicators.length}`);
    }
  }

  // Structural states get credit if they have indicators defined
  for (const stateName of structuralStates) {
    const state = profile.states[stateName];
    if (!state) continue;
    stateCount++;
    // These states work via event detection, not text patterns
    if (state.indicators.length > 0) {
      totalScore += 0.8;
      console.log(`[profile]   ${stateName}: structural event -> 0.80, indicators=${state.indicators.length}`);
    } else {
      console.log(`[profile]   ${stateName}: NO indicators -> 0.00`);
    }
  }

  const confidence = stateCount > 0 ? totalScore / stateCount : 0;
  console.log(`[profile] Overall: totalScore=${totalScore.toFixed(2)} / ${stateCount} states = ${(confidence*100).toFixed(1)}%`);
  return confidence;
}
