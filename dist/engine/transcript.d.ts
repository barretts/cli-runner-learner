import type { TranscriptEvent, TranscriptSegment } from "../types.js";
/**
 * Parse a JSONL transcript file into structured events.
 */
export declare function parseTranscript(path: string): Promise<TranscriptEvent[]>;
/**
 * Decode a hex-encoded recv/send event's data field to visible text.
 * The expect harness uses hex encoding (Tcl 8.5 compatible).
 */
export declare function decodeEventData(event: TranscriptEvent): string;
/**
 * Segment transcript events by silence gaps.
 * Events separated by more than gap_ms of silence are placed in different segments.
 */
export declare function segmentByGaps(events: TranscriptEvent[], gap_ms?: number): TranscriptSegment[];
/**
 * Frame-based segmentation for TUI output.
 *
 * Groups consecutive recv events within frame_ms (default 50ms) into
 * a single "render frame". Each frame is independently ANSI-stripped.
 * Identical consecutive frames are deduplicated (TUI re-renders).
 * Frames are then grouped into segments using gap_ms silence boundaries.
 *
 * Produces much cleaner text for TUI tools than raw gap-based segmentation.
 */
export declare function segmentByFrames(events: TranscriptEvent[], opts?: {
    frame_ms?: number;
    gap_ms?: number;
}): TranscriptSegment[];
/**
 * Compute aggregate timing stats from transcript events.
 */
export interface TimingProfile {
    total_duration_ms: number;
    recv_event_count: number;
    send_event_count: number;
    settled_events: Array<{
        ts: number;
        silence_ms: number;
    }>;
    total_recv_bytes: number;
    avg_output_rate_chars_per_sec: number;
}
export declare function computeTimingProfile(events: TranscriptEvent[]): TimingProfile;
