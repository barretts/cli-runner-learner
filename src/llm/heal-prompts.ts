import type { LearnHealDecision, LearnFailureClass, ProbeStrategy } from "../types.js";
import type { HealerContext } from "../engine/healer.js";
import type { PromptPair } from "./prompts.js";
import { safeParse } from "./json-repair.js";

const VALID_DECISIONS = new Set(["RETRY", "STOP", "ACCEPT_PARTIAL"]);
const VALID_FAILURE_CLASSES = new Set<string>([
  "probe_no_output", "classification_ambiguous", "state_gap",
  "pattern_noise", "probe_timeout", "tool_crash", "convergence_plateau",
]);
const VALID_PATCH_TARGETS = new Set(["probe_strategy", "classification_hint", "profile_state", "timing_knob"]);
const VALID_OPERATIONS = new Set(["append", "replace"]);

export function buildLearnHealerPrompt(ctx: HealerContext): PromptPair {
  const patternStates = ["startup", "ready", "working", "thinking", "prompting"];
  const stateCoverage: string[] = [];
  for (const stateName of patternStates) {
    const patterns = ctx.profile.learned_patterns.filter((p) => p.classified_as === stateName);
    if (patterns.length === 0) {
      stateCoverage.push(`  ${stateName}: NO PATTERNS (needs probing)`);
    } else {
      const avg = patterns.reduce((s, p) => s + p.confidence, 0) / patterns.length;
      stateCoverage.push(`  ${stateName}: ${patterns.length} patterns, avg confidence ${(avg * 100).toFixed(0)}%`);
    }
  }

  const recentProbes = ctx.completedProbes.slice(-3).map((p) => {
    const states = p.classified_segments.map((s) => s.state);
    const lowConf = p.classified_segments.filter((s) => s.confidence < 0.3).length;
    return `  Round ${p.round}: strategy="${p.strategy}"${p.input_text ? ` input="${p.input_text}"` : ""} -> states: [${states.join(", ")}]${lowConf > 0 ? ` (${lowConf} low-confidence)` : ""}`;
  });

  const discoveryText = ctx.profile.discovery
    ? `Tool description: ${ctx.profile.discovery.parsed_description}\nSubcommands: ${ctx.profile.discovery.subcommands.map((s) => s.name).join(", ") || "none"}\nInteractive: ${ctx.profile.discovery.interactive}`
    : "No discovery data available.";

  return {
    system: `You are a learning diagnostician for CLI tool automation.

A learning system probes interactive CLI tools to discover their behavioral patterns. When learning plateaus (confidence stops improving), you diagnose why and suggest corrective patches.

Available failure classes:
- probe_no_output: probe session produced no useful output
- classification_ambiguous: segments classified with low confidence
- state_gap: some tool states have zero learned patterns
- pattern_noise: patterns extracted but appear across multiple states
- probe_timeout: session hit max duration
- tool_crash: tool exited with error
- convergence_plateau: confidence not improving across rounds

Available patch targets:
- probe_strategy: suggest specific probe strategies and inputs
- classification_hint: add glob pattern indicators to states (JSON: {"state":"<name>","pattern":"<glob>"})
- timing_knob: adjust timing parameters (JSON: {"settle_timeout_ms":<n>} or {"max_probe_session_ms":<n>})
- profile_state: update state descriptions (JSON: {"state":"<name>","description":"<text>"})

Respond with ONLY a JSON object (no markdown fences):
{
  "decision": "RETRY | STOP | ACCEPT_PARTIAL",
  "failure_class": "<primary failure class>",
  "root_cause": "<one-sentence diagnosis>",
  "patches": [{"target": "<target>", "operation": "append | replace", "content": "<string>"}],
  "learned_rule": "<optional reusable insight>",
  "suggested_probes": [{"strategy": "<observe|enter|input|custom|prompt_response>", "input_text": "<optional>", "rationale": "<why>"}]
}

Use STOP only when the failure is genuinely non-fixable (e.g., tool doesn't produce distinguishable states).
Use ACCEPT_PARTIAL when some states have good coverage but others are inherently unobservable.
Use RETRY when you can suggest a concrete change that would improve the next probe round.`,
    user: `Tool: ${ctx.profile.tool_id} (${ctx.profile.tool_command})
Interaction mode: ${ctx.profile.interaction_mode}
Overall confidence: ${(ctx.profile.confidence * 100).toFixed(0)}%
Probe count: ${ctx.profile.probe_count}

${discoveryText}

Confidence history: [${ctx.confidenceHistory.map((c) => (c * 100).toFixed(0) + "%").join(", ")}]

State pattern coverage:
${stateCoverage.join("\n")}

Recent probe results:
${recentProbes.length > 0 ? recentProbes.join("\n") : "  (no probes completed)"}

Active failure signatures:
${ctx.failureSignatures.length > 0 ? ctx.failureSignatures.map((s) => `  - ${s}`).join("\n") : "  (none)"}

Raw diagnostic lines from latest probe:
${ctx.diagnosticLines ?? "(none)"}`,
  };
}

// ---- Parser ----

export function parseLearnHealDecision(raw: string): LearnHealDecision | null {
  const obj = safeParse(raw) as Record<string, unknown> | null;
  if (!obj) return null;

  const decision = String(obj.decision ?? "");
  if (!VALID_DECISIONS.has(decision)) return null;

  const failureClass = String(obj.failure_class ?? "");
  if (!VALID_FAILURE_CLASSES.has(failureClass)) return null;

  const patches: LearnHealDecision["patches"] = [];
  if (Array.isArray(obj.patches)) {
    for (const p of obj.patches as Array<Record<string, unknown>>) {
      const target = String(p.target ?? "");
      const operation = String(p.operation ?? "");
      if (VALID_PATCH_TARGETS.has(target) && VALID_OPERATIONS.has(operation) && p.content) {
        patches.push({
          target: target as LearnHealDecision["patches"][0]["target"],
          operation: operation as "append" | "replace",
          content: String(p.content),
        });
      }
    }
  }

  const suggestedProbes: LearnHealDecision["suggested_probes"] = [];
  if (Array.isArray(obj.suggested_probes)) {
    for (const sp of obj.suggested_probes as Array<Record<string, unknown>>) {
      const strategy = String(sp.strategy ?? "");
      if (strategy) {
        suggestedProbes.push({
          strategy: strategy as ProbeStrategy,
          input_text: sp.input_text ? String(sp.input_text) : undefined,
          rationale: String(sp.rationale ?? "LLM-suggested probe"),
        });
      }
    }
  }

  return {
    decision: decision as LearnHealDecision["decision"],
    failure_class: failureClass as LearnFailureClass,
    root_cause: String(obj.root_cause ?? ""),
    patches,
    learned_rule: obj.learned_rule ? String(obj.learned_rule) : undefined,
    suggested_probes: suggestedProbes.length > 0 ? suggestedProbes : undefined,
  };
}
