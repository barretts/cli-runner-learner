import type { SessionConfig, FifoEvent } from "../types.js";
export declare class Session {
    private ptyProcess;
    private transcriptFd;
    private pendingEvents;
    private eventResolvers;
    private _done;
    private settleTimer;
    private sessionTimer;
    private settledEmitted;
    private lastOutputTs;
    private sessionStartTs;
    readonly config: SessionConfig;
    constructor(config: SessionConfig);
    /**
     * Spawn the target command directly in a PTY via node-pty.
     * All I/O is recorded to a JSONL transcript. Settle detection and
     * max-session timeout are handled in-process.
     */
    start(): Promise<void>;
    get done(): boolean;
    /**
     * Wait for the next event, with timeout.
     * If no event arrives within timeout_ms, returns a synthetic "settled" event.
     */
    nextEvent(timeout_ms: number): Promise<FifoEvent>;
    sendEnter(): void;
    sendCtrlC(): void;
    sendCtrlD(): void;
    sendTab(): void;
    sendShiftTab(): void;
    sendEsc(): void;
    sendArrowUp(): void;
    sendArrowDown(): void;
    sendArrowLeft(): void;
    sendArrowRight(): void;
    sendText(text: string): void;
    sendKey(seq: string): void;
    sendKill(): void;
    /**
     * Clean up: kill PTY process, close transcript.
     */
    cleanup(): Promise<void>;
    private writeKey;
    private resetSettleTimer;
    private clearTimers;
    private emitEvent;
    private writeTranscript;
}
/**
 * Create a SessionConfig with sensible defaults.
 */
export declare function createSessionConfig(opts: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    settle_timeout_ms?: number;
    max_session_ms?: number;
    session_dir: string;
    session_id: string;
}): SessionConfig;
