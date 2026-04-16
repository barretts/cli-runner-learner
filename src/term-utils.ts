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
 * - Kitty keyboard protocol sequences
 * - Unicode box drawing / block element artifacts from partial rendering
 * - Null bytes and padding from TUI layout
 * - Repeated whitespace from cursor positioning
 */
const TUI_ARTIFACT_RE =
  /\[<?>\d*[;?\d]*[a-zA-Z]|\[<?[a-zA-Z]|\x00+|[\x80-\x9f]|[\u2500-\u257f]|[\u2580-\u259f]|[\u2800-\u28ff]/g;

export function deepStripTuiArtifacts(text: string): string {
  let result = text.replace(TUI_ARTIFACT_RE, " ");
  // Strip orphaned SGR params (e.g. "1;32m" or bare "m" left from split escape sequences)
  result = result.replace(/(?:^|(?<=\s))\d*(?:;\d+)*m/g, " ");
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
