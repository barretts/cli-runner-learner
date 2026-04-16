import { spawn } from "node:child_process";

export interface LLMConfig {
  model: string;
  maxCalls: number;
}

const DEFAULT_MODEL = "claude-4.6-sonnet-medium";

const DEFAULTS: LLMConfig = {
  model: DEFAULT_MODEL,
  maxCalls: Infinity,
};

export class LLMClient {
  private config: LLMConfig;
  private calls = 0;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  get exhausted(): boolean {
    return this.calls >= this.config.maxCalls;
  }

  getUsage(): { calls: number; inputTokens: number; outputTokens: number } {
    return {
      calls: this.calls,
      // Token counts unavailable via CLI -- report 0
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /**
   * Run `agent -p --trust --output-format text --model <model>` with a combined
   * system+user prompt on stdin. Returns stdout as a string.
   * Includes a 120s timeout to prevent indefinite hangs.
   */
  async complete(systemPrompt: string, userMessage: string): Promise<string> {
    if (this.exhausted) {
      throw new Error(`LLM call budget exhausted (${this.config.maxCalls} calls)`);
    }

    this.calls++;
    const callNum = this.calls;

    const fullPrompt = `<system>\n${systemPrompt}\n</system>\n\n${userMessage}`;

    console.log(`[llm] Call #${callNum}/${this.config.maxCalls === Infinity ? 'inf' : this.config.maxCalls} model=${this.config.model}`);
    console.log(`[llm]   Prompt: system=${systemPrompt.length} chars, user=${userMessage.length} chars, total=${fullPrompt.length} chars`);

    const args = [
      "-p",
      "--trust",
      "--output-format", "text",
      "--model", this.config.model,
    ];

    const startTime = Date.now();
    const TIMEOUT_MS = 120_000;

    return new Promise<string>((resolve, reject) => {
      const proc = spawn("agent", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
        console.log(`[llm]   Call #${callNum} TIMEOUT after ${TIMEOUT_MS}ms`);
        reject(new Error(`agent CLI timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("error", (err) => {
        clearTimeout(timer);
        console.log(`[llm]   Call #${callNum} SPAWN ERROR: ${err.message}`);
        reject(new Error(`Failed to spawn agent CLI: ${err.message}`));
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        const elapsed = Date.now() - startTime;
        if (code !== 0) {
          console.log(`[llm]   Call #${callNum} FAILED: exit=${code}, ${elapsed}ms, stderr=${stderr.slice(0, 200)}`);
          reject(new Error(`agent CLI exited ${code}: ${stderr.slice(0, 500)}`));
        } else {
          console.log(`[llm]   Call #${callNum} OK: ${stdout.length} chars, ${elapsed}ms`);
          resolve(stdout);
        }
      });

      proc.stdin.write(fullPrompt);
      proc.stdin.end();
    });
  }
}

/**
 * Create an LLM client that shells out to `agent` CLI.
 * Returns null if `agent` is not on PATH.
 */
export function createLLMClient(overrides?: Partial<LLMConfig>): LLMClient | null {
  try {
    // Quick check that agent exists -- synchronous spawn would block,
    // so we optimistically create the client. First .complete() call
    // will fail with a clear error if agent isn't available.
    const config: LLMConfig = {
      model: overrides?.model ?? DEFAULTS.model,
      maxCalls: overrides?.maxCalls ?? DEFAULTS.maxCalls,
    };

    return new LLMClient(config);
  } catch {
    return null;
  }
}
