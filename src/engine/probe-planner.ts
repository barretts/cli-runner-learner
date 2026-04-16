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
  if (healerSuggestion) return healerSuggestion;
  // Without LLM or if budget exhausted, use deterministic cycle
  if (!llmClient || llmClient.exhausted) {
    const idx = completedProbes.length % FALLBACK_CYCLE.length;
    const strategy = FALLBACK_CYCLE[idx];
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

  try {
    const prompt = buildProbeStrategyPrompt(profile, history);
    const raw = await llmClient.complete(prompt.system, prompt.user);
    const parsed = parseProbeStrategy(raw);

    if (parsed) {
      const strategy = normalizeStrategy(parsed.strategy);
      return {
        strategy,
        input_text: parsed.input_text,
        rationale: parsed.rationale,
        expected_outcome: parsed.expected_outcome,
      };
    }
  } catch {
    // LLM call failed -- fall through to deterministic
  }

  const idx = completedProbes.length % FALLBACK_CYCLE.length;
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
