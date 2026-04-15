import type { ToolState } from "../types.js";
import { safeParse } from "./json-repair.js";

const VALID_STATES: Set<string> = new Set([
  "startup", "ready", "working", "thinking", "prompting", "completed", "error", "unknown",
]);

// ---- Classification ----

export interface ParsedClassification {
  state: ToolState;
  confidence: number;
  reason: string;
}

export function parseClassification(raw: string): ParsedClassification | null {
  const obj = safeParse(raw) as Record<string, unknown> | null;
  if (!obj) return null;

  const state = String(obj.state ?? "");
  if (!VALID_STATES.has(state)) return null;

  const confidence = Number(obj.confidence ?? 0);
  if (confidence < 0 || confidence > 1 || isNaN(confidence)) return null;

  return {
    state: state as ToolState,
    confidence,
    reason: String(obj.reason ?? "LLM classification"),
  };
}

// ---- Tool Discovery ----

export interface ParsedToolDiscovery {
  parsed_description: string;
  subcommands: Array<{ name: string; description: string; flags: string[] }>;
  common_flags: string[];
  interactive: boolean;
}

export function parseToolDiscovery(raw: string): ParsedToolDiscovery | null {
  const obj = safeParse(raw) as Record<string, unknown> | null;
  if (!obj) return null;

  const desc = String(obj.parsed_description ?? "");
  if (!desc) return null;

  const subcommands = Array.isArray(obj.subcommands)
    ? (obj.subcommands as Array<Record<string, unknown>>).map((s) => ({
        name: String(s.name ?? ""),
        description: String(s.description ?? ""),
        flags: Array.isArray(s.flags) ? s.flags.map(String) : [],
      })).filter((s) => s.name)
    : [];

  const common_flags = Array.isArray(obj.common_flags)
    ? (obj.common_flags as unknown[]).map(String)
    : [];

  return {
    parsed_description: desc,
    subcommands,
    common_flags,
    interactive: Boolean(obj.interactive),
  };
}

// ---- Probe Strategy ----

export interface ParsedProbeStrategy {
  strategy: string;
  input_text?: string;
  rationale: string;
  expected_outcome?: string;
}

export function parseProbeStrategy(raw: string): ParsedProbeStrategy | null {
  const obj = safeParse(raw) as Record<string, unknown> | null;
  if (!obj) return null;

  const strategy = String(obj.strategy ?? "");
  if (!strategy) return null;

  return {
    strategy,
    input_text: obj.input_text ? String(obj.input_text) : undefined,
    rationale: String(obj.rationale ?? "LLM-generated probe"),
    expected_outcome: obj.expected_outcome ? String(obj.expected_outcome) : undefined,
  };
}

// ---- Sub-Prompt Analysis ----

export interface ParsedSubPrompt {
  prompt_text: string;
  prompt_type: "yes_no" | "selection" | "text_input" | "confirmation" | "unknown";
  suggested_response: string;
  confidence: number;
}

const PROMPT_TYPES = new Set(["yes_no", "selection", "text_input", "confirmation", "unknown"]);

export function parseSubPromptAnalysis(raw: string): ParsedSubPrompt | null {
  const obj = safeParse(raw) as Record<string, unknown> | null;
  if (!obj) return null;

  const promptText = String(obj.prompt_text ?? "");
  if (!promptText) return null;

  const promptType = String(obj.prompt_type ?? "unknown");
  const confidence = Number(obj.confidence ?? 0.5);

  return {
    prompt_text: promptText,
    prompt_type: PROMPT_TYPES.has(promptType) ? promptType as ParsedSubPrompt["prompt_type"] : "unknown",
    suggested_response: String(obj.suggested_response ?? ""),
    confidence: isNaN(confidence) ? 0.5 : Math.max(0, Math.min(1, confidence)),
  };
}
