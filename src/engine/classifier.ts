import type { TranscriptSegment, ClassifiedSegment, ToolState, ToolProfile } from "../types.js";
import { globMatch } from "../term-utils.js";
import type { LLMClient } from "../llm/client.js";
import { buildClassifierPrompt, buildSubPromptAnalysisPrompt } from "../llm/prompts.js";
import { parseClassification, parseSubPromptAnalysis } from "../llm/parsers.js";
import type { ParsedSubPrompt } from "../llm/parsers.js";

/**
 * Prompt-like patterns -- lines ending with question marks, colons,
 * y/n prompts, numbered option lists, etc.
 */
const PROMPT_PATTERNS = [
  /\?\s*$/m,
  /:\s*$/m,
  /\(y\/n\)/i,
  /\(Y\/N\)/,
  /\[y\/N\]/,
  /\[Y\/n\]/,
  /^\s*\d+[\.\)]\s+/m,   // numbered list (option selection)
  /Yes\s*$/m,
  /Allow/i,
  /Approve/i,
  /MCP Server Approval/i,
  /Press.*to continue/i,
  /Press.*again/i,
];

const THINKING_PATTERNS = [
  /\(thinking\)/i,
  /thinking\.\.\./i,
  /Slithering/,
  /Germinating/,
  /Churning/,
  /Pondering/,
  /Reasoning/,
  /Analyzing/,
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

    // LLM fallback for ambiguous classifications
    if (confidence < 0.3 && llmClient && !llmClient.exhausted && profile) {
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

    console.log(`[classify]   FINAL: ${state} (${(confidence * 100).toFixed(0)}%) -- ${reason}`);
    results.push({
      ...seg,
      state,
      confidence,
      reason,
      detectedSubPrompt,
    });
  }

  // Post-processing: long THINKING segments in TUI tools typically contain both
  // spinner output AND response/tool-use output. The TUI re-renders the full
  // screen each frame, so `(thinking)` persists in every frame even after the
  // response starts streaming. Event-level splitting fails because thinking
  // patterns appear in nearly every frame.
  //
  // Instead, emit a parallel WORKING segment from the same text when the segment
  // is long enough to contain response content. Pattern extraction will pull
  // different n-grams for each state (thinking patterns vs. response content).
  const postProcessed: ClassifiedSegment[] = [];
  let thinkingSplitCount = 0;
  for (const seg of results) {
    if (seg.state !== "thinking") {
      postProcessed.push(seg);
      continue;
    }

    const duration = seg.end_ts - seg.start_ts;
    if (duration > 3000 && seg.stripped_text.length > 100) {
      // Keep the thinking classification
      postProcessed.push(seg);
      // Emit a parallel working segment for pattern extraction
      postProcessed.push({
        ...seg,
        state: "working",
        confidence: 0.5,
        reason: "parallel working: long thinking segment likely contains response output",
      });
      thinkingSplitCount++;
    } else {
      postProcessed.push(seg);
    }
  }

  if (thinkingSplitCount > 0) {
    console.log(`[classify] Post-processing: split ${thinkingSplitCount} long thinking segments into thinking+working pairs`);
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

  // 1. Profile-based classification (highest priority)
  if (profile) {
    const profileMatch = matchProfileIndicators(text, profile);
    if (profileMatch) return profileMatch;
  }

  // 2. Exit event -> completed
  if (hasExit) {
    return ["completed", 0.95, "process exited"];
  }

  // 3. Contains our ctrl-c send -> transition segment, classify based on context
  if (hasSendEvents && ctx.isLastSegment) {
    return ["completed", 0.7, "send events in final segment"];
  }

  // 4. Error patterns
  for (const pat of ERROR_PATTERNS) {
    if (pat.test(text)) {
      return ["error", 0.6, `matched error pattern: ${pat.source}`];
    }
  }

  // 5. Thinking patterns (check before startup/prompt -- thinking contains question-mark-like artifacts)
  for (const pat of THINKING_PATTERNS) {
    if (pat.test(text)) {
      return ["thinking", 0.75, `matched thinking pattern: ${pat.source}`];
    }
  }

  // 6. First segment with no sends -> startup
  if (ctx.isFirstSegment && !hasSendEvents) {
    if (hasSettled) {
      return ["ready", 0.6, "first segment settled (tool showing prompt)"];
    }
    return ["startup", 0.7, "first segment, no input sent"];
  }

  // 6.5. Settle with minimal text after startup -> ready
  // Interactive tools like Claude show a startup banner then go silent at the prompt.
  // After settle-based splitting (transcript.ts step 4), this produces a segment
  // with the settle event and little/no visible text.
  if (hasSettled && !hasSendEvents && text.length < 20 && ctx.prevState === "startup") {
    return ["ready", 0.65, "settled after startup with minimal output"];
  }

  // 7. Prompt patterns
  for (const pat of PROMPT_PATTERNS) {
    if (pat.test(text)) {
      return ["prompting", 0.65, `matched prompt pattern: ${pat.source}`];
    }
  }

  // 8. High output rate -> working
  if (recvEvents.length > 0 && duration > 0) {
    const charsPerSec = (text.length / duration) * 1000;
    if (charsPerSec > 10 && text.length > 50) {
      return ["working", 0.55, `high output rate: ${charsPerSec.toFixed(0)} chars/s`];
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
 * Try to match segment text against profile state indicators.
 */
function matchProfileIndicators(
  text: string,
  profile: ToolProfile,
): [ToolState, number, string] | null {
  let checkedCount = 0;
  for (const [stateName, stateDef] of Object.entries(profile.states)) {
    for (const indicator of stateDef.indicators) {
      if (indicator.type === "output_glob" && indicator.pattern) {
        checkedCount++;
        if (globMatch(indicator.pattern, text, indicator.case_insensitive)) {
          console.log(`[classify]   Profile match: ${stateName} via full-text glob "${indicator.pattern}"`);
          return [stateName as ToolState, 0.85, `profile glob: ${indicator.pattern}`];
        }
        // Also check if the pattern appears anywhere in the text (substring glob match)
        for (const line of text.split("\n")) {
          if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
            console.log(`[classify]   Profile match: ${stateName} via line glob "${indicator.pattern}" on line "${line.trim().substring(0, 60)}"`);
            return [stateName as ToolState, 0.8, `profile glob (line): ${indicator.pattern}`];
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
            for (const line of text.split("\n")) {
              if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
                console.log(`[classify]   Profile sub-prompt match: ${sp.id} via "${indicator.pattern}"`);
                return ["prompting", 0.85, `profile sub-prompt ${sp.id}: ${indicator.pattern}`];
              }
            }
          }
        }
      }
    }
  }

  if (checkedCount > 0) {
    console.log(`[classify]   Profile indicators: checked ${checkedCount} globs, no match`);
  }
  return null;
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
