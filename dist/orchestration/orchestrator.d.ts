/**
 * Orchestrator: dispatches tasks to LLM CLI tools using learned profiles.
 * Ported batch loop and healing from 3pp-fix-database, drives tools via
 * clr's existing drive() function.
 */
import type { LLMClient } from "../llm/client.js";
import type { Manifest, OrchestratorState } from "./types.js";
export interface OrchestratorConfig {
    manifest: Manifest;
    state: OrchestratorState;
    statePath: string;
    llmClient: LLMClient | null;
    transcriptDir: string;
}
export declare class Orchestrator {
    private manifest;
    private state;
    private statePath;
    private policy;
    private profiles;
    private adapters;
    private llmClient;
    private transcriptDir;
    private totalHealRounds;
    constructor(config: OrchestratorConfig);
    run(): Promise<void>;
    private depsReady;
    private executeTask;
    private runHeal;
    private addSignature;
    private addHistory;
    private save;
}
