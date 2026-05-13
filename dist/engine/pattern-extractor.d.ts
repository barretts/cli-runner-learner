import type { ClassifiedSegment, LearnedPattern } from "../types.js";
/**
 * Extract stable patterns from classified segments across multiple probe runs.
 * Finds repeated text fragments that consistently appear in the same state.
 */
export declare function extractPatterns(classifiedRuns: Array<{
    transcript_path: string;
    segments: ClassifiedSegment[];
}>): LearnedPattern[];
