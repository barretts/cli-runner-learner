/**
 * Generate an AgentThreader-compatible AdapterPreset from a learned ToolProfile.
 *
 * The output is a TypeScript file that can be dropped into AgentThreader's
 * src/lib/adapters/ directory or imported as a module.
 *
 * Supports manual overrides via adapter-overrides.json to fill gaps that
 * learning cannot yet discover automatically.
 */
import type { ToolProfile } from "../types.js";
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
/**
 * Load adapter overrides from adapter-overrides.json.
 * Returns an empty object if the file doesn't exist.
 */
export declare function loadAdapterOverrides(): Record<string, AdapterOverride>;
/** Reset cache (for testing). */
export declare function clearOverridesCache(): void;
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
export declare function profileToAdapterPreset(profile: ToolProfile, useOverrides?: boolean): GeneratedAdapterPreset;
/**
 * Generate TypeScript source for an AdapterPreset.
 */
export declare function generateAdapterTypeScript(profile: ToolProfile, useOverrides?: boolean): string;
/**
 * Generate JSON representation of the adapter preset.
 */
export declare function generateAdapterJSON(profile: ToolProfile, useOverrides?: boolean): string;
