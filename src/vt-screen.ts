/**
 * Minimal VT100 screen buffer for extracting visible text from TUI output.
 *
 * Handles cursor positioning (CUP), newlines, carriage returns,
 * erase sequences, and SGR (color) -- enough to replay a TUI session
 * and read back the final screen contents.
 */

export class VtScreen {
  private grid: string[][];
  private curRow = 0;
  private curCol = 0;
  readonly rows: number;
  readonly cols: number;

  constructor(rows = 24, cols = 80) {
    this.rows = rows;
    this.cols = cols;
    this.grid = Array.from({ length: rows }, () => new Array(cols).fill(" "));
  }

  /** Feed raw terminal output bytes through the emulator. */
  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];

      if (ch === "\x1b" && i + 1 < data.length) {
        if (data[i + 1] === "[") {
          // CSI sequence
          const csiEnd = this.findCsiEnd(data, i + 2);
          if (csiEnd !== -1) {
            const params = data.substring(i + 2, csiEnd);
            const cmd = data[csiEnd];
            this.handleCsi(params, cmd);
            i = csiEnd + 1;
            continue;
          }
        } else if (data[i + 1] === "]") {
          // OSC sequence -- skip to BEL or ST
          let j = i + 2;
          while (j < data.length) {
            if (data[j] === "\x07") { j++; break; }
            if (data[j] === "\x1b" && j + 1 < data.length && data[j + 1] === "\\") { j += 2; break; }
            j++;
          }
          i = j;
          continue;
        }
        // Other ESC sequences -- skip 2-3 chars
        i += 2;
        if (i < data.length && /[()#]/.test(data[i - 1])) i++;
        continue;
      }

      // C1 control: 8-bit CSI
      if (ch === "\x9b") {
        const csiEnd = this.findCsiEnd(data, i + 1);
        if (csiEnd !== -1) {
          const params = data.substring(i + 1, csiEnd);
          const cmd = data[csiEnd];
          this.handleCsi(params, cmd);
          i = csiEnd + 1;
          continue;
        }
      }

      // Control characters
      if (ch === "\n") {
        this.curRow++;
        if (this.curRow >= this.rows) {
          this.scrollUp();
          this.curRow = this.rows - 1;
        }
        i++;
        continue;
      }
      if (ch === "\r") { this.curCol = 0; i++; continue; }
      if (ch === "\t") { this.curCol = Math.min(this.curCol + (8 - (this.curCol % 8)), this.cols - 1); i++; continue; }
      if (ch === "\x08") { if (this.curCol > 0) this.curCol--; i++; continue; } // backspace
      if (ch.charCodeAt(0) < 0x20 || ch === "\x7f") { i++; continue; } // other control chars

      // Printable character
      if (this.curCol < this.cols && this.curRow < this.rows) {
        this.grid[this.curRow][this.curCol] = ch;
        this.curCol++;
        if (this.curCol >= this.cols) {
          this.curCol = 0;
          this.curRow++;
          if (this.curRow >= this.rows) {
            this.scrollUp();
            this.curRow = this.rows - 1;
          }
        }
      }

      i++;
    }
  }

  /** Read the current screen contents as an array of trimmed lines. */
  readScreen(): string[] {
    return this.grid.map((row) => row.join("").trimEnd());
  }

  /** Read non-empty lines from the screen. */
  readVisibleLines(): string[] {
    return this.readScreen().filter((l) => l.trim().length > 0);
  }

  private findCsiEnd(data: string, start: number): number {
    let i = start;
    // Skip parameter bytes (0x30-0x3F) and intermediate bytes (0x20-0x2F)
    while (i < data.length && ((data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) || data[i] === "?" || data[i] === ";")) {
      i++;
    }
    // Skip intermediate bytes
    while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) {
      i++;
    }
    // Final byte
    if (i < data.length && data.charCodeAt(i) >= 0x40 && data.charCodeAt(i) <= 0x7e) {
      return i;
    }
    return -1;
  }

  private handleCsi(params: string, cmd: string): void {
    const args = params.split(";").map((s) => parseInt(s, 10) || 0);

    switch (cmd) {
      case "H": case "f": // CUP: Cursor Position
        this.curRow = Math.min((args[0] || 1) - 1, this.rows - 1);
        this.curCol = Math.min((args[1] || 1) - 1, this.cols - 1);
        break;

      case "A": // CUU: Cursor Up
        this.curRow = Math.max(this.curRow - (args[0] || 1), 0);
        break;
      case "B": // CUD: Cursor Down
        this.curRow = Math.min(this.curRow + (args[0] || 1), this.rows - 1);
        break;
      case "C": // CUF: Cursor Forward
        this.curCol = Math.min(this.curCol + (args[0] || 1), this.cols - 1);
        break;
      case "D": // CUB: Cursor Back
        this.curCol = Math.max(this.curCol - (args[0] || 1), 0);
        break;

      case "J": // ED: Erase in Display
        if (args[0] === 2 || args[0] === 3) {
          // Clear entire screen
          for (let r = 0; r < this.rows; r++) this.grid[r].fill(" ");
        } else if (args[0] === 1) {
          // Clear from start to cursor
          for (let r = 0; r < this.curRow; r++) this.grid[r].fill(" ");
          for (let c = 0; c <= this.curCol && c < this.cols; c++) this.grid[this.curRow][c] = " ";
        } else {
          // Clear from cursor to end
          for (let c = this.curCol; c < this.cols; c++) this.grid[this.curRow][c] = " ";
          for (let r = this.curRow + 1; r < this.rows; r++) this.grid[r].fill(" ");
        }
        break;

      case "K": // EL: Erase in Line
        if (args[0] === 2) {
          this.grid[this.curRow].fill(" ");
        } else if (args[0] === 1) {
          for (let c = 0; c <= this.curCol && c < this.cols; c++) this.grid[this.curRow][c] = " ";
        } else {
          for (let c = this.curCol; c < this.cols; c++) this.grid[this.curRow][c] = " ";
        }
        break;

      case "m": // SGR: graphics -- ignore (just colors/bold/etc)
        break;

      case "h": case "l": // SM/RM: Set/Reset Mode -- ignore
        break;

      case "r": // DECSTBM: scroll region -- ignore for now
        break;

      case "G": // CHA: Cursor Character Absolute
        this.curCol = Math.min((args[0] || 1) - 1, this.cols - 1);
        break;

      case "d": // VPA: Vertical Position Absolute
        this.curRow = Math.min((args[0] || 1) - 1, this.rows - 1);
        break;

      // Kitty keyboard protocol, other private sequences -- ignore
      case "u": case "q": case "c": case "n": case "t":
        break;
    }
  }

  private scrollUp(): void {
    this.grid.shift();
    this.grid.push(new Array(this.cols).fill(" "));
  }
}

/**
 * Replay raw transcript bytes through a VT screen and extract visible text.
 * Takes hex-encoded recv event data arrays.
 */
export function replayToScreen(
  hexDataChunks: string[],
  rows = 24,
  cols = 80,
): string[] {
  const screen = new VtScreen(rows, cols);
  for (const hex of hexDataChunks) {
    const text = Buffer.from(hex, "hex").toString("utf-8");
    screen.write(text);
  }
  return screen.readVisibleLines();
}
