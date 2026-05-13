import type { ToolState } from "../types.js";
export interface ParsedClassification {
    state: ToolState;
    confidence: number;
    reason: string;
}
export declare function parseClassification(raw: string): ParsedClassification | null;
export interface ParsedToolDiscovery {
    parsed_description: string;
    subcommands: Array<{
        name: string;
        description: string;
        flags: string[];
    }>;
    common_flags: string[];
    interactive: boolean;
}
export declare function parseToolDiscovery(raw: string): ParsedToolDiscovery | null;
export interface ParsedProbeStrategy {
    strategy: string;
    input_text?: string;
    rationale: string;
    expected_outcome?: string;
}
export declare function parseProbeStrategy(raw: string): ParsedProbeStrategy | null;
export interface ParsedSubPrompt {
    prompt_text: string;
    prompt_type: "yes_no" | "selection" | "text_input" | "confirmation" | "unknown";
    suggested_response: string;
    confidence: number;
}
export declare function parseSubPromptAnalysis(raw: string): ParsedSubPrompt | null;
