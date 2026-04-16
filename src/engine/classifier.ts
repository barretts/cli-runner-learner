import type { TranscriptSegment, ClassifiedSegment, ToolState, ToolProfile } from "../types.js";
import { globMatch } from "../term-utils.js";
import type { LLMClient } from "../llm/client.js";
import { buildClassifierPrompt, buildSubPromptAnalysisPrompt } from "../llm/prompts.js";
import { parseClassification, parseSubPromptAnalysis } from "../llm/parsers.js";
import type { ParsedSubPrompt } from "../llm/parsers.js";

/**
 * Prompt-like patterns -- y/n prompts, confirmation dialogs, explicit prompts.
 * Intentionally avoids bare `\?\s*$` and `:\s*$` which are too greedy
 * (match echoed user input in TUI tools, status bar text, etc.)
 */
const PROMPT_PATTERNS = [
  /^.{0,80}\?\s*$/m,     // short line ending with ? (likely a prompt, not long output)
  /\(y\/n\)/i,
  /\(Y\/N\)/,
  /\[y\/N\]/,
  /\[Y\/n\]/,
  /Yes\s*$/m,
  /Allow/i,
  /Approve/i,
  /MCP Server Approval/i,
  /Press.*to continue/i,
  /Press.*again/i,
  /Are you sure/i,
  /Yep!\s*Nope/i,
];

const THINKING_PATTERNS = [
  /\(thinking\)/i,
  /thinking\.\.\./i,
  /Working\.\.\./,
  /Processing\.\.\./,
  /Brrr+\.\.\./,
  /Prrr+\.\.\./,
  /Slithering\.\.\./,
  /Germinating\.\.\./,
  /Churning\.\.\./,
  /Pondering\.\.\./,
  /Reasoning\.\.\./,
  /Analyzing\.\.\./,
  /\bSlithering\b(?=\s*$)/m,
  /\bGerminating\b(?=\s*$)/m,
  /\bChurning\b(?=\s*$)/m,
  /\bPondering\b(?=\s*$)/m,
];

const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bpanic\b/i,
  /\bfatal\b/i,
  /ENOENT/,
  /EACCES/,
  /EPERM/,
  /segmentation fault/i,
  /stack overflow/i,
];

interface ClassifyContext {
  segmentIndex: number;
  totalSegments: number;
  isFirstSegment: boolean;
  isLastSegment: boolean;
  prevState?: ToolState;
  hasExitEvent: boolean;
}

/**
 * Classify transcript segments into tool states using heuristic rules.
 * When a profile exists, its state indicators take priority.
 * When an LLM client is provided, ambiguous classifications (confidence < 0.3)
 * are sent to the LLM for a second opinion.
 */
export async function classifySegments(
  segments: TranscriptSegment[],
  profile?: ToolProfile,
  llmClient?: LLMClient | null,
): Promise<ClassifiedSegment[]> {
  console.log(`[classify] Classifying ${segments.length} segments, profile=${profile ? profile.tool_id : 'none'}, LLM=${!!llmClient}`);
  if (profile) {
    const indicatorCounts = Object.entries(profile.states).map(([s, d]) => `${s}:${d.indicators.length}`).join(', ');
    console.log(`[classify] Profile indicators: ${indicatorCounts}`);
    console.log(`[classify] Profile learned patterns: ${profile.learned_patterns.length}`);
  }

  const results: ClassifiedSegment[] = [];
  const hasExit = segments.some((s) =>
    s.events.some((e) => e.type === "meta" && e.event === "exit"),
  );
  console.log(`[classify] Has exit event: ${hasExit}`);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const duration = seg.end_ts - seg.start_ts;
    const recvCount = seg.events.filter(e => e.type === "recv").length;
    const metaEvents = seg.events.filter(e => e.type === "meta").map(e => e.event).join(',');
    const textPreview = seg.stripped_text.substring(0, 100).replace(/\n/g, '\\n');
    console.log(`[classify] --- Segment ${i}/${segments.length} ---`);
    console.log(`[classify]   Duration: ${duration}ms, ${seg.events.length} events (${recvCount} recv), text: ${seg.stripped_text.length} chars`);
    console.log(`[classify]   Meta events: ${metaEvents || 'none'}`);
    console.log(`[classify]   Text preview: "${textPreview}"`);

    const ctx: ClassifyContext = {
      segmentIndex: i,
      totalSegments: segments.length,
      isFirstSegment: i === 0,
      isLastSegment: i === segments.length - 1,
      prevState: i > 0 ? results[i - 1].state : undefined,
      hasExitEvent: hasExit,
    };
    console.log(`[classify]   Context: first=${ctx.isFirstSegment}, last=${ctx.isLastSegment}, prev=${ctx.prevState ?? 'none'}`);

    let [state, confidence, reason] = classifyOne(seg, ctx, profile);
    console.log(`[classify]   Heuristic result: ${state} (${(confidence * 100).toFixed(0)}%) -- ${reason}`);

    // LLM fallback for ambiguous classifications (skip for tiny segments — no useful text)
    if (confidence < 0.3 && seg.stripped_text.length >= 5 && llmClient && !llmClient.exhausted && profile) {
      console.log(`[classify]   Low confidence (${(confidence*100).toFixed(0)}% < 30%) -- trying LLM fallback`);
      try {
        const prompt = buildClassifierPrompt(seg.stripped_text, profile.states, {
          segmentIndex: i,
          totalSegments: segments.length,
          prevState: ctx.prevState,
        });
        console.log(`[classify]   LLM prompt lengths: system=${prompt.system.length}, user=${prompt.user.length}`);
        const raw = await llmClient.complete(prompt.system, prompt.user);
        console.log(`[classify]   LLM response: ${raw.length} chars`);
        const parsed = parseClassification(raw);
        if (parsed && parsed.confidence > confidence) {
          console.log(`[classify]   LLM override: ${state} -> ${parsed.state} (${(parsed.confidence*100).toFixed(0)}%) -- ${parsed.reason}`);
          state = parsed.state;
          confidence = parsed.confidence;
          reason = `LLM: ${parsed.reason}`;
        } else {
          console.log(`[classify]   LLM result not better: ${parsed ? `${parsed.state} (${(parsed.confidence*100).toFixed(0)}%)` : 'parse failed'}`);
        }
      } catch (e) {
        console.log(`[classify]   LLM fallback failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // When classified as prompting, try to extract sub-prompt details via LLM
    let detectedSubPrompt: ParsedSubPrompt | undefined;
    if (state === "prompting" && llmClient && !llmClient.exhausted) {
      console.log(`[classify]   Prompting state detected -- analyzing sub-prompt via LLM`);
      try {
        const spPrompt = buildSubPromptAnalysisPrompt(seg.stripped_text);
        const spRaw = await llmClient.complete(spPrompt.system, spPrompt.user);
        const spParsed = parseSubPromptAnalysis(spRaw);
        if (spParsed && spParsed.confidence >= 0.5) {
          detectedSubPrompt = spParsed;
          console.log(`[classify]   Sub-prompt: type=${spParsed.prompt_type}, response="${spParsed.suggested_response}", conf=${(spParsed.confidence*100).toFixed(0)}%`);
        } else {
          console.log(`[classify]   Sub-prompt analysis: ${spParsed ? `low confidence (${(spParsed.confidence*100).toFixed(0)}%)` : 'parse failed'}`);
        }
      } catch (e) {
        console.log(`[classify]   Sub-prompt LLM failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // For ready segments with empty text, carry forward the tail of the previous
    // segment's text. In TUI tools, the settle event has no recv data — but the
    // screen was showing the prompt/status from the previous render frame.
    let effectiveText = seg.stripped_text;
    if (state === "ready" && effectiveText.length < 5 && i > 0) {
      const prevText = segments[i - 1].stripped_text;
      if (prevText.length > 0) {
        const lines = prevText.split("\n").filter(l => l.trim().length > 0);
        effectiveText = lines.slice(-5).join("\n");
        console.log(`[classify]   Ready text carry-forward: ${effectiveText.length} chars from prev segment tail`);
      }
    }

    console.log(`[classify]   FINAL: ${state} (${(confidence * 100).toFixed(0)}%) -- ${reason}`);
    results.push({
      ...seg,
      stripped_text: effectiveText,
      state,
      confidence,
      reason,
      detectedSubPrompt,
    });
  }

  // Post-processing: bidirectional thinking↔working split.
  // TUI tools re-render the full screen each frame, so thinking labels persist
  // while response content streams. A single segment often contains BOTH
  // thinking indicators AND working content.
  //
  // - thinking segment (long) → also emit parallel working segment
  // - working segment with thinking label → also emit parallel thinking segment
  //
  // Pattern extraction sees both tags and pulls state-specific n-grams from each.
  const postProcessed: ClassifiedSegment[] = [];
  let thinkingToWorking = 0;
  let workingToThinking = 0;
  for (const seg of results) {
    postProcessed.push(seg);

    if (seg.state === "thinking") {
      const duration = seg.end_ts - seg.start_ts;
      if (duration > 3000 && seg.stripped_text.length > 100) {
        postProcessed.push({
          ...seg,
          state: "working",
          confidence: 0.5,
          reason: "parallel working: long thinking segment likely contains response output",
        });
        thinkingToWorking++;
      }
    } else if (seg.state === "working") {
      const hasThinkingLabel = THINKING_PATTERNS.some((pat) => pat.test(seg.stripped_text));
      if (hasThinkingLabel) {
        postProcessed.push({
          ...seg,
          state: "thinking",
          confidence: 0.5,
          reason: "parallel thinking: working segment contains thinking label",
        });
        workingToThinking++;
      }
    }
  }

  if (thinkingToWorking > 0 || workingToThinking > 0) {
    console.log(`[classify] Post-processing: thinking→working: ${thinkingToWorking}, working→thinking: ${workingToThinking}`);
  }

  // Summary
  const stateCounts: Record<string, number> = {};
  for (const seg of postProcessed) {
    stateCounts[seg.state] = (stateCounts[seg.state] ?? 0) + 1;
  }
  console.log(`[classify] Result: ${postProcessed.length} segments -- ${Object.entries(stateCounts).map(([s, c]) => `${s}:${c}`).join(', ')}`);

  return postProcessed;
}

function classifyOne(
  seg: TranscriptSegment,
  ctx: ClassifyContext,
  profile?: ToolProfile,
): [ToolState, number, string] {
  const text = seg.stripped_text;
  const duration = seg.end_ts - seg.start_ts;
  const recvEvents = seg.events.filter((e) => e.type === "recv");
  const hasSendEvents = seg.events.some((e) => e.type === "send");
  const hasSettled = seg.events.some((e) => e.type === "meta" && e.event === "settled");
  const hasExit = seg.events.some((e) => e.type === "meta" && e.event === "exit");

  // 1. Structural events (exit, ctrl-c) — these are unambiguous
  if (hasExit) {
    return ["completed", 0.95, "process exited"];
  }
  // Last segment with sends: check for prompt text first (e.g. quit confirmation
  // dialog appears in the same segment as the ctrl-c send)
  if (hasSendEvents && ctx.isLastSegment) {
    for (const pat of PROMPT_PATTERNS) {
      if (pat.test(text)) {
        return ["prompting", 0.7, `prompt in final segment: ${pat.source}`];
      }
    }
    return ["completed", 0.7, "send events in final segment"];
  }

  // 2. Thinking patterns — check BEFORE profile indicators.
  // "Thinking..." is a strong signal that should override learned working/ready
  // indicators when both appear in the same text (common in TUI tools that
  // re-render the whole screen including chrome while thinking).
  for (const pat of THINKING_PATTERNS) {
    if (pat.test(text)) {
      return ["thinking", 0.75, `matched thinking pattern: ${pat.source}`];
    }
  }

  // 3. Profile-based classification
  if (profile) {
    const profileMatch = matchProfileIndicators(text, profile);
    if (profileMatch) return profileMatch;
  }

  // 4. Error patterns
  for (const pat of ERROR_PATTERNS) {
    if (pat.test(text)) {
      return ["error", 0.6, `matched error pattern: ${pat.source}`];
    }
  }

  // 6. First segment with no sends -> startup
  if (ctx.isFirstSegment && !hasSendEvents) {
    if (hasSettled) {
      return ["ready", 0.6, "first segment settled (tool showing prompt)"];
    }
    return ["startup", 0.7, "first segment, no input sent"];
  }

  // 6.5. Settle with minimal text after active state -> ready
  // Interactive tools show output then go silent at the prompt.
  // After settle-based splitting, this produces a segment with the settle event
  // and little/no visible text.
  const activeStates: ToolState[] = ["startup", "working", "thinking", "prompting"];
  if (hasSettled && !hasSendEvents && text.length < 20 && ctx.prevState && activeStates.includes(ctx.prevState)) {
    return ["ready", 0.6, `settled after ${ctx.prevState} with minimal output`];
  }

  // 7. High output rate / many events -> working
  // Check BEFORE prompt patterns: TUI animation frames produce high event counts
  // and may contain prompt-like text (echoed user input ending in ?)
  if (recvEvents.length > 0 && duration > 0) {
    const charsPerSec = (text.length / duration) * 1000;
    if (charsPerSec > 10 && text.length > 50) {
      return ["working", 0.55, `high output rate: ${charsPerSec.toFixed(0)} chars/s`];
    }
    // Many rapid recv events (TUI re-rendering) even if stripped text is moderate
    if (recvEvents.length > 20 && duration > 1000) {
      return ["working", 0.5, `many recv events: ${recvEvents.length} in ${(duration/1000).toFixed(1)}s`];
    }
  }

  // 8. Prompt patterns
  for (const pat of PROMPT_PATTERNS) {
    if (pat.test(text)) {
      return ["prompting", 0.65, `matched prompt pattern: ${pat.source}`];
    }
  }

  // 9. Settled after output -> ready
  if (hasSettled && recvEvents.length > 0) {
    return ["ready", 0.5, "settled after output"];
  }

  // 10. Default
  return ["unknown", 0.1, "no matching heuristic"];
}

/**
 * Compute specificity of a glob pattern: longer patterns with fewer wildcards
 * are more specific and should take priority in matching.
 */
function patternSpecificity(pattern: string): number {
  const wildcardCount = (pattern.match(/\*/g) || []).length;
  return pattern.length - wildcardCount * 5;
}

/**
 * Try to match segment text against profile state indicators.
 * Collects ALL matches and returns the most specific one (longest pattern
 * minus wildcards) so that e.g. "*Are you sure you want to quit*" beats
 * "*ctrl+c quit*" when both match the same text.
 */
function matchProfileIndicators(
  text: string,
  profile: ToolProfile,
): [ToolState, number, string] | null {
  let checkedCount = 0;
  const matches: Array<{ state: ToolState; confidence: number; reason: string; specificity: number }> = [];
  const lines = text.split("\n");

  for (const [stateName, stateDef] of Object.entries(profile.states)) {
    for (const indicator of stateDef.indicators) {
      if (indicator.type === "output_glob" && indicator.pattern) {
        checkedCount++;
        const spec = patternSpecificity(indicator.pattern);

        if (globMatch(indicator.pattern, text, indicator.case_insensitive)) {
          matches.push({
            state: stateName as ToolState,
            confidence: 0.85,
            reason: `profile glob: ${indicator.pattern}`,
            specificity: spec,
          });
          continue;
        }
        for (const line of lines) {
          if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
            matches.push({
              state: stateName as ToolState,
              confidence: 0.8,
              reason: `profile glob (line): ${indicator.pattern}`,
              specificity: spec,
            });
            break;
          }
        }
      }
    }

    // Check sub-prompts
    if (stateDef.sub_prompts) {
      for (const sp of stateDef.sub_prompts) {
        for (const indicator of sp.indicators) {
          if (indicator.type === "output_glob" && indicator.pattern) {
            checkedCount++;
            const spec = patternSpecificity(indicator.pattern);
            for (const line of lines) {
              if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
                matches.push({
                  state: "prompting",
                  confidence: 0.85,
                  reason: `profile sub-prompt ${sp.id}: ${indicator.pattern}`,
                  specificity: spec,
                });
                break;
              }
            }
          }
        }
      }
    }
  }

  if (matches.length === 0) {
    if (checkedCount > 0) {
      console.log(`[classify]   Profile indicators: checked ${checkedCount} globs, no match`);
    }
    return null;
  }

  // Sort by specificity (most specific first) then by confidence
  matches.sort((a, b) => b.specificity - a.specificity || b.confidence - a.confidence);
  const best = matches[0];
  console.log(`[classify]   Profile match: ${best.state} via ${best.reason} (specificity=${best.specificity}, ${matches.length} total matches)`);
  return [best.state, best.confidence, best.reason];
}

/**
 * Extract unique text fragments from classified segments for a given state.
 * Returns de-duplicated lines that appeared in segments of that state.
 */
export function extractTextForState(
  classified: ClassifiedSegment[],
  state: ToolState,
): string[] {
  const lines = new Set<string>();

  for (const seg of classified) {
    if (seg.state !== state) continue;
    for (const line of seg.stripped_text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 3) {
        lines.add(trimmed);
      }
    }
  }

  return [...lines];
}
