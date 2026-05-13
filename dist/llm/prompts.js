// ---- Classification ----
export function buildClassifierPrompt(segmentText, profileStates, context) {
    const stateDescriptions = Object.entries(profileStates)
        .map(([name, def]) => `  "${name}": ${def.description}`)
        .join("\n");
    return {
        system: `You are a terminal output classifier for CLI tool automation.

Given a segment of terminal output, classify it into exactly one tool state.

Available states:
${stateDescriptions}

Respond with ONLY a JSON object (no markdown fences):
{
  "state": "<state_name>",
  "confidence": <0.0-1.0>,
  "reason": "<brief explanation>"
}`,
        user: `Segment ${context.segmentIndex + 1} of ${context.totalSegments}${context.prevState ? ` (previous state: ${context.prevState})` : ""}:

---
${segmentText.substring(0, 2000)}
---`,
    };
}
// ---- Tool Discovery ----
export function buildToolDiscoveryPrompt(helpText) {
    return {
        system: `You are a CLI tool analyzer. Given the --help output of a command-line tool, extract its structure into a JSON schema.

Respond with ONLY a JSON object (no markdown fences):
{
  "parsed_description": "<one-line description of what the tool does>",
  "subcommands": [
    { "name": "<subcommand>", "description": "<what it does>", "flags": ["--flag1", "--flag2"] }
  ],
  "common_flags": ["--help", "--version", ...],
  "interactive": <true if the tool has an interactive REPL/TUI mode, false if it runs and exits>
}

Only include subcommands and flags that are clearly documented. Do not guess.`,
        user: `Help output:

---
${helpText.substring(0, 4000)}
---`,
    };
}
export function buildProbeStrategyPrompt(profile, probeHistory) {
    const stateConfidence = {};
    const patternStates = ["startup", "ready", "working", "thinking", "prompting"];
    for (const stateName of patternStates) {
        const patterns = profile.learned_patterns.filter((p) => p.classified_as === stateName);
        if (patterns.length === 0) {
            stateConfidence[stateName] = "no patterns (needs probing)";
        }
        else {
            const avg = patterns.reduce((s, p) => s + p.confidence, 0) / patterns.length;
            stateConfidence[stateName] = `${patterns.length} patterns, avg confidence ${(avg * 100).toFixed(0)}%`;
        }
    }
    const historyText = probeHistory.length > 0
        ? probeHistory.map((h) => `  Round ${h.round}: strategy="${h.strategy}"${h.input_text ? ` input="${h.input_text}"` : ""} -> states: [${h.states_observed.join(", ")}]`).join("\n")
        : "  (no probes completed yet)";
    const discoveryText = profile.discovery
        ? `Tool description: ${profile.discovery.parsed_description}\nSubcommands: ${profile.discovery.subcommands.map((s) => s.name).join(", ") || "none"}\nInteractive: ${profile.discovery.interactive}`
        : "No discovery data available.";
    return {
        system: `You are a probe strategy planner for CLI tool learning.

Your goal is to choose the next probe action that will teach us the most about this tool's behavior. Focus on states with low confidence or no patterns.

Available strategies:
- "observe": Launch tool, wait for it to settle, exit. Good for learning startup behavior.
- "enter": Launch, wait, send Enter key. Tests what happens on empty input.
- "input": Launch, wait, send specific text (set input_text). Tests input handling.
- "shortcut": Launch, wait, send keyboard shortcuts (Tab, Shift-Tab, Esc, arrows). Learns TUI navigation and autocomplete.
- "ctrl_c": Launch, wait, send Ctrl-C. Tests interrupt/cancel/exit behavior.
- "explore": Launch, wait, send discovery commands (/help, ?, help, /quit). Learns tool-specific help and exit patterns.
- "multi_turn": Launch, send input, wait for response, send follow-up (set input_text for first message). Learns conversation flow and working→ready transitions.
- "permission_flow": Launch, send a command that triggers side-effects, wait for permission prompt, auto-accept. Learns permission/confirmation prompt patterns.
- "prompt_response": Send a side-effect command that triggers a permission prompt, respond affirmatively. Captures the prompting state.
- "custom": Send any specific text (set input_text). Use for targeted probing.

Respond with ONLY a JSON object (no markdown fences):
{
  "strategy": "<strategy_name>",
  "input_text": "<text to send, for input/custom/multi_turn/explore strategies>",
  "rationale": "<why this probe will be informative>",
  "expected_outcome": "<what we expect to learn>"
}`,
        user: `Tool: ${profile.tool_id} (${profile.tool_command})
Interaction mode: ${profile.interaction_mode}
Overall confidence: ${(profile.confidence * 100).toFixed(0)}%
Probe count: ${profile.probe_count}

${discoveryText}

State knowledge:
${Object.entries(stateConfidence).map(([s, v]) => `  ${s}: ${v}`).join("\n")}

Probe history:
${historyText}`,
    };
}
// ---- Sub-Prompt Analysis ----
export function buildSubPromptAnalysisPrompt(outputText) {
    return {
        system: `You are a terminal prompt analyzer. Given terminal output that appears to be asking for user input, determine what kind of prompt it is and suggest an appropriate safe response.

Respond with ONLY a JSON object (no markdown fences):
{
  "prompt_text": "<the exact text of the prompt>",
  "prompt_type": "<yes_no | selection | text_input | confirmation | unknown>",
  "suggested_response": "<safe response to send>",
  "confidence": <0.0-1.0>
}

For yes/no prompts, prefer "n" or "no" (safe default).
For selection prompts, prefer the first/default option.
For confirmations, prefer to decline unless the action is clearly safe.`,
        user: `Terminal output:

---
${outputText.substring(0, 2000)}
---`,
    };
}
//# sourceMappingURL=prompts.js.map