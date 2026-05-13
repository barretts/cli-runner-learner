import { safeParse } from "./json-repair.js";
const VALID_STATES = new Set([
    "startup", "ready", "working", "thinking", "prompting", "completed", "error", "unknown",
]);
export function parseClassification(raw) {
    const obj = safeParse(raw);
    if (!obj)
        return null;
    const state = String(obj.state ?? "");
    if (!VALID_STATES.has(state))
        return null;
    const confidence = Number(obj.confidence ?? 0);
    if (confidence < 0 || confidence > 1 || isNaN(confidence))
        return null;
    return {
        state: state,
        confidence,
        reason: String(obj.reason ?? "LLM classification"),
    };
}
export function parseToolDiscovery(raw) {
    const obj = safeParse(raw);
    if (!obj)
        return null;
    const desc = String(obj.parsed_description ?? "");
    if (!desc)
        return null;
    const subcommands = Array.isArray(obj.subcommands)
        ? obj.subcommands.map((s) => ({
            name: String(s.name ?? ""),
            description: String(s.description ?? ""),
            flags: Array.isArray(s.flags) ? s.flags.map(String) : [],
        })).filter((s) => s.name)
        : [];
    const common_flags = Array.isArray(obj.common_flags)
        ? obj.common_flags.map(String)
        : [];
    return {
        parsed_description: desc,
        subcommands,
        common_flags,
        interactive: Boolean(obj.interactive),
    };
}
export function parseProbeStrategy(raw) {
    const obj = safeParse(raw);
    if (!obj)
        return null;
    const strategy = String(obj.strategy ?? "");
    if (!strategy)
        return null;
    return {
        strategy,
        input_text: obj.input_text ? String(obj.input_text) : undefined,
        rationale: String(obj.rationale ?? "LLM-generated probe"),
        expected_outcome: obj.expected_outcome ? String(obj.expected_outcome) : undefined,
    };
}
const PROMPT_TYPES = new Set(["yes_no", "selection", "text_input", "confirmation", "unknown"]);
export function parseSubPromptAnalysis(raw) {
    const obj = safeParse(raw);
    if (!obj)
        return null;
    const promptText = String(obj.prompt_text ?? "");
    if (!promptText)
        return null;
    const promptType = String(obj.prompt_type ?? "unknown");
    const confidence = Number(obj.confidence ?? 0.5);
    return {
        prompt_text: promptText,
        prompt_type: PROMPT_TYPES.has(promptType) ? promptType : "unknown",
        suggested_response: String(obj.suggested_response ?? ""),
        confidence: isNaN(confidence) ? 0.5 : Math.max(0, Math.min(1, confidence)),
    };
}
//# sourceMappingURL=parsers.js.map