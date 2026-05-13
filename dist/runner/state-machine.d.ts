import type { ToolProfile, ToolState } from "../types.js";
/**
 * Transition-driven state machine that consumes profile.transitions[].
 *
 * Replaces the ad-hoc if/else state management in driver.ts with
 * a data-driven engine. Wildcard from:"*" matches any current state.
 */
export declare class ToolStateMachine {
    private currentState;
    private readonly transitions;
    constructor(profile: ToolProfile, initialState?: ToolState);
    get state(): ToolState;
    /**
     * Attempt a transition given a trigger name.
     * Returns the new state on success, null if no matching transition exists.
     */
    tryTransition(trigger: string): ToolState | null;
    /**
     * All trigger names valid from the current state.
     */
    validTriggers(): string[];
    /**
     * Check whether a transition from current state to target exists
     * (via any trigger).
     */
    canTransitionTo(target: ToolState): boolean;
    /**
     * Force-set the state without checking transitions.
     * Use sparingly -- only for cases like process exit where the
     * harness reports a terminal event regardless of current state.
     */
    forceState(state: ToolState): void;
}
