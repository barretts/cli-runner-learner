import type { LearnHealDecision } from "../types.js";
import type { HealerContext } from "../engine/healer.js";
import type { PromptPair } from "./prompts.js";
export declare function buildLearnHealerPrompt(ctx: HealerContext): PromptPair;
export declare function parseLearnHealDecision(raw: string): LearnHealDecision | null;
