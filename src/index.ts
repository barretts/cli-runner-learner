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
  loadAdapterOverrides,
} from "./export/adapter-generator.js";
export type { GeneratedAdapterPreset, AdapterOverride, ForbiddenArgEntry } from "./export/adapter-generator.js";

// ─── Runtime: session + driver ──────────────────────────────────────────────
export { Session, createSessionConfig } from "./runner/session.js";
export { drive } from "./runner/driver.js";
export { ToolStateMachine } from "./runner/state-machine.js";

// ─── Runtime: output adapters (consumed by agent-threader bridge) ───────────
export { selectAdapter } from "./orchestration/adapter.js";
export type { OutputAdapter } from "./orchestration/adapter.js";
export { PassthroughAdapter } from "./orchestration/adapters/passthrough.js";
export { SentinelAdapter } from "./orchestration/adapters/sentinel.js";
export { InteractiveAdapter } from "./orchestration/adapters/interactive.js";
export type {
  TaskDef as ClrTaskDef,
  TaskResult as ClrTaskResult,
  ParserFailure as ClrParserFailure,
  OrchFailureClass as ClrFailureClass,
} from "./orchestration/types.js";
export { isParserFailure as isClrParserFailure } from "./orchestration/types.js";

// ─── Terminal utilities ─────────────────────────────────────────────────────
export { stripTermEscapes, deepStripTuiArtifacts, extractDiagnosticLines } from "./term-utils.js";

// ─── Core types ─────────────────────────────────────────────────────────────
export type {
  ToolProfile,
  ToolState,
  StateDefinition,
  StateIndicator,
  StateTransition,
  SubPrompt,
  LearnedPattern,
  ToolDiscovery,
  DriveOpts,
  DriveResult,
  SessionConfig,
  StateDiff,
  StateSnapshot,
} from "./types.js";
