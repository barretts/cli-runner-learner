/**
 * Generate a skill markdown file from a learned ToolProfile.
 *
 * The output is a standalone skill document that teaches an agent how to
 * launch, interact with, and interpret the states of a CLI tool.
 */
import type { ToolProfile } from "../types.js";
export declare function generateSkillMarkdown(profile: ToolProfile, useOverrides?: boolean): string;
