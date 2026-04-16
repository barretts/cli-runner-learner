/**
 * cli-runner-learner library exports.
 *
 * Consumers (e.g. AgentThreader) can import these to:
 * - Load learned profiles
 * - Generate skills from profiles
 * - Generate adapter presets from profiles
 */

export { loadProfile, saveProfile, bootstrapProfile } from "./engine/profile-manager.js";
export { generateSkillMarkdown } from "./export/skill-generator.js";
export {
  profileToAdapterPreset,
  generateAdapterTypeScript,
  generateAdapterJSON,
} from "./export/adapter-generator.js";
export type { GeneratedAdapterPreset } from "./export/adapter-generator.js";
export type {
  ToolProfile,
  ToolState,
  StateDefinition,
  StateIndicator,
  StateTransition,
  SubPrompt,
  LearnedPattern,
  ToolDiscovery,
} from "./types.js";
