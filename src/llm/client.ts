import { spawn } from "node:child_process";

export interface LLMConfig {
  model: string;
  maxCalls: number;
}

const DEFAULT_MODEL = "opus";

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
   * Run `claude -p --output-format text --model <model>` with a combined
   * system+user prompt on stdin. Returns stdout as a string.
   */
  async complete(systemPrompt: string, userMessage: string): Promise<string> {
    if (this.exhausted) {
      throw new Error(`LLM call budget exhausted (${this.config.maxCalls} calls)`);
    }

    this.calls++;

    const fullPrompt = `<system>\n${systemPrompt}\n</system>\n\n${userMessage}`;

    const args = [
      "-p",
      "--output-format", "text",
      "--model", this.config.model,
      "--max-turns", "1",
    ];

    return new Promise<string>((resolve, reject) => {
      const proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`));
        } else {
          resolve(stdout);
        }
      });

      proc.stdin.write(fullPrompt);
      proc.stdin.end();
    });
  }
}

/**
 * Create an LLM client that shells out to `claude` CLI.
 * Returns null if `claude` is not on PATH.
 */
export function createLLMClient(overrides?: Partial<LLMConfig>): LLMClient | null {
  try {
    // Quick check that claude exists -- synchronous spawn would block,
    // so we optimistically create the client. First .complete() call
    // will fail with a clear error if claude isn't available.
    const config: LLMConfig = {
      model: overrides?.model ?? DEFAULTS.model,
      maxCalls: overrides?.maxCalls ?? DEFAULTS.maxCalls,
    };

    return new LLMClient(config);
  } catch {
    return null;
  }
}
