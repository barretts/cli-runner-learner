/**
 * JSON repair utilities for cleaning LLM output before parsing.
 * Ported from 3pp-fix-database/src/parser.ts.
 *
 * Handles common LLM artifacts:
 *  - Markdown code fences (```json ... ```)
 *  - JS single-line and block comments
 *  - Trailing commas before } or ]
 *  - Raw control characters inside JSON string literals
 */
/**
 * Attempt to recover valid JSON from messy model output.
 * Strips markdown fences, trailing commas, and JS-style comments.
 */
export declare function repairJson(raw: string): string;
/**
 * Repair and parse JSON from LLM output. Returns null on failure.
 */
export declare function safeParse(raw: string): unknown | null;
