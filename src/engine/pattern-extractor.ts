import type { ClassifiedSegment, ToolState, LearnedPattern } from "../types.js";

const MAX_PATTERN_LENGTH = 60;

interface PatternCandidate {
  pattern: string;
  state: ToolState;
  occurrences: number;
  source_transcripts: Set<string>;
  all_states: Set<string>;  // track cross-state appearance for uniqueness scoring
  confidence: number;
}

/**
 * Extract stable patterns from classified segments across multiple probe runs.
 * Finds repeated text fragments that consistently appear in the same state.
 */
export function extractPatterns(
  classifiedRuns: Array<{
    transcript_path: string;
    segments: ClassifiedSegment[];
  }>,
): LearnedPattern[] {
  console.log(`[extract] Extracting patterns from ${classifiedRuns.length} runs`);

  // Phase 1: collect all fragments with their state associations
  const candidates = new Map<string, PatternCandidate>();
  let totalFragments = 0;
  let skippedUnknown = 0;
  let skippedLowConf = 0;

  for (const run of classifiedRuns) {
    let runFragments = 0;
    for (const seg of run.segments) {
      if (seg.state === "unknown" || seg.state === "completed") { skippedUnknown++; continue; }
      if (seg.confidence < 0.4) { skippedLowConf++; continue; }

      const fragments = extractFragments(seg.stripped_text);
      runFragments += fragments.length;

      for (const frag of fragments) {
        const key = `${seg.state}::${frag}`;
        const existing = candidates.get(key);

        if (existing) {
          existing.occurrences++;
          existing.source_transcripts.add(run.transcript_path);
        } else {
          candidates.set(key, {
            pattern: frag,
            state: seg.state,
            occurrences: 1,
            source_transcripts: new Set([run.transcript_path]),
            all_states: new Set([seg.state]),
            confidence: 0,
          });
        }

        // Track cross-state appearance (same fragment, different state)
        for (const [otherKey, otherCand] of candidates) {
          if (otherKey !== key && otherCand.pattern === frag) {
            otherCand.all_states.add(seg.state);
            const c = candidates.get(key);
            if (c) c.all_states.add(otherCand.state);
          }
        }
      }
    }
    totalFragments += runFragments;
    console.log(`[extract]   Run ${run.transcript_path.split('/').pop()}: ${runFragments} fragments from ${run.segments.length} segments`);
  }
  console.log(`[extract] Phase 1: ${candidates.size} unique candidates from ${totalFragments} total fragments (skipped: ${skippedUnknown} unknown/completed, ${skippedLowConf} low-conf)`);

  // Phase 2: Score candidates
  const totalRuns = classifiedRuns.length;
  const results: LearnedPattern[] = [];
  let belowThreshold = 0;
  let tooShort = 0;
  let rejectedEntropy = 0;
  let rejectedChrome = 0;

  for (const candidate of candidates.values()) {
    if (candidate.pattern.length < 5) { tooShort++; continue; }

    // Hard-reject: high-entropy fragments (random animation text)
    if (looksRandom(candidate.pattern)) { rejectedEntropy++; continue; }

    // Hard-reject: patterns in 3+ states are persistent TUI chrome (status bar, shortcuts)
    if (candidate.all_states.size >= 3) { rejectedChrome++; continue; }

    // Run coverage: fraction of runs containing this pattern
    const runCoverage = candidate.source_transcripts.size / totalRuns;

    // Frequency score
    const freqScore = Math.min(candidate.occurrences / totalRuns, 1);

    // Uniqueness: penalize patterns appearing in multiple states (1/N² instead of 1/N).
    // Exception: working↔thinking are treated as a single group since TUI tools
    // re-render the full screen during both states (same chrome, same content).
    const effectiveStates = new Set(candidate.all_states);
    if (effectiveStates.has("working") && effectiveStates.has("thinking") && effectiveStates.size === 2) {
      effectiveStates.delete("thinking"); // collapse to single group
    }
    const uniqueness = 1 / (effectiveStates.size * effectiveStates.size);

    candidate.confidence = (runCoverage * 0.5 + freqScore * 0.2 + uniqueness * 0.3);

    if (candidate.confidence >= 0.35) {
      const globbed = toGlobPattern(candidate.pattern);
      results.push({
        source_transcript: [...candidate.source_transcripts][0],
        timestamp: new Date().toISOString(),
        pattern: globbed,
        classified_as: candidate.state,
        occurrences: candidate.occurrences,
        confidence: candidate.confidence,
      });
    } else {
      belowThreshold++;
    }
  }

  console.log(`[extract] Phase 2: ${results.length} patterns above threshold, ${belowThreshold} below 0.35, ${tooShort} too short, ${rejectedEntropy} random, ${rejectedChrome} chrome`);

  results.sort((a, b) => b.confidence - a.confidence || b.occurrences - a.occurrences);

  // Limit to top patterns per state (avoid noise)
  const perState = limitPerState(results, 5);
  console.log(`[extract] After per-state limit (5): ${perState.length} patterns`);

  const final = deduplicatePatterns(perState);
  console.log(`[extract] After dedup: ${final.length} patterns`);

  // Log per-state breakdown
  const stateBreakdown: Record<string, number> = {};
  for (const p of final) {
    stateBreakdown[p.classified_as] = (stateBreakdown[p.classified_as] ?? 0) + 1;
  }
  console.log(`[extract] Per-state: ${Object.entries(stateBreakdown).map(([s, c]) => `${s}:${c}`).join(', ')}`);
  for (const p of final) {
    console.log(`[extract]   [${p.classified_as}] "${p.pattern}" conf=${(p.confidence*100).toFixed(0)}% occ=${p.occurrences}`);
  }

  return final;
}

/**
 * Extract meaningful text fragments from stripped text.
 * Uses 2-5 word n-grams. Full lines only if under MAX_PATTERN_LENGTH.
 */
function extractFragments(text: string): string[] {
  const fragments = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length < 5) continue;

    // Full line (if short enough to be a useful pattern)
    if (trimmed.length <= MAX_PATTERN_LENGTH) {
      fragments.add(trimmed);
    }

    // Word-level n-grams (2-5 words)
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    for (let n = 2; n <= Math.min(5, words.length); n++) {
      for (let i = 0; i <= words.length - n; i++) {
        const ngram = words.slice(i, i + n).join(" ");
        if (ngram.length >= 6 && ngram.length <= MAX_PATTERN_LENGTH) {
          fragments.add(ngram);
        }
      }
    }
  }

  return [...fragments];
}

/**
 * Detect random/scrambled text (e.g. animation frames) by checking character entropy.
 * Returns true if the fragment looks random rather than meaningful.
 */
function looksRandom(text: string): boolean {
  if (text.length < 6) return false;

  // High ratio of non-alphanumeric characters (excluding common punctuation)
  const alnumCount = (text.match(/[a-zA-Z0-9 ]/g) || []).length;
  const alnumRatio = alnumCount / text.length;
  if (alnumRatio < 0.4) return true;

  // High unique-character ratio relative to length (scrambled text)
  const uniqueChars = new Set(text).size;
  const uniqueRatio = uniqueChars / text.length;
  // Short fragments with almost all unique chars are likely random
  if (text.length <= 20 && uniqueRatio > 0.85) return true;

  return false;
}

/**
 * Convert a literal string to a glob pattern by replacing variable parts.
 */
function toGlobPattern(text: string): string {
  let pattern = text;

  // Replace version numbers (e.g., v2.1.109, 1.2.3)
  pattern = pattern.replace(/v?\d+\.\d+\.\d+/g, "*");

  // Replace absolute paths
  pattern = pattern.replace(/\/[^\s]+/g, "*");

  // Replace hex sequences (8+ chars)
  pattern = pattern.replace(/[0-9a-f]{8,}/gi, "*");

  // Replace timestamps
  pattern = pattern.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g, "*");

  // Replace UUIDs
  pattern = pattern.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "*");

  // Replace long numeric sequences
  pattern = pattern.replace(/\d{6,}/g, "*");

  // Collapse multiple consecutive *
  pattern = pattern.replace(/\*(\s*\*)+/g, "*");

  // Truncate if still too long
  if (pattern.length > MAX_PATTERN_LENGTH) {
    pattern = pattern.substring(0, MAX_PATTERN_LENGTH - 1) + "*";
  }

  if (pattern === "*") return text.substring(0, MAX_PATTERN_LENGTH);

  return pattern;
}

function limitPerState(patterns: LearnedPattern[], max: number): LearnedPattern[] {
  const counts = new Map<string, number>();
  return patterns.filter((p) => {
    const count = counts.get(p.classified_as) ?? 0;
    if (count >= max) return false;
    counts.set(p.classified_as, count + 1);
    return true;
  });
}

function deduplicatePatterns(patterns: LearnedPattern[]): LearnedPattern[] {
  const keep: LearnedPattern[] = [];

  for (const pat of patterns) {
    let dominated = false;
    for (const existing of keep) {
      if (existing.classified_as !== pat.classified_as) continue;
      if (existing.pattern.includes(pat.pattern) && existing.confidence >= pat.confidence) {
        dominated = true;
        break;
      }
    }

    if (!dominated) {
      for (let i = keep.length - 1; i >= 0; i--) {
        if (
          keep[i].classified_as === pat.classified_as &&
          pat.pattern.includes(keep[i].pattern) &&
          pat.confidence >= keep[i].confidence
        ) {
          keep.splice(i, 1);
        }
      }
      keep.push(pat);
    }
  }

  return keep;
}
