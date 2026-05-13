import type { TranscriptSegment, ClassifiedSegment, ToolState, ToolProfile } from "../types.js";
import type { LLMClient } from "../llm/client.js";
/**
 * Classify transcript segments into tool states using heuristic rules.
 * When a profile exists, its state indicators take priority.
 * When an LLM client is provided, ambiguous classifications (confidence < 0.3)
 * are sent to the LLM for a second opinion.
 */
export declare function classifySegments(segments: TranscriptSegment[], profile?: ToolProfile, llmClient?: LLMClient | null): Promise<ClassifiedSegment[]>;
/**
 * Extract unique text fragments from classified segments for a given state.
 * Returns de-duplicated lines that appeared in segments of that state.
 */
export declare function extractTextForState(classified: ClassifiedSegment[], state: ToolState): string[];
