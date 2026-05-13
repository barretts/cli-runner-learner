import { readFile } from "node:fs/promises";
import { stripTermEscapes, deepStripTuiArtifacts } from "../term-utils.js";
/**
 * Parse a JSONL transcript file into structured events.
 */
export async function parseTranscript(path) {
    console.log(`[transcript] Parsing: ${path}`);
    const raw = await readFile(path, "utf-8");
    const events = [];
    let malformed = 0;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            events.push(JSON.parse(trimmed));
        }
        catch {
            malformed++;
        }
    }
    const typeCounts = {};
    for (const e of events) {
        typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    }
    const duration = events.length > 1 ? events[events.length - 1].ts - events[0].ts : 0;
    console.log(`[transcript] Parsed ${events.length} events (${malformed} malformed), duration=${duration}ms`);
    console.log(`[transcript] Types: ${Object.entries(typeCounts).map(([t, c]) => `${t}:${c}`).join(', ')}`);
    return events;
}
/**
 * Decode a hex-encoded recv/send event's data field to visible text.
 * The expect harness uses hex encoding (Tcl 8.5 compatible).
 */
export function decodeEventData(event) {
    if (!event.data)
        return "";
    if (event.type === "recv" || event.type === "send") {
        try {
            return Buffer.from(event.data, "hex").toString("utf-8");
        }
        catch {
            return event.data;
        }
    }
    return event.data;
}
/**
 * Segment transcript events by silence gaps.
 * Events separated by more than gap_ms of silence are placed in different segments.
 */
export function segmentByGaps(events, gap_ms = 2000) {
    if (events.length === 0)
        return [];
    const segments = [];
    let current = [events[0]];
    for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const curr = events[i];
        if (curr.ts - prev.ts > gap_ms) {
            segments.push(buildSegment(current));
            current = [curr];
        }
        else {
            current.push(curr);
        }
    }
    if (current.length > 0) {
        segments.push(buildSegment(current));
    }
    return segments;
}
function buildSegment(events) {
    const recvText = events
        .filter((e) => e.type === "recv")
        .map((e) => decodeEventData(e))
        .join("");
    return {
        start_ts: events[0].ts,
        end_ts: events[events.length - 1].ts,
        events,
        stripped_text: deepStripTuiArtifacts(stripTermEscapes(recvText)),
    };
}
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
export function segmentByFrames(events, opts = {}) {
    const frameMs = opts.frame_ms ?? 50;
    const gapMs = opts.gap_ms ?? 2000;
    console.log(`[transcript] segmentByFrames: ${events.length} events, frame=${frameMs}ms, gap=${gapMs}ms`);
    if (events.length === 0) {
        console.log(`[transcript] No events to segment`);
        return [];
    }
    // Step 1: Group recv events into render frames
    const frames = [];
    let frameEvents = [];
    let frameStart = 0;
    for (const event of events) {
        if (event.type !== "recv") {
            // non-recv events belong to the frame they're temporally close to
            if (frameEvents.length > 0 && event.ts - frameStart <= frameMs) {
                frameEvents.push(event);
            }
            else if (frameEvents.length > 0) {
                // Time-gapped non-recv: close current frame, start a new one
                frames.push(buildFrame(frameEvents));
                frameEvents = [event];
                frameStart = event.ts;
            }
            else {
                frameEvents = [event];
                frameStart = event.ts;
            }
            continue;
        }
        if (frameEvents.length === 0) {
            frameEvents = [event];
            frameStart = event.ts;
        }
        else if (event.ts - frameStart <= frameMs) {
            frameEvents.push(event);
        }
        else {
            // Close current frame, start new one
            frames.push(buildFrame(frameEvents));
            frameEvents = [event];
            frameStart = event.ts;
        }
    }
    if (frameEvents.length > 0) {
        frames.push(buildFrame(frameEvents));
    }
    // Step 2: Deduplicate consecutive identical frames
    const deduped = [];
    for (const frame of frames) {
        if (deduped.length === 0 || frame.text !== deduped[deduped.length - 1].text) {
            deduped.push(frame);
        }
    }
    // Step 3: Group frames into segments by gap_ms boundaries
    if (deduped.length === 0)
        return [];
    const segments = [];
    let segFrames = [deduped[0]];
    for (let i = 1; i < deduped.length; i++) {
        const prev = deduped[i - 1];
        const curr = deduped[i];
        if (curr.ts - prev.ts > gapMs) {
            segments.push(mergeFramesIntoSegment(segFrames));
            segFrames = [curr];
        }
        else {
            segFrames.push(curr);
        }
    }
    if (segFrames.length > 0) {
        segments.push(mergeFramesIntoSegment(segFrames));
    }
    // Step 4: Split segments at settle event boundaries.
    // Without this, a 5s silence (settle) followed by a send and response output
    // lands in one segment. Splitting at settle boundaries separates startup from
    // ready, and working from the exit sequence.
    const splitSegments = [];
    for (const seg of segments) {
        const settleIndices = [];
        for (let i = 0; i < seg.events.length; i++) {
            const e = seg.events[i];
            if (e.type === "meta" && e.event === "settled") {
                settleIndices.push(i);
            }
        }
        if (settleIndices.length === 0) {
            splitSegments.push(seg);
            continue;
        }
        let startIdx = 0;
        for (const settleIdx of settleIndices) {
            const slice = seg.events.slice(startIdx, settleIdx + 1);
            if (slice.length > 0) {
                splitSegments.push(buildSegment(slice));
            }
            startIdx = settleIdx + 1;
        }
        if (startIdx < seg.events.length) {
            const remaining = seg.events.slice(startIdx);
            if (remaining.length > 0) {
                splitSegments.push(buildSegment(remaining));
            }
        }
    }
    console.log(`[transcript] segmentByFrames result: ${frames.length} frames -> ${deduped.length} deduped -> ${segments.length} gap-segments -> ${splitSegments.length} final segments`);
    for (let i = 0; i < splitSegments.length; i++) {
        const s = splitSegments[i];
        const dur = s.end_ts - s.start_ts;
        console.log(`[transcript]   Segment ${i}: ${dur}ms, ${s.events.length} events, ${s.stripped_text.length} chars text`);
    }
    return splitSegments;
}
function buildFrame(events) {
    const rawText = events
        .filter((e) => e.type === "recv")
        .map((e) => decodeEventData(e))
        .join("");
    return {
        ts: events[0].ts,
        events,
        text: deepStripTuiArtifacts(stripTermEscapes(rawText)).trim(),
    };
}
function mergeFramesIntoSegment(frames) {
    const allEvents = frames.flatMap((f) => f.events);
    // Join unique frame texts (skip empty and duplicate lines)
    const seen = new Set();
    const lines = [];
    for (const frame of frames) {
        if (!frame.text)
            continue;
        for (const line of frame.text.split("\n")) {
            const trimmed = line.trim();
            if (trimmed && !seen.has(trimmed)) {
                seen.add(trimmed);
                lines.push(trimmed);
            }
        }
    }
    return {
        start_ts: allEvents[0].ts,
        end_ts: allEvents[allEvents.length - 1].ts,
        events: allEvents,
        stripped_text: lines.join("\n"),
    };
}
export function computeTimingProfile(events) {
    if (events.length === 0) {
        return {
            total_duration_ms: 0,
            recv_event_count: 0,
            send_event_count: 0,
            settled_events: [],
            total_recv_bytes: 0,
            avg_output_rate_chars_per_sec: 0,
        };
    }
    const first = events[0].ts;
    const last = events[events.length - 1].ts;
    const duration = last - first;
    let recvCount = 0;
    let sendCount = 0;
    let totalBytes = 0;
    const settled = [];
    for (const e of events) {
        if (e.type === "recv") {
            recvCount++;
            totalBytes += decodeEventData(e).length;
        }
        else if (e.type === "send") {
            sendCount++;
        }
        else if (e.type === "meta" && e.event === "settled") {
            settled.push({ ts: e.ts, silence_ms: e.value ?? 0 });
        }
    }
    // compute output rate only during active output periods (exclude silence)
    const totalSilence = settled.reduce((sum, s) => sum + s.silence_ms, 0);
    const activeMs = Math.max(duration - totalSilence, 1);
    const rate = (totalBytes / activeMs) * 1000;
    return {
        total_duration_ms: duration,
        recv_event_count: recvCount,
        send_event_count: sendCount,
        settled_events: settled,
        total_recv_bytes: totalBytes,
        avg_output_rate_chars_per_sec: rate,
    };
}
//# sourceMappingURL=transcript.js.map