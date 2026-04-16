import type { TranscriptSegment, ClassifiedSegment, ToolState, ToolProfile } from "../types.js";
import { globMatch } from "../term-utils.js";

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
 */
export function classifySegments(
  segments: TranscriptSegment[],
  profile?: ToolProfile,
): ClassifiedSegment[] {
  const results: ClassifiedSegment[] = [];
  const hasExit = segments.some((s) =>
    s.events.some((e) => e.type === "meta" && e.event === "exit"),
  );

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const ctx: ClassifyContext = {
      segmentIndex: i,
      totalSegments: segments.length,
      isFirstSegment: i === 0,
      isLastSegment: i === segments.length - 1,
      prevState: i > 0 ? results[i - 1].state : undefined,
      hasExitEvent: hasExit,
    };

    const [state, confidence, reason] = classifyOne(seg, ctx, profile);

    results.push({
      ...seg,
      state,
      confidence,
      reason,
    });
  }

  return results;
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
  for (const [stateName, stateDef] of Object.entries(profile.states)) {
    for (const indicator of stateDef.indicators) {
      if (indicator.type === "output_glob" && indicator.pattern) {
        if (globMatch(indicator.pattern, text, indicator.case_insensitive)) {
          return [stateName as ToolState, 0.85, `profile glob: ${indicator.pattern}`];
        }
        // Also check if the pattern appears anywhere in the text (substring glob match)
        for (const line of text.split("\n")) {
          if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
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
            for (const line of text.split("\n")) {
              if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
                return ["prompting", 0.85, `profile sub-prompt ${sp.id}: ${indicator.pattern}`];
              }
            }
          }
        }
      }
    }
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
