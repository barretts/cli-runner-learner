import type { ToolProfile, ProbeStrategy, ProbeResult } from "../types.js";
import type { LLMClient } from "../llm/client.js";
import { buildProbeStrategyPrompt, type ProbeHistoryEntry } from "../llm/prompts.js";
import { parseProbeStrategy } from "../llm/parsers.js";

export interface PlannedProbe {
  strategy: ProbeStrategy;
  input_text?: string;
  rationale: string;
  expected_outcome?: string;
}

const FALLBACK_CYCLE: ProbeStrategy[] = ["observe", "enter", "input", "prompt_response"];

/**
 * Plan the next probe round. With an LLM, adapts based on profile state
 * and probe history. Without LLM, cycles through the 4 fixed strategies.
 */
export async function planNextProbe(
  profile: ToolProfile,
  completedProbes: ProbeResult[],
  llmClient: LLMClient | null,
  healerSuggestion?: PlannedProbe,
): Promise<PlannedProbe> {
  console.log(`[planner] Planning next probe. Completed: ${completedProbes.length}, healer suggestion: ${healerSuggestion ? healerSuggestion.strategy : 'none'}`);

  if (healerSuggestion) {
    console.log(`[planner] Using healer suggestion: ${healerSuggestion.strategy}${healerSuggestion.input_text ? ` "${healerSuggestion.input_text}"` : ''} -- ${healerSuggestion.rationale}`);
    return healerSuggestion;
  }
  // Without LLM or if budget exhausted, use deterministic cycle
  if (!llmClient || llmClient.exhausted) {
    const idx = completedProbes.length % FALLBACK_CYCLE.length;
    const strategy = FALLBACK_CYCLE[idx];
    console.log(`[planner] LLM ${!llmClient ? 'unavailable' : 'exhausted'} -- fallback cycle idx=${idx}: ${strategy}`);
    return {
      strategy,
      input_text: strategy === "input" ? "hello" : undefined,
      rationale: `Fallback cycle: strategy ${idx + 1}/${FALLBACK_CYCLE.length}`,
    };
  }

  // Build probe history for the LLM
  const history: ProbeHistoryEntry[] = completedProbes.map((p, i) => ({
    round: p.round,
    strategy: p.strategy,
    input_text: p.input_text,
    states_observed: p.classified_segments.map((s) => s.state),
    rationale: p.rationale,
  }));

  console.log(`[planner] Asking LLM with ${history.length} probe history entries`);
  for (const h of history) {
    console.log(`[planner]   Round ${h.round}: ${h.strategy}${h.input_text ? ` "${h.input_text}"` : ''} -> states=[${h.states_observed.join(', ')}]`);
  }

  // Log profile state coverage for context
  const patternStates = ["startup", "ready", "working", "thinking", "prompting"];
  for (const s of patternStates) {
    const count = profile.learned_patterns.filter(p => p.classified_as === s).length;
    const indicators = profile.states[s]?.indicators.length ?? 0;
    console.log(`[planner]   Profile ${s}: ${count} patterns, ${indicators} indicators`);
  }

  try {
    const prompt = buildProbeStrategyPrompt(profile, history);
    console.log(`[planner] LLM prompt lengths: system=${prompt.system.length}, user=${prompt.user.length}`);
    const raw = await llmClient.complete(prompt.system, prompt.user);
    console.log(`[planner] LLM response: ${raw.length} chars`);
    console.log(`[planner] LLM raw (first 300): ${raw.substring(0, 300).replace(/\n/g, '\\n')}`);
    const parsed = parseProbeStrategy(raw);

    if (parsed) {
      const strategy = normalizeStrategy(parsed.strategy);
      console.log(`[planner] LLM chose: ${strategy}${parsed.input_text ? ` "${parsed.input_text}"` : ''} -- ${parsed.rationale}`);
      return {
        strategy,
        input_text: parsed.input_text,
        rationale: parsed.rationale,
        expected_outcome: parsed.expected_outcome,
      };
    }
    console.log(`[planner] LLM response could not be parsed -- falling back`);
  } catch (e) {
    console.log(`[planner] LLM call failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const idx = completedProbes.length % FALLBACK_CYCLE.length;
  console.log(`[planner] Fallback after LLM failure: idx=${idx} -> ${FALLBACK_CYCLE[idx]}`);
  return {
    strategy: FALLBACK_CYCLE[idx],
    input_text: FALLBACK_CYCLE[idx] === "input" ? "hello" : undefined,
    rationale: "LLM probe planning failed, using fallback cycle",
  };
}

function normalizeStrategy(raw: string): ProbeStrategy {
  const lower = raw.toLowerCase().replace(/[-_\s]/g, "");
  if (lower === "observe") return "observe";
  if (lower === "enter") return "enter";
  if (lower === "input") return "input";
  if (lower === "ctrlc" || lower === "promptresponse") return "prompt_response";
  if (lower === "custom") return "custom";
  return "observe";
}
