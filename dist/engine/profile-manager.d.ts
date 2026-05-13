import type { ToolProfile, ToolDiscovery, LearnedPattern } from "../types.js";
/**
 * Atomic JSON write: temp file + rename on same filesystem.
 * Prevents corrupt state on crash mid-write.
 */
export declare function writeAtomicJson(filePath: string, data: unknown): Promise<void>;
/**
 * Load a profile by tool ID.
 * Resolution order: user profile dir -> bundled seed profiles.
 */
export declare function loadProfile(toolId: string): Promise<ToolProfile | null>;
/**
 * Save a profile to the user profile directory.
 * Always writes to .clr/profiles/, never to the npm package.
 */
export declare function saveProfile(profile: ToolProfile): Promise<string>;
/**
 * List available profile IDs (without .json extension).
 * Checks user profiles first, then bundled.
 */
export declare function listProfileIds(): Promise<string[]>;
export declare function bootstrapProfile(toolId: string, command: string, interactionMode?: "interactive" | "args", discovery?: ToolDiscovery): ToolProfile;
/**
 * Merge newly learned patterns into an existing profile.
 * Updates state indicators, confidence scores, and probe count.
 */
export declare function mergeLearnedPatterns(profile: ToolProfile, newPatterns: LearnedPattern[], metadata?: {
    tool_version?: string;
    terminal_cols?: number;
    terminal_rows?: number;
}): ToolProfile;
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
export declare function registerSubPrompt(profile: ToolProfile, detected: DetectedSubPrompt): ToolProfile;
/**
 * Register structural indicators on the profile from classified segments.
 * Some states (like "ready" in TUI tools) are defined by structural events
 * (silence/settle) rather than text patterns. This function detects those
 * states from classification results and adds the appropriate indicators.
 */
export declare function registerStructuralIndicators(profile: ToolProfile, classifiedRuns: Array<{
    segments: import("../types.js").ClassifiedSegment[];
}>): ToolProfile;
