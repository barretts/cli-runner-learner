import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { join, resolve } from "node:path";
import type { SessionConfig, FifoEvent } from "../types.js";

const HARNESS_PATH = resolve(new URL("../../harness/pty-recorder.exp", import.meta.url).pathname);

export class Session {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pendingEvents: FifoEvent[] = [];
  private eventResolvers: Array<(event: FifoEvent) => void> = [];
  private _done = false;

  readonly config: SessionConfig;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  /**
   * Spawn the expect harness. Communication via stdin (commands) / stdout (events).
   */
  async start(): Promise<void> {
    await mkdir(join(this.config.transcript_path, ".."), { recursive: true });

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLR_COMMAND: this.config.command,
      CLR_ARGS: this.config.args.join(" "),
      CLR_TRANSCRIPT: this.config.transcript_path,
      CLR_SETTLE_MS: String(this.config.settle_timeout_ms),
      CLR_MAX_SESSION_MS: String(this.config.max_session_ms),
    };

    if (this.config.env) {
      Object.assign(env, this.config.env);
    }

    console.log(`[session] Spawning harness: expect ${HARNESS_PATH}`);
    console.log(`[session]   CLR_COMMAND=${env.CLR_COMMAND}`);
    console.log(`[session]   CLR_ARGS=${env.CLR_ARGS || '(none)'}`);
    console.log(`[session]   CLR_SETTLE_MS=${env.CLR_SETTLE_MS}`);
    console.log(`[session]   CLR_MAX_SESSION_MS=${env.CLR_MAX_SESSION_MS}`);
    console.log(`[session]   CLR_TRANSCRIPT=${env.CLR_TRANSCRIPT}`);

    this.proc = spawn("expect", [HARNESS_PATH], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Suppress EPIPE on stdin when process exits before we stop writing
    this.proc.stdin?.on("error", () => {});

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) process.stderr.write(`[harness] ${text}\n`);
    });

    this.proc.on("close", () => {
      this._done = true;
      for (const resolve of this.eventResolvers) {
        resolve({ type: "exit", value: 0 });
      }
      this.eventResolvers = [];
    });

    // Read events from harness stdout
    this.rl = createInterface({ input: this.proc.stdout! });

    this.rl.on("line", (line: string) => {
      const event = parseFifoEvent(line);
      if (!event) {
        if (line.trim()) console.log(`[session] Unparseable harness line: ${line.trim().substring(0, 120)}`);
        return;
      }

      const evtSummary = event.type === "output"
        ? `output (${event.data?.length ?? 0} hex chars)`
        : `${event.type}: ${event.value ?? event.data ?? ''}`;
      console.log(`[session] Event: ${evtSummary}`);

      if (this.eventResolvers.length > 0) {
        const resolve = this.eventResolvers.shift()!;
        resolve(event);
      } else {
        this.pendingEvents.push(event);
      }
    });

    this.rl.on("close", () => {
      this._done = true;
    });
  }

  get done(): boolean {
    return this._done;
  }

  /**
   * Wait for the next event from the harness, with timeout.
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

  /**
   * Send a command to the harness via stdin.
   */
  sendCommand(cmd: string): void {
    if (this._done) {
      console.log(`[session] sendCommand(${cmd}) skipped -- session done`);
      return;
    }
    console.log(`[session] Sending command: ${cmd}`);
    try {
      if (this.proc?.stdin?.writable) {
        this.proc.stdin.write(cmd + "\n");
      } else {
        console.log(`[session] stdin not writable, command dropped`);
      }
    } catch {
      console.log(`[session] EPIPE on stdin write -- process already exited`);
    }
  }

  sendEnter(): void {
    this.sendCommand("SEND:enter");
  }

  sendCtrlC(): void {
    this.sendCommand("SEND:ctrl-c");
  }

  sendText(text: string): void {
    const hex = Buffer.from(text).toString("hex");
    this.sendCommand(`SEND:text:${hex}`);
  }

  sendKill(): void {
    this.sendCommand("KILL");
  }

  /**
   * Clean up: kill process.
   */
  async cleanup(): Promise<void> {
    console.log(`[session] Cleanup: done=${this._done}, proc=${this.proc ? 'alive' : 'null'}`);
    if (this.proc && !this._done) {
      console.log(`[session] Sending SIGTERM...`);
      this.proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      if (!this._done) {
        console.log(`[session] Still alive after 1s, sending SIGKILL`);
        this.proc.kill("SIGKILL");
      }
    }
    this.rl?.close();
    console.log(`[session] Cleanup complete`);
  }
}

function parseFifoEvent(line: string): FifoEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) return null;

  const type = trimmed.substring(0, colonIdx).toLowerCase();
  const payload = trimmed.substring(colonIdx + 1);

  switch (type) {
    case "output":
      return { type: "output", data: payload };
    case "settled":
      return { type: "settled", value: parseInt(payload, 10) };
    case "exit":
      return { type: "exit", value: parseInt(payload, 10) };
    case "started":
      return { type: "started", value: parseInt(payload, 10) };
    case "timeout":
      return { type: "exit", value: -1 };
    default:
      return null;
  }
}

/**
 * Create a SessionConfig with sensible defaults.
 */
export function createSessionConfig(opts: {
  command: string;
  args?: string[];
  settle_timeout_ms?: number;
  max_session_ms?: number;
  session_dir: string;
  session_id: string;
}): SessionConfig {
  return {
    command: opts.command,
    args: opts.args ?? [],
    settle_timeout_ms: opts.settle_timeout_ms ?? 3000,
    max_session_ms: opts.max_session_ms ?? 120000,
    transcript_path: join(opts.session_dir, "transcripts", `${opts.session_id}.jsonl`),
    control_fifo: "",  // unused now
    event_fifo: "",    // unused now
  };
}
