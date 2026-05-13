/**
 * Minimal VT100 screen buffer for extracting visible text from TUI output.
 *
 * Handles cursor positioning (CUP), newlines, carriage returns,
 * erase sequences, and SGR (color) -- enough to replay a TUI session
 * and read back the final screen contents.
 */
export declare class VtScreen {
    private grid;
    private curRow;
    private curCol;
    readonly rows: number;
    readonly cols: number;
    constructor(rows?: number, cols?: number);
    /** Feed raw terminal output bytes through the emulator. */
    write(data: string): void;
    /** Read the current screen contents as an array of trimmed lines. */
    readScreen(): string[];
    /** Read non-empty lines from the screen. */
    readVisibleLines(): string[];
    private findCsiEnd;
    private handleCsi;
    private scrollUp;
}
/**
 * Replay raw transcript bytes through a VT screen and extract visible text.
 * Takes hex-encoded recv event data arrays.
 */
export declare function replayToScreen(hexDataChunks: string[], rows?: number, cols?: number): string[];
