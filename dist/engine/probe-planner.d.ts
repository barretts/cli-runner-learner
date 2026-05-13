import type { ToolProfile, ProbeStrategy, ProbeResult } from "../types.js";
import type { LLMClient } from "../llm/client.js";
export interface PlannedProbe {
    strategy: ProbeStrategy;
    input_text?: string;
    rationale: string;
    expected_outcome?: string;
}
/**
 * Plan the next probe round. With an LLM, adapts based on profile state
 * and probe history. Without LLM, cycles through the 4 fixed strategies.
 */
export declare function planNextProbe(profile: ToolProfile, completedProbes: ProbeResult[], llmClient: LLMClient | null, healerSuggestion?: PlannedProbe): Promise<PlannedProbe>;
