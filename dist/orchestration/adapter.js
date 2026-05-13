/**
 * OutputAdapter interface and adapter selection.
 *
 * Profiles handle interaction (Layer 1 via drive()).
 * Adapters handle output parsing (Layer 2).
 */
import { PassthroughAdapter } from "./adapters/passthrough.js";
import { SentinelAdapter } from "./adapters/sentinel.js";
import { InteractiveAdapter } from "./adapters/interactive.js";
const ADAPTERS = {
    passthrough: () => new PassthroughAdapter(),
    sentinel: () => new SentinelAdapter(),
    interactive: () => new InteractiveAdapter(),
};
/**
 * Select an adapter for a task based on profile interaction mode and overrides.
 *
 * Priority: task.adapter_override > profile.interaction_mode mapping > passthrough
 */
export function selectAdapter(profile, task) {
    if (task.adapter_override && task.adapter_override in ADAPTERS) {
        return ADAPTERS[task.adapter_override]();
    }
    if (profile.interaction_mode === "args") {
        return ADAPTERS.sentinel();
    }
    if (profile.interaction_mode === "interactive") {
        return ADAPTERS.interactive();
    }
    return ADAPTERS.passthrough();
}
//# sourceMappingURL=adapter.js.map