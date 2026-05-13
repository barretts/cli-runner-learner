export interface LLMConfig {
    model: string;
    maxCalls: number;
}
export declare class LLMClient {
    private config;
    private calls;
    constructor(config: LLMConfig);
    get exhausted(): boolean;
    getUsage(): {
        calls: number;
        inputTokens: number;
        outputTokens: number;
    };
    /**
     * Run `agent -p --trust --output-format text --model <model>` with a combined
     * system+user prompt on stdin. Returns stdout as a string.
     * Includes a 120s timeout to prevent indefinite hangs.
     */
    complete(systemPrompt: string, userMessage: string): Promise<string>;
}
/**
 * Create an LLM client that shells out to `agent` CLI.
 * Returns null if `agent` is not on PATH.
 */
export declare function createLLMClient(overrides?: Partial<LLMConfig>): LLMClient | null;
