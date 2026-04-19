import * as pty from "node-pty";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { SessionConfig, FifoEvent } from "../types.js";

export class Session {
  private ptyProcess: pty.IPty | null = null;
  private transcriptFd: FileHandle | null = null;
  private pendingEvents: FifoEvent[] = [];
  private eventResolvers: Array<(event: FifoEvent) => void> = [];
  private _done = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private settledEmitted = false;
  private lastOutputTs = 0;
  private sessionStartTs = 0;

  readonly config: SessionConfig;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  /**
   * Spawn the target command directly in a PTY via node-pty.
   * All I/O is recorded to a JSONL transcript. Settle detection and
   * max-session timeout are handled in-process.
   */
  async start(): Promise<void> {
    await mkdir(join(this.config.transcript_path, ".."), { recursive: true });

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // Reduce-motion hint — suppresses animations where supported
      REDUCE_MOTION: "1",
    };

    if (this.config.env) {
      Object.assign(env, this.config.env);
    }

    console.log(`[session] Spawning via node-pty: ${this.config.command} ${this.config.args.join(" ")}`);
    console.log(`[session]   settle_ms=${this.config.settle_timeout_ms}`);
    console.log(`[session]   max_session_ms=${this.config.max_session_ms}`);
    console.log(`[session]   transcript=${this.config.transcript_path}`);

    // Open transcript file
    this.transcriptFd = await open(this.config.transcript_path, "w");

    this.sessionStartTs = Date.now();
    this.lastOutputTs = this.sessionStartTs;

    // Spawn the command in a real PTY.
    //
    // cols is deliberately very wide: at cols=120 the VT emulator would soft-
    // wrap long lines (e.g. a single-line JSON payload) and insert CR/LF at the
    // wrap point. Downstream parsers that look at `driveResult.output`
    // (notably the sentinel adapter) would then see invalid JSON like
    // `"personaBlend":f\r\nalse`. Setting cols to 10000 effectively disables
    // soft-wrap for any realistic JSON output while still being a valid PTY.
    this.ptyProcess = pty.spawn(this.config.command, this.config.args, {
      name: "xterm-256color",
      cols: 10000,
      rows: 40,
      cwd: process.cwd(),
      env,
    });

    const pid = this.ptyProcess.pid;
    console.log(`[session] PTY spawned: pid=${pid}`);

    // Write started meta event
    await this.writeTranscript("meta", { event: "started", value: pid });
    this.emitEvent({ type: "started", value: pid });

    // Handle output
    this.ptyProcess.onData((data: string) => {
      if (this._done) return;
      const now = Date.now();
      this.lastOutputTs = now;
      this.settledEmitted = false;

      // Reset settle timer on every output
      this.resetSettleTimer();

      // Hex-encode and record
      const hex = Buffer.from(data).toString("hex");
      this.writeTranscript("recv", { data: hex }).catch(() => {});

      // Emit output event
      this.emitEvent({ type: "output", data: hex });
    });

    // Handle exit
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      if (this._done) return;
      const code = exitCode ?? (signal ?? 0);
      console.log(`[session] PTY exited: code=${exitCode}, signal=${signal}`);

      this.clearTimers();
      this.writeTranscript("meta", { event: "exit", value: code }).catch(() => {});
      this._done = true;
      this.emitEvent({ type: "exit", value: code });

      // Resolve any remaining waiters
      for (const resolve of this.eventResolvers) {
        resolve({ type: "exit", value: code });
      }
      this.eventResolvers = [];
    });

    // Start settle timer
    this.resetSettleTimer();

    // Start max session timer
    this.sessionTimer = setTimeout(() => {
      if (this._done) return;
      const elapsed = Date.now() - this.sessionStartTs;
      console.log(`[session] Max session timeout (${this.config.max_session_ms}ms) reached after ${elapsed}ms`);
      this.writeTranscript("meta", { event: "timeout", value: elapsed }).catch(() => {});
      this.emitEvent({ type: "exit", value: -1 });

      // Try graceful then hard kill
      try { this.ptyProcess?.write("\x03"); } catch {}
      try { this.ptyProcess?.write("\x03"); } catch {}
      setTimeout(() => {
        try { this.ptyProcess?.kill(); } catch {}
        this._done = true;
      }, 1000);
    }, this.config.max_session_ms);
  }

  get done(): boolean {
    return this._done;
  }

  /**
   * Wait for the next event, with timeout.
   * If no event arrives within timeout_ms, returns a synthetic "settled" event.
   */
  nextEvent(timeout_ms: number): Promise<FifoEvent> {
    if (this.pendingEvents.length > 0) {
      return Promise.resolve(this.pendingEvents.shift()!);
    }

    if (this._done) {
      return Promise.resolve({ type: "exit", value: 0 });
    }

    return new Promise<FifoEvent>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.eventResolvers.indexOf(wrappedResolve);
        if (idx !== -1) this.eventResolvers.splice(idx, 1);
        resolve({ type: "settled", value: timeout_ms });
      }, timeout_ms);

      const wrappedResolve = (event: FifoEvent) => {
        clearTimeout(timer);
        resolve(event);
      };

      this.eventResolvers.push(wrappedResolve);
    });
  }

  // ---- Keyboard send methods ----

  sendEnter(): void {
    this.writeKey("\r", "enter");
  }

  sendCtrlC(): void {
    this.writeKey("\x03", "ctrl-c");
  }

  sendCtrlD(): void {
    this.writeKey("\x04", "ctrl-d");
  }

  sendTab(): void {
    this.writeKey("\t", "tab");
  }

  sendShiftTab(): void {
    this.writeKey("\x1b[Z", "shift-tab");
  }

  sendEsc(): void {
    this.writeKey("\x1b", "esc");
  }

  sendArrowUp(): void {
    this.writeKey("\x1b[A", "arrow-up");
  }

  sendArrowDown(): void {
    this.writeKey("\x1b[B", "arrow-down");
  }

  sendArrowLeft(): void {
    this.writeKey("\x1b[D", "arrow-left");
  }

  sendArrowRight(): void {
    this.writeKey("\x1b[C", "arrow-right");
  }

  sendText(text: string): void {
    this.writeKey(text, `text(${text.length})`);
  }

  sendKey(seq: string): void {
    this.writeKey(seq, `key(${Buffer.from(seq).toString("hex")})`);
  }

  sendKill(): void {
    if (this._done) {
      console.log(`[session] sendKill skipped -- session done`);
      return;
    }
    console.log(`[session] Sending kill`);
    this.writeTranscript("meta", { event: "kill" }).catch(() => {});
    try { this.ptyProcess?.kill(); } catch {}
  }

  /**
   * Clean up: kill PTY process, close transcript.
   */
  async cleanup(): Promise<void> {
    console.log(`[session] Cleanup: done=${this._done}, pty=${this.ptyProcess ? 'alive' : 'null'}`);
    this.clearTimers();

    if (this.ptyProcess && !this._done) {
      console.log(`[session] Killing PTY process...`);
      try { this.ptyProcess.write("\x03"); } catch {}
      await new Promise((r) => setTimeout(r, 500));
      try { this.ptyProcess.kill(); } catch {}
      await new Promise((r) => setTimeout(r, 500));
      this._done = true;
    }

    if (this.transcriptFd) {
      try { await this.transcriptFd.close(); } catch {}
      this.transcriptFd = null;
    }
    console.log(`[session] Cleanup complete`);
  }

  // ---- Private helpers ----

  private writeKey(seq: string, label: string): void {
    if (this._done) {
      console.log(`[session] send(${label}) skipped -- session done`);
      return;
    }
    console.log(`[session] Sending: ${label}`);
    const hex = Buffer.from(seq).toString("hex");
    this.writeTranscript("send", { data: hex }).catch(() => {});
    try {
      this.ptyProcess?.write(seq);
    } catch {
      console.log(`[session] Write failed for ${label} -- PTY may have exited`);
    }
  }

  private resetSettleTimer(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this._done || this.settledEmitted) return;
      const silenceMs = Date.now() - this.lastOutputTs;
      if (silenceMs >= this.config.settle_timeout_ms) {
        this.settledEmitted = true;
        console.log(`[session] Settled after ${silenceMs}ms of silence`);
        this.writeTranscript("meta", { event: "settled", value: silenceMs }).catch(() => {});
        this.emitEvent({ type: "settled", value: silenceMs });
      }
    }, this.config.settle_timeout_ms);
  }

  private clearTimers(): void {
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    if (this.sessionTimer) { clearTimeout(this.sessionTimer); this.sessionTimer = null; }
  }

  private emitEvent(event: FifoEvent): void {
    const evtSummary = event.type === "output"
      ? `output (${event.data?.length ?? 0} hex chars)`
      : `${event.type}: ${event.value ?? event.data ?? ""}`;
    console.log(`[session] Event: ${evtSummary}`);

    if (this.eventResolvers.length > 0) {
      const resolve = this.eventResolvers.shift()!;
      resolve(event);
    } else {
      this.pendingEvents.push(event);
    }
  }

  private async writeTranscript(
    type: string,
    fields: Record<string, string | number>,
  ): Promise<void> {
    if (!this.transcriptFd) return;
    const ts = Date.now();
    const obj: Record<string, unknown> = { ts, type, ...fields };
    try {
      await this.transcriptFd.write(JSON.stringify(obj) + "\n");
    } catch {
      // transcript write failure is non-fatal
    }
  }
}

/**
 * Create a SessionConfig with sensible defaults.
 */
export function createSessionConfig(opts: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  settle_timeout_ms?: number;
  max_session_ms?: number;
  session_dir: string;
  session_id: string;
}): SessionConfig {
  return {
    command: opts.command,
    args: opts.args ?? [],
    env: opts.env,
    settle_timeout_ms: opts.settle_timeout_ms ?? 3000,
    max_session_ms: opts.max_session_ms ?? 120000,
    transcript_path: join(opts.session_dir, "transcripts", `${opts.session_id}.jsonl`),
    control_fifo: "",  // unused legacy field
    event_fifo: "",    // unused legacy field
  };
}
