import type { LearnSessionState } from "../types.js";
export declare function initLearnState(toolId: string, command: string, opts: {
    maxRounds: number;
    confidenceThreshold: number;
    settleTimeoutMs: number;
    maxProbeSessionMs: number;
    healMode: string;
    maxHealRounds: number;
}): LearnSessionState;
export declare function checkpointLearnState(state: LearnSessionState): Promise<void>;
export declare function loadLearnState(toolId: string): Promise<LearnSessionState | null>;
export declare function clearLearnState(toolId: string): Promise<void>;
