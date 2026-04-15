import type { ToolProfile, ToolState, StateTransition } from "../types.js";

/**
 * Transition-driven state machine that consumes profile.transitions[].
 *
 * Replaces the ad-hoc if/else state management in driver.ts with
 * a data-driven engine. Wildcard from:"*" matches any current state.
 */
export class ToolStateMachine {
  private currentState: ToolState;
  private readonly transitions: StateTransition[];

  constructor(profile: ToolProfile, initialState: ToolState = "startup") {
    this.currentState = initialState;
    this.transitions = profile.transitions;
  }

  get state(): ToolState {
    return this.currentState;
  }

  /**
   * Attempt a transition given a trigger name.
   * Returns the new state on success, null if no matching transition exists.
   */
  tryTransition(trigger: string): ToolState | null {
    for (const t of this.transitions) {
      if (t.on !== trigger) continue;
      if (t.from === "*" || t.from === this.currentState) {
        this.currentState = t.to as ToolState;
        return this.currentState;
      }
    }
    return null;
  }

  /**
   * All trigger names valid from the current state.
   */
  validTriggers(): string[] {
    const triggers: string[] = [];
    for (const t of this.transitions) {
      if (t.from === "*" || t.from === this.currentState) {
        triggers.push(t.on);
      }
    }
    return triggers;
  }

  /**
   * Check whether a transition from current state to target exists
   * (via any trigger).
   */
  canTransitionTo(target: ToolState): boolean {
    for (const t of this.transitions) {
      if (t.to !== target) continue;
      if (t.from === "*" || t.from === this.currentState) return true;
    }
    return false;
  }

  /**
   * Force-set the state without checking transitions.
   * Use sparingly -- only for cases like process exit where the
   * harness reports a terminal event regardless of current state.
   */
  forceState(state: ToolState): void {
    this.currentState = state;
  }
}
