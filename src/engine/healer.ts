import type {
  ToolProfile,
  ProbeResult,
  LearnFailureClass,
  LearnHealDecision,
  LearnHealPatch,
  ProbeStrategy,
  ToolState,
} from "../types.js";
import type { PlannedProbe } from "./probe-planner.js";
import type { LLMClient } from "../llm/client.js";
import { buildLearnHealerPrompt, parseLearnHealDecision } from "../llm/heal-prompts.js";

const MAX_PATTERN_LENGTH = 60;
const MAX_PATTERNS_PER_HEAL = 3;
const TIMING_CAP_MULTIPLIER = 2;

// ---- Failure Signature ----

export interface LearnDiagnosis {
  failure_class: LearnFailureClass;
  signature: string;
  detail: string;
}

/**
 * Stable failure signature for learning failures.
 * Adapted from 3pp-fix-database parser.ts stableFailureSignature.
 * Strips volatile parts so identical failures cluster together.
 */
export function stableLearnFailureSignature(
  failureClass: string,
  signal: string,
): string {
  let normalized = signal
    .replace(/\/[^\s]+/g, "<path>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[:\d.Z+-]*/g, "<timestamp>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{6,}\b/g, "<num>")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length > 120) normalized = normalized.slice(0, 120);
  return `${failureClass}:${normalized}`;
}

// ---- Failure Diagnosis ----

const PATTERN_STATES: ToolState[] = ["startup", "ready", "working", "thinking", "prompting"];

/**
 * Examine probe results and profile state to diagnose WHY learning is stuck.
 * Returns a list of specific failures with stable signatures.
 */
export function diagnoseLearnFailures(
  probes: ProbeResult[],
  profile: ToolProfile,
): LearnDiagnosis[] {
  console.log(`[heal-diag] Diagnosing learn failures: ${probes.length} probes, ${profile.learned_patterns.length} patterns`);
  const failures: LearnDiagnosis[] = [];

  // States with zero learned patterns
  for (const stateName of PATTERN_STATES) {
    const patterns = profile.learned_patterns.filter((p) => p.classified_as === stateName);
    if (patterns.length === 0) {
      const detail = `${stateName} has zero learned patterns`;
      failures.push({
        failure_class: "state_gap",
        signature: stableLearnFailureSignature("state_gap", detail),
        detail,
      });
    }
  }

  // Segments classified with low confidence
  let lowConfCount = 0;
  for (const probe of probes) {
    for (const seg of probe.classified_segments) {
      if (seg.confidence < 0.3) lowConfCount++;
    }
  }
  if (lowConfCount > 0) {
    const detail = `${lowConfCount} segments below 0.3 confidence`;
    failures.push({
      failure_class: "classification_ambiguous",
      signature: stableLearnFailureSignature("classification_ambiguous", detail),
      detail,
    });
  }

  // Probes that produced zero classified segments
  for (const probe of probes) {
    if (probe.classified_segments.length === 0) {
      const detail = `round ${probe.round} strategy ${probe.strategy} produced no segments`;
      failures.push({
        failure_class: "probe_no_output",
        signature: stableLearnFailureSignature("probe_no_output", detail),
        detail,
      });
    }
  }

  // Probes where tool exited with error state
  for (const probe of probes) {
    const hasError = probe.classified_segments.some((s) => s.state === "error");
    if (hasError) {
      const detail = `round ${probe.round} tool produced error state`;
      failures.push({
        failure_class: "tool_crash",
        signature: stableLearnFailureSignature("tool_crash", detail),
        detail,
      });
    }
  }

  // Cross-state patterns (patterns appearing in multiple states = noise)
  const patternStates = new Map<string, Set<string>>();
  for (const pat of profile.learned_patterns) {
    const existing = patternStates.get(pat.pattern) ?? new Set();
    existing.add(pat.classified_as);
    patternStates.set(pat.pattern, existing);
  }
  let noiseCount = 0;
  for (const [, states] of patternStates) {
    if (states.size > 1) noiseCount++;
  }
  if (noiseCount > 2) {
    const detail = `${noiseCount} patterns appear in multiple states`;
    failures.push({
      failure_class: "pattern_noise",
      signature: stableLearnFailureSignature("pattern_noise", detail),
      detail,
    });
  }

  console.log(`[heal-diag] Found ${failures.length} failure(s):`);
  for (const f of failures) {
    console.log(`[heal-diag]   [${f.failure_class}] ${f.detail} (sig: ${f.signature})`);
  }
  return failures;
}

// ---- Healing ----

export interface HealerContext {
  profile: ToolProfile;
  completedProbes: ProbeResult[];
  confidenceHistory: number[];
  failureSignatures: string[];
  diagnosticLines?: string;
  config: {
    settle_timeout_ms: number;
    max_probe_session_ms: number;
  };
}

/**
 * Diagnose and heal learning failures.
 * With LLM: send context to healer model, parse structured decision.
 * Without LLM: deterministic heuristic healing.
 */
export async function heal(
  ctx: HealerContext,
  llmClient: LLMClient | null,
): Promise<LearnHealDecision> {
  console.log(`[heal] Heal invoked. Signatures: ${ctx.failureSignatures.length}, conf history: [${ctx.confidenceHistory.map(c => (c*100).toFixed(1)+'%').join(', ')}]`);
  console.log(`[heal] Config: settle=${ctx.config.settle_timeout_ms}ms, maxProbe=${ctx.config.max_probe_session_ms}ms`);
  if (ctx.diagnosticLines) {
    console.log(`[heal] Diagnostic lines (first 300): ${ctx.diagnosticLines.substring(0, 300).replace(/\n/g, '\\n')}`);
  }

  if (llmClient && !llmClient.exhausted) {
    console.log(`[heal] Attempting LLM-based healing...`);
    try {
      const prompt = buildLearnHealerPrompt(ctx);
      console.log(`[heal]   Prompt lengths: system=${prompt.system.length}, user=${prompt.user.length}`);
      const raw = await llmClient.complete(prompt.system, prompt.user);
      console.log(`[heal]   LLM response: ${raw.length} chars`);
      console.log(`[heal]   LLM raw (first 400): ${raw.substring(0, 400).replace(/\n/g, '\\n')}`);
      const parsed = parseLearnHealDecision(raw);
      if (parsed) {
        console.log(`[heal]   LLM decision: ${parsed.decision} (${parsed.failure_class}), ${parsed.patches.length} patches, ${parsed.suggested_probes?.length ?? 0} suggested probes`);
        console.log(`[heal]   Root cause: ${parsed.root_cause}`);
        for (const p of parsed.patches) {
          console.log(`[heal]   Patch: target=${p.target}, op=${p.operation}, content=${p.content.substring(0, 100)}`);
        }
        return parsed;
      }
      console.log(`[heal]   LLM parse returned null -- falling through to deterministic`);
    } catch (e) {
      console.log(`[heal]   LLM heal failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log(`[heal] LLM ${!llmClient ? 'unavailable' : 'exhausted'} -- using deterministic healing`);
  }

  const result = deterministicHeal(ctx);
  console.log(`[heal] Deterministic result: ${result.decision} (${result.failure_class}), ${result.patches.length} patches`);
  console.log(`[heal] Root cause: ${result.root_cause}`);
  if (result.suggested_probes) {
    for (const sp of result.suggested_probes) {
      console.log(`[heal]   Suggested probe: ${sp.strategy}${sp.input_text ? ` "${sp.input_text}"` : ''} -- ${sp.rationale}`);
    }
  }
  return result;
}

function deterministicHeal(ctx: HealerContext): LearnHealDecision {
  const diagnosis = diagnoseLearnFailures(ctx.completedProbes, ctx.profile);
  if (diagnosis.length === 0) {
    return {
      decision: "ACCEPT_PARTIAL",
      failure_class: "convergence_plateau",
      root_cause: "No specific failures identified but confidence is not improving",
      patches: [],
    };
  }

  // Prioritize: state_gap > classification_ambiguous > probe_no_output > others
  const stateGaps = diagnosis.filter((d) => d.failure_class === "state_gap");
  if (stateGaps.length > 0) {
    const emptyStates = stateGaps.map((d) => d.detail.split(" ")[0]);

    // Build targeted probes for each empty state.
    // Key insight: "prompting" in interactive CLI tools requires side-effect input
    // that triggers a permission gate (file write, shell command, etc).
    // A generic "prompt_response" that sends ctrl-c will never surface it.
    const suggestedProbes: LearnHealDecision["suggested_probes"] = [];
    for (const s of emptyStates) {
      suggestedProbes.push(probeForState(s as ToolState, ctx.profile));
    }

    return {
      decision: "RETRY",
      failure_class: "state_gap",
      root_cause: `States [${emptyStates.join(", ")}] have no learned patterns`,
      patches: [],
      suggested_probes: suggestedProbes,
    };
  }

  const ambiguous = diagnosis.find((d) => d.failure_class === "classification_ambiguous");
  if (ambiguous) {
    const newTimeout = Math.round(ctx.config.settle_timeout_ms * 1.5);
    return {
      decision: "RETRY",
      failure_class: "classification_ambiguous",
      root_cause: ambiguous.detail,
      patches: [{
        target: "timing_knob",
        operation: "replace",
        content: JSON.stringify({ settle_timeout_ms: newTimeout }),
      }],
    };
  }

  const noOutput = diagnosis.find((d) => d.failure_class === "probe_no_output");
  if (noOutput) {
    const subcommands = ctx.profile.discovery?.subcommands ?? [];
    const suggestedProbes: LearnHealDecision["suggested_probes"] = subcommands.length > 0
      ? [{
          strategy: "custom" as ProbeStrategy,
          input_text: subcommands[0].name,
          rationale: `Try discovered subcommand "${subcommands[0].name}"`,
        }]
      : [{
          strategy: "input" as ProbeStrategy,
          input_text: "help",
          rationale: "Try sending help as input",
        }];

    return {
      decision: "RETRY",
      failure_class: "probe_no_output",
      root_cause: noOutput.detail,
      patches: [],
      suggested_probes: suggestedProbes,
    };
  }

  // Default: convergence plateau after we've tried other things
  return {
    decision: "STOP",
    failure_class: "convergence_plateau",
    root_cause: "Learning is not converging despite healing attempts",
    patches: [],
  };
}

/**
 * Generate a targeted probe for a missing state.
 * Uses discovery info (subcommands, flags) to construct realistic payloads.
 */
function probeForState(
  state: ToolState,
  profile: ToolProfile,
): NonNullable<LearnHealDecision["suggested_probes"]>[number] {
  switch (state) {
    case "ready":
      return {
        strategy: "enter",
        rationale: `Target state "ready" -- send enter to observe idle-to-ready transition`,
      };

    case "working":
      return {
        strategy: "input",
        input_text: "read the file package.json",
        rationale: `Target state "working" -- read-only command to trigger tool execution output`,
      };

    case "thinking":
      return {
        strategy: "input",
        input_text: "what is 2 + 2",
        rationale: `Target state "thinking" -- simple question to trigger reasoning phase`,
      };

    case "prompting": {
      // Prompting requires a side-effect action that triggers a permission gate.
      // Interactive CLI tools (like Claude Code) ask for approval before writes/shell commands.
      // Use the "side_effect" strategy which sends a command, waits for the permission
      // prompt, responds affirmatively, and verifies completion.
      return {
        strategy: "custom",
        input_text: "create a file called /tmp/clr-probe-test.txt with the text 'hello from probe'",
        rationale: `Target state "prompting" -- side-effect command to trigger permission prompt (file write requires approval)`,
      };
    }

    default:
      return {
        strategy: "observe",
        rationale: `Target state "${state}" -- passive observation`,
      };
  }
}

// ---- Patch Application ----

/**
 * Apply healer patches to a profile. Returns a new profile (no mutation).
 * Patches are bounded: max 3 pattern additions, timing capped at 2x original.
 */
export function applyHealPatches(
  profile: ToolProfile,
  decision: LearnHealDecision,
  originalConfig?: { settle_timeout_ms: number; max_probe_session_ms: number },
): { profile: ToolProfile; configOverrides: Record<string, number> } {
  console.log(`[heal-patch] Applying ${decision.patches.length} patches (original settle=${originalConfig?.settle_timeout_ms}ms, maxProbe=${originalConfig?.max_probe_session_ms}ms)`);
  const updated = structuredClone(profile);
  const configOverrides: Record<string, number> = {};
  let patternsAdded = 0;

  for (const patch of decision.patches) {
    switch (patch.target) {
      case "classification_hint": {
        if (patternsAdded >= MAX_PATTERNS_PER_HEAL) break;
        try {
          const hint = JSON.parse(patch.content) as { state: string; pattern: string };
          if (
            hint.state in updated.states &&
            hint.pattern &&
            hint.pattern.length <= MAX_PATTERN_LENGTH
          ) {
            const stateDef = updated.states[hint.state];
            const alreadyExists = stateDef.indicators.some(
              (ind) => ind.type === "output_glob" && ind.pattern === hint.pattern,
            );
            if (!alreadyExists) {
              stateDef.indicators.push({
                type: "output_glob",
                pattern: hint.pattern,
              });
              patternsAdded++;
            }
          }
        } catch {
          // invalid patch content, skip
        }
        break;
      }

      case "timing_knob": {
        try {
          const knobs = JSON.parse(patch.content) as Record<string, number>;
          for (const [key, value] of Object.entries(knobs)) {
            if (key === "settle_timeout_ms" || key === "max_probe_session_ms") {
              const original = originalConfig?.[key] ?? value;
              const capped = Math.min(value, original * TIMING_CAP_MULTIPLIER);
              configOverrides[key] = capped;
            }
          }
        } catch {
          // invalid patch content, skip
        }
        break;
      }

      case "profile_state": {
        try {
          const stateUpdate = JSON.parse(patch.content) as { state: string; description: string };
          if (stateUpdate.state in updated.states && stateUpdate.description) {
            updated.states[stateUpdate.state].description = stateUpdate.description;
          }
        } catch {
          // invalid patch content, skip
        }
        break;
      }

      // probe_strategy patches are consumed via decision.suggested_probes, not applied to profile
      case "probe_strategy":
        break;
    }
  }

  return { profile: updated, configOverrides };
}
