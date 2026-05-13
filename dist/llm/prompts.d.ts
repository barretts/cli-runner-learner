import type { ToolProfile, StateDefinition } from "../types.js";
export interface PromptPair {
    system: string;
    user: string;
}
export declare function buildClassifierPrompt(segmentText: string, profileStates: Record<string, StateDefinition>, context: {
    segmentIndex: number;
    totalSegments: number;
    prevState?: string;
}): PromptPair;
export declare function buildToolDiscoveryPrompt(helpText: string): PromptPair;
export interface ProbeHistoryEntry {
    round: number;
    strategy: string;
    input_text?: string;
    states_observed: string[];
    rationale?: string;
}
export declare function buildProbeStrategyPrompt(profile: ToolProfile, probeHistory: ProbeHistoryEntry[]): PromptPair;
export declare function buildSubPromptAnalysisPrompt(outputText: string): PromptPair;
