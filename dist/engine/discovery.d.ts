import type { ToolDiscovery } from "../types.js";
import type { LLMClient } from "../llm/client.js";
/**
 * Detect reduce-motion env vars for a tool.
 * Checks the known registry first, then scans help text for hints.
 */
export declare function detectReduceMotionEnv(command: string, helpText?: string): Record<string, string>;
/**
 * Discover a CLI tool's capabilities by running it with help flags.
 * Tries --help, -h, and help in sequence until one produces output.
 * If an LLM client is available, parses the help text into structured data.
 * Falls back to regex extraction without LLM.
 */
export declare function discoverTool(command: string, llmClient: LLMClient | null): Promise<ToolDiscovery | null>;
