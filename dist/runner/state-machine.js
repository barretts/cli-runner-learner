/**
 * Transition-driven state machine that consumes profile.transitions[].
 *
 * Replaces the ad-hoc if/else state management in driver.ts with
 * a data-driven engine. Wildcard from:"*" matches any current state.
 */
export class ToolStateMachine {
    currentState;
    transitions;
    constructor(profile, initialState = "startup") {
        this.currentState = initialState;
        this.transitions = profile.transitions;
    }
    get state() {
        return this.currentState;
    }
    /**
     * Attempt a transition given a trigger name.
     * Returns the new state on success, null if no matching transition exists.
     */
    tryTransition(trigger) {
        for (const t of this.transitions) {
            if (t.on !== trigger)
                continue;
            if (t.from === "*" || t.from === this.currentState) {
                this.currentState = t.to;
                return this.currentState;
            }
        }
        return null;
    }
    /**
     * All trigger names valid from the current state.
     */
    validTriggers() {
        const triggers = [];
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
    canTransitionTo(target) {
        for (const t of this.transitions) {
            if (t.to !== target)
                continue;
            if (t.from === "*" || t.from === this.currentState)
                return true;
        }
        return false;
    }
    /**
     * Force-set the state without checking transitions.
     * Use sparingly -- only for cases like process exit where the
     * harness reports a terminal event regardless of current state.
     */
    forceState(state) {
        this.currentState = state;
    }
}
//# sourceMappingURL=state-machine.js.map