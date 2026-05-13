export declare function stripTermEscapes(s: string): string;
export declare function hasVisibleContent(line: string): boolean;
export declare function deepStripTuiArtifacts(text: string): string;
/**
 * Extract diagnostic lines (errors/warnings + context) from raw terminal output.
 * Returns a formatted string capped at 5000 chars for use in healer prompts.
 */
export declare function extractDiagnosticLines(raw: string): string;
/**
 * Match a glob pattern against text. Supports * (match anything) only.
 * Case-insensitive matching when caseInsensitive is true.
 */
export declare function globMatch(pattern: string, text: string, caseInsensitive?: boolean): boolean;
