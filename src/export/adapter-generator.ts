/**
 * Generate an AgentThreader-compatible AdapterPreset from a learned ToolProfile.
 *
 * The output is a TypeScript file that can be dropped into AgentThreader's
 * src/lib/adapters/ directory or imported as a module.
 *
 * Supports manual overrides via adapter-overrides.json to fill gaps that
 * learning cannot yet discover automatically.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolProfile } from "../types.js";

const PROJECT_ROOT = resolve(new URL("../../", import.meta.url).pathname);

export interface ForbiddenArgEntry {
  flag: string;
  reason: string;
}

export interface AdapterOverride {
  promptDelivery?: "stdin" | "positional-arg" | "flag";
  promptFlag?: string;
  defaultArgs?: string[];
  forbiddenArgs?: ForbiddenArgEntry[];
  stdinIgnore?: boolean;
  toolCallsHiddenInStdout?: boolean;
  needsLineBuffering?: boolean;
  maxTurns?: number;
  noisePatterns?: string[];
  transientErrorPatterns?: string[];
  notes?: string[];
}

let _overridesCache: Record<string, AdapterOverride> | null = null;

/**
 * Load adapter overrides from adapter-overrides.json.
 * Returns an empty object if the file doesn't exist.
 */
export function loadAdapterOverrides(): Record<string, AdapterOverride> {
  if (_overridesCache) return _overridesCache;
  try {
    const raw = readFileSync(resolve(PROJECT_ROOT, "adapter-overrides.json"), "utf-8");
    const parsed = JSON.parse(raw);
    // Filter out $comment and other non-tool keys
    const overrides: Record<string, AdapterOverride> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (key.startsWith("$")) continue;
      overrides[key] = val as AdapterOverride;
    }
    _overridesCache = overrides;
    return overrides;
  } catch {
    _overridesCache = {};
    return {};
  }
}

/** Reset cache (for testing). */
export function clearOverridesCache(): void {
  _overridesCache = null;
}

export interface GeneratedAdapterPreset {
  id: string;
  command: string;
  promptDelivery: "stdin" | "positional-arg" | "flag";
  promptFlag?: string;
  defaultArgs: string[];
  forbiddenArgs: string[];
  healthcheckArgs: string[];
  healthcheckTimeoutMs: number;
  stdinIgnore: boolean;
  toolCallsHiddenInStdout: boolean;
  sessionShowCommand?: string[];
  sessionIdPattern?: string;
  sessionContinueFlag?: string;
  noisePatterns: string[];
  needsLineBuffering: boolean;
  maxTurns?: number;
  sigkillDelayMs: number;
  transientErrorPatterns: string[];
  notes: string[];
}

/**
 * Convert a ToolProfile to a GeneratedAdapterPreset object.
 * When useOverrides is true (default), merges manual overrides from adapter-overrides.json.
 */
export function profileToAdapterPreset(profile: ToolProfile, useOverrides = true): GeneratedAdapterPreset {
  const discovery = profile.discovery;

  // Map interaction mode to prompt delivery
  let promptDelivery: "stdin" | "positional-arg" | "flag" = "stdin";
  if (profile.interaction_mode === "args") {
    // Check if there's a run subcommand (common pattern: tool run <prompt>)
    const hasRun = discovery?.subcommands?.some(s => s.name === "run");
    promptDelivery = hasRun ? "positional-arg" : "positional-arg";
  }

  // Build default args from launch config
  const defaultArgs = [...profile.launch.default_args];

  // Extract transient error patterns from error state indicators
  const errorIndicators = profile.states.error?.indicators ?? [];
  const transientPatterns: string[] = [];
  for (const ind of errorIndicators) {
    if (ind.type === "output_glob" && ind.pattern) {
      transientPatterns.push(ind.pattern);
    }
  }
  // Add common transient patterns
  transientPatterns.push(
    "stream error",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "429",
    "rate limit",
  );

  // Session management detection
  let sessionShowCommand: string[] | undefined;
  let sessionIdPattern: string | undefined;
  let sessionContinueFlag: string | undefined;
  if (discovery?.subcommands?.some(s => s.name === "session")) {
    sessionShowCommand = [profile.tool_command, "session", "show"];
    sessionIdPattern = "session_id=([0-9a-f-]{36})";
    sessionContinueFlag = "--session";
  }

  // Build notes from discovery
  const notes: string[] = [];
  if (discovery?.parsed_description) {
    notes.push(discovery.parsed_description);
  }
  notes.push(`Interaction mode: ${profile.interaction_mode}`);
  if (profile.launch.needs_pty) {
    notes.push("Requires PTY for proper operation");
  }
  if (profile.reduce_motion_env && Object.keys(profile.reduce_motion_env).length > 0) {
    for (const [k, v] of Object.entries(profile.reduce_motion_env)) {
      notes.push(`Set ${k}=${v} to reduce animation noise`);
    }
  }
  // Add subcommand info
  if (discovery?.subcommands && discovery.subcommands.length > 0) {
    notes.push(`Subcommands: ${discovery.subcommands.map(s => s.name).join(", ")}`);
  }
  // Add timing notes
  notes.push(`Typical startup: ${profile.timing.typical_startup_sec}s`);
  notes.push(`Idle threshold: ${profile.timing.idle_threshold_sec}s`);

  const base: GeneratedAdapterPreset = {
    id: profile.tool_id,
    command: profile.tool_command,
    promptDelivery,
    defaultArgs,
    forbiddenArgs: [],
    healthcheckArgs: ["--version"],
    healthcheckTimeoutMs: 10_000,
    stdinIgnore: profile.interaction_mode === "args",
    toolCallsHiddenInStdout: !!sessionShowCommand,
    sessionShowCommand,
    sessionIdPattern,
    sessionContinueFlag,
    noisePatterns: [],
    needsLineBuffering: profile.interaction_mode === "interactive",
    sigkillDelayMs: 5_000,
    transientErrorPatterns: transientPatterns,
    notes,
  };

  if (!useOverrides) return base;

  // Merge manual overrides
  const overrides = loadAdapterOverrides();
  const ov = overrides[profile.tool_id];
  if (!ov) return base;

  // Scalar overrides (replace)
  if (ov.promptDelivery) base.promptDelivery = ov.promptDelivery;
  if (ov.promptFlag) base.promptFlag = ov.promptFlag;
  if (ov.stdinIgnore !== undefined) base.stdinIgnore = ov.stdinIgnore;
  if (ov.toolCallsHiddenInStdout !== undefined) base.toolCallsHiddenInStdout = ov.toolCallsHiddenInStdout;
  if (ov.needsLineBuffering !== undefined) base.needsLineBuffering = ov.needsLineBuffering;
  if (ov.maxTurns !== undefined) base.maxTurns = ov.maxTurns;

  // Array overrides (replace entirely when present)
  if (ov.defaultArgs) base.defaultArgs = ov.defaultArgs;
  if (ov.noisePatterns) base.noisePatterns = ov.noisePatterns;
  if (ov.notes) base.notes = ov.notes;

  // forbiddenArgs from override (profile has no opinion)
  if (ov.forbiddenArgs) {
    base.forbiddenArgs = ov.forbiddenArgs.map(e => e.flag);
  }

  // transientErrorPatterns: merge override + profile-derived, deduplicate
  if (ov.transientErrorPatterns) {
    const merged = [...base.transientErrorPatterns];
    for (const p of ov.transientErrorPatterns) {
      if (!merged.includes(p)) merged.push(p);
    }
    base.transientErrorPatterns = merged;
  }

  return base;
}

/**
 * Generate TypeScript source for an AdapterPreset.
 */
export function generateAdapterTypeScript(profile: ToolProfile, useOverrides = true): string {
  const preset = profileToAdapterPreset(profile, useOverrides);
  const overrides = useOverrides ? loadAdapterOverrides() : {};
  const hasOverrides = profile.tool_id in overrides;
  const constName = profile.tool_id.toUpperCase().replace(/-/g, "_") + "_PRESET";
  const lines: string[] = [];

  lines.push(`/**`);
  lines.push(` * Auto-generated adapter preset for ${profile.tool_id}.`);
  lines.push(` * Generated by cli-runner-learner from learned profile.`);
  lines.push(` * Profile confidence: ${(profile.confidence * 100).toFixed(1)}%`);
  if (hasOverrides) {
    lines.push(` * Manual overrides applied: yes (adapter-overrides.json)`);
  }
  lines.push(` * Generated: ${new Date().toISOString()}`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`import type { AdapterPreset } from "./types.js";`);
  lines.push(``);
  lines.push(`export const ${constName}: AdapterPreset = {`);
  lines.push(`  id: ${JSON.stringify(preset.id)},`);
  lines.push(`  command: ${JSON.stringify(preset.command)},`);
  lines.push(`  promptDelivery: ${JSON.stringify(preset.promptDelivery)},`);
  if (preset.promptFlag) {
    lines.push(`  promptFlag: ${JSON.stringify(preset.promptFlag)},`);
  }
  lines.push(`  defaultArgs: ${JSON.stringify(preset.defaultArgs)},`);
  if (hasOverrides && overrides[profile.tool_id]?.forbiddenArgs?.length) {
    lines.push(`  forbiddenArgs: [`);
    for (const entry of overrides[profile.tool_id].forbiddenArgs!) {
      lines.push(`    ${JSON.stringify(entry.flag)},  // ${entry.reason}`);
    }
    lines.push(`  ],`);
  } else {
    lines.push(`  forbiddenArgs: ${JSON.stringify(preset.forbiddenArgs)},`);
  }
  lines.push(`  healthcheckArgs: ${JSON.stringify(preset.healthcheckArgs)},`);
  lines.push(`  healthcheckTimeoutMs: ${preset.healthcheckTimeoutMs},`);
  lines.push(`  stdinIgnore: ${preset.stdinIgnore},`);
  lines.push(`  toolCallsHiddenInStdout: ${preset.toolCallsHiddenInStdout},`);
  if (preset.sessionShowCommand) {
    lines.push(`  sessionShowCommand: ${JSON.stringify(preset.sessionShowCommand)},`);
  }
  if (preset.sessionIdPattern) {
    lines.push(`  sessionIdPattern: /${preset.sessionIdPattern}/,`);
  }
  if (preset.sessionContinueFlag) {
    lines.push(`  sessionContinueFlag: ${JSON.stringify(preset.sessionContinueFlag)},`);
  }
  // noisePatterns as RegExp[]
  if (preset.noisePatterns.length > 0) {
    lines.push(`  noisePatterns: [`);
    for (const p of preset.noisePatterns) {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      lines.push(`    /${escaped}/,`);
    }
    lines.push(`  ],`);
  } else {
    lines.push(`  noisePatterns: [],`);
  }
  lines.push(`  needsLineBuffering: ${preset.needsLineBuffering},`);
  if (preset.maxTurns !== undefined) {
    lines.push(`  maxTurns: ${preset.maxTurns},`);
  }
  lines.push(`  sigkillDelayMs: ${preset.sigkillDelayMs},`);

  // transientErrorPatterns as RegExp[]
  lines.push(`  transientErrorPatterns: [`);
  for (const p of preset.transientErrorPatterns) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    lines.push(`    /${escaped}/i,`);
  }
  lines.push(`  ],`);

  // notes
  lines.push(`  notes: [`);
  for (const n of preset.notes) {
    lines.push(`    ${JSON.stringify(n)},`);
  }
  lines.push(`  ],`);

  lines.push(`};`);
  lines.push(``);

  return lines.join("\n");
}

/**
 * Generate JSON representation of the adapter preset.
 */
export function generateAdapterJSON(profile: ToolProfile, useOverrides = true): string {
  const preset = profileToAdapterPreset(profile, useOverrides);
  return JSON.stringify(preset, null, 2);
}
