/**
 * Terminal escape sequence stripping and visible-content detection.
 * Adapted from 3pp-fix-database/src/term-utils.ts.
 *
 * Covers:
 *  - CSI sequences  (ESC [ params letter)
 *  - OSC sequences  (ESC ] ... BEL  or  ESC ] ... ST)
 *  - Other 2-3 char ESC sequences (ESC char, ESC ( char, etc.)
 *  - 8-bit C1 CSI   (0x9B params letter)
 *  - Bare control chars (0x00-0x08, 0x0B-0x1F, 0x7F) -- preserves TAB (0x09) and LF (0x0A)
 */
const TERM_ESCAPE_RE =
  /\x1b(?:\[[0-9;?]*[A-Za-z~]|\][^\x07]*\x07|\][^\x1b]*\x1b\\|[^\[\]].?)|\x9b[0-9;?]*[A-Za-z~]|[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripTermEscapes(s: string): string {
  return s.replace(TERM_ESCAPE_RE, "");
}

export function hasVisibleContent(line: string): boolean {
  return stripTermEscapes(line).trim().length > 0;
}

/**
 * Second-pass cleanup for TUI artifacts that survive the main ANSI strip.
 *
 * Handles:
 * - Incomplete CSI fragments like [>1u, [<u, [>4;2m, [>0q
 * - Kitty keyboard protocol sequences ([=0;1u, [?2026$p, [?1004$p)
 * - Cursor style sequences ([1 q, [0 q)
 * - DCS fragments (_Gi=..., other device control strings)
 * - Unicode box drawing / block element artifacts from partial rendering
 * - Null bytes and padding from TUI layout
 * - Repeated whitespace from cursor positioning
 */
const TUI_ARTIFACT_RE =
  /\[[?>=]*\d*[;?\d]*(?:\$[a-zA-Z]|[a-zA-Z])|\[\d+ [a-zA-Z]|_G[^\\]*\\?|i=\d+[,;][^\s]*|AAAA|\x00+|[\x80-\x9f]|[\u2500-\u257f]|[\u2580-\u259f]|[\u2800-\u28ff]/g;

export function deepStripTuiArtifacts(text: string): string {
  let result = text.replace(TUI_ARTIFACT_RE, " ");
  // Strip orphaned SGR params (e.g. "1;32m" or bare "m" left from split escape sequences)
  result = result.replace(/(?:^|(?<=\s))\d*(?:;\d+)*m/g, " ");
  // Strip orphaned bracket fragments (e.g. "[1" left after partial CSI removal)
  result = result.replace(/\[\d{0,3}(?=\s|$)/g, " ");
  // Strip dot-animation noise: 5+ consecutive dots collapse to "...".
  // TUI tools like crush show "..............." loading animations that cycle with
  // random characters replacing individual dots. The long dot runs get collapsed
  // so labels like "Working..." remain clean; standalone noise frames become short
  // enough to be filtered by pattern extraction's length/entropy checks.
  result = result.replace(/\.{5,}/g, "...");
  // Collapse multiple spaces
  result = result.replace(/ {2,}/g, " ");
  // Collapse multiple newlines
  result = result.replace(/\n{3,}/g, "\n\n");
  // Trim lines
  result = result
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
  return result;
}

// ---- Diagnostic Line Extraction ----
// Ported from 3pp-fix-database/src/orchestrator.ts.

const DIAGNOSTIC_PATTERNS = /\b(error|erro|err|fail|fatal|exception|panic|cannot|could not|unable|refused|denied|missing|not found|no such|timeout|timed out|crash|abort|reject|invalid|undefined|null|broken|corrupt|mismatch|incompatible|deprecated|warning|warn|problem|unexpected|unhandled|traceback|stack trace|ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|E2BIG|ENOMEM|exitcode|exit code|non-zero|killed|signal|segfault|oom)\b/i;

/**
 * Extract diagnostic lines (errors/warnings + context) from raw terminal output.
 * Returns a formatted string capped at 5000 chars for use in healer prompts.
 */
export function extractDiagnosticLines(raw: string): string {
  const clean = stripTermEscapes(raw);
  const lines = clean.split("\n");

  const diagnostics: string[] = [];
  const CONTEXT_LINES = 1;
  const seen = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (DIAGNOSTIC_PATTERNS.test(lines[i])) {
      const start = Math.max(0, i - CONTEXT_LINES);
      const end = Math.min(lines.length - 1, i + CONTEXT_LINES);
      for (let j = start; j <= end; j++) {
        if (!seen.has(j) && lines[j].trim().length > 0) {
          seen.add(j);
          diagnostics.push(lines[j].trimEnd());
        }
      }
    }
  }

  // Last 10 non-empty lines as tail context
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 10; i--) {
    if (lines[i].trim().length > 0) {
      tail.unshift(lines[i].trimEnd());
    }
  }

  const parts: string[] = [];
  if (diagnostics.length > 0) {
    const capped = diagnostics.length > 60
      ? [...diagnostics.slice(0, 30), `... (${diagnostics.length - 60} more diagnostic lines) ...`, ...diagnostics.slice(-30)]
      : diagnostics;
    parts.push("--- DIAGNOSTIC LINES (errors/warnings) ---");
    parts.push(...capped);
  }
  parts.push("--- LAST 10 LINES ---");
  parts.push(...tail);

  const result = parts.join("\n");
  return result.length > 5000 ? result.slice(0, 5000) + "\n... (truncated)" : result;
}

/**
 * Match a glob pattern against text. Supports * (match anything) only.
 * Case-insensitive matching when caseInsensitive is true.
 */
export function globMatch(pattern: string, text: string, caseInsensitive = false): boolean {
  let p = pattern;
  let t = text;
  if (caseInsensitive) {
    p = p.toLowerCase();
    t = t.toLowerCase();
  }

  const parts = p.split("*");
  if (parts.length === 1) return t === p;

  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") continue;
    const idx = t.indexOf(part, pos);
    if (idx === -1) return false;
    if (i === 0 && idx !== 0) return false; // first part must match at start unless pattern starts with *
    pos = idx + part.length;
  }
  // if pattern doesn't end with *, text must end at current pos
  if (!p.endsWith("*") && pos !== t.length) return false;
  return true;
}
