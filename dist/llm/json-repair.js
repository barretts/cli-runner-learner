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
 * Escape raw control characters (0x00-0x1F) that appear inside JSON string
 * literals. Outside strings these are harmless whitespace; inside strings
 * they cause "Bad control character" parse failures.
 */
function escapeControlCharsInStrings(json) {
    let result = "";
    let inString = false;
    for (let i = 0; i < json.length; i++) {
        const ch = json[i];
        const code = json.charCodeAt(i);
        if (inString) {
            if (ch === '"' && json[i - 1] !== "\\") {
                inString = false;
                result += ch;
            }
            else if (code < 0x20) {
                if (code === 0x0a)
                    result += "\\n";
                else if (code === 0x0d)
                    result += "\\r";
                else if (code === 0x09)
                    result += "\\t";
                else
                    result += "\\u" + code.toString(16).padStart(4, "0");
            }
            else {
                result += ch;
            }
        }
        else {
            if (ch === '"')
                inString = true;
            result += ch;
        }
    }
    return result;
}
/**
 * Attempt to recover valid JSON from messy model output.
 * Strips markdown fences, trailing commas, and JS-style comments.
 */
export function repairJson(raw) {
    let s = raw.trim();
    // Strip markdown code fences: ```json ... ``` or ``` ... ```
    s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    // Strip JS single-line comments (but not inside strings -- good enough heuristic)
    s = s.replace(/^\s*\/\/.*$/gm, "");
    // Strip JS block comments
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");
    // Remove trailing commas before } or ]
    s = s.replace(/,\s*([}\]])/g, "$1");
    s = escapeControlCharsInStrings(s);
    return s.trim();
}
/**
 * Repair and parse JSON from LLM output. Returns null on failure.
 */
export function safeParse(raw) {
    const repaired = repairJson(raw);
    // Try direct parse of repaired text
    try {
        return JSON.parse(repaired);
    }
    catch {
        // noop
    }
    // Fallback: extract first JSON object from repaired text
    const objMatch = repaired.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try {
            return JSON.parse(objMatch[0]);
        }
        catch {
            // noop
        }
    }
    return null;
}
//# sourceMappingURL=json-repair.js.map