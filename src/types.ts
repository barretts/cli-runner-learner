// ---- Transcript Events ----

export interface TranscriptEvent {
  ts: number;          // unix ms
  type: "recv" | "send" | "meta";
  data?: string;       // raw bytes for recv/send
  event?: string;      // for meta: "settled", "exit", "started"
  value?: number;      // for meta: exit code, elapsed ms, pid
}

export interface TranscriptSegment {
  start_ts: number;
  end_ts: number;
  events: TranscriptEvent[];
  stripped_text: string;  // ANSI-stripped concatenation of recv data
}

// ---- Classification ----

export type ToolState =
  | "startup"
  | "ready"
  | "working"
  | "thinking"
  | "prompting"
  | "completed"
  | "error"
  | "unknown";

export interface ClassifiedSegment extends TranscriptSegment {
  state: ToolState;
  confidence: number;  // 0.0-1.0
  reason: string;      // why this classification was chosen
  detectedSubPrompt?: {
    prompt_text: string;
    prompt_type: "yes_no" | "selection" | "text_input" | "confirmation" | "unknown";
    suggested_response: string;
    confidence: number;
  };
}

// ---- Tool Profile ----

export interface StateIndicator {
  type: "output_glob" | "silence_after_output_ms" | "continuous_output_rate" | "process_exit" | "exit_code_nonzero";
  pattern?: string;
  value?: number;
  min_chars_per_sec?: number;
  case_insensitive?: boolean;
}

export interface SubPrompt {
  id: string;
  indicators: StateIndicator[];
  auto_response: string | null;
  description?: string;
}

export interface StateDefinition {
  description: string;
  indicators: StateIndicator[];
  timeout_sec?: number;
  sub_prompts?: SubPrompt[];
}

export interface StateTransition {
  from: string;  // state name or "*"
  to: string;
  on: string;    // trigger name
}

export interface ToolProfile {
  schema_version: string;
  tool_id: string;
  tool_command: string;
  last_updated: string;
  confidence: number;
  probe_count: number;
  needs_review?: boolean;

  /** How input is provided: "interactive" = wait for prompt, type input;
   *  "args" = append input as command-line arguments */
  interaction_mode: "interactive" | "args";

  launch: {
    default_args: string[];
    env: Record<string, string>;
    needs_pty: boolean;
    startup_timeout_sec: number;
  };

  states: Record<string, StateDefinition>;
  transitions: StateTransition[];

  timing: {
    typical_startup_sec: number;
    idle_threshold_sec: number;
    max_session_sec: number;
  };

  learned_patterns: LearnedPattern[];

  /** Tool-specific env vars that reduce animations/noise during learning.
   *  e.g. { "CRUSH_REDUCE_ANIMATIONS": "1" } */
  reduce_motion_env?: Record<string, string>;

  discovery?: ToolDiscovery;
  llm_classifications?: number;

  metadata?: {
    tool_version?: string;
    terminal_cols?: number;
    terminal_rows?: number;
  };
}

export interface ToolDiscovery {
  help_text: string;
  parsed_description: string;
  subcommands: Array<{ name: string; description: string; flags: string[] }>;
  common_flags: string[];
  interactive: boolean;
  discovered_at: string;
}

export interface LearnedPattern {
  source_transcript: string;
  timestamp: string;
  pattern: string;
  classified_as: string;
  occurrences: number;
  confidence: number;
}

// ---- Session / Harness ----

export interface SessionConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  settle_timeout_ms: number;  // how long of silence = "settled"
  max_session_ms: number;
  transcript_path: string;
  control_fifo: string;
  event_fifo: string;
}

export type FifoCommand =
  | { type: "send"; payload: "enter" | "ctrl-c" | "eof" }
  | { type: "send_text"; payload: string }
  | { type: "kill" };

export interface FifoEvent {
  type: "output" | "settled" | "exit" | "started";
  data?: string;    // base64 for output
  value?: number;   // ms for settled, code for exit, pid for started
}

// ---- Learning ----

export type ProbeStrategy =
  | "observe" | "enter" | "input" | "prompt_response" | "custom"
  | "shortcut" | "multi_turn" | "permission_flow" | "explore" | "ctrl_c";

export interface ProbeRound {
  round: number;
  strategy: ProbeStrategy;
  input_text?: string;        // for "input" or "custom" strategy
  transcript_path: string;
  rationale?: string;
  expected_outcome?: string;
}

export interface ProbeResult {
  round: number;
  strategy: ProbeStrategy;
  input_text?: string;
  transcript_path: string;
  classified_segments: ClassifiedSegment[];
  rationale?: string;
}

export interface LearnOpts {
  max_rounds: number;
  confidence_threshold: number;
  settle_timeout_ms: number;
  max_probe_session_ms: number;
}

// ---- State Verification ----

export interface StateSnapshot {
  commit_hash: string | null;
  timestamp: string;
  tracked_files: number;
  untracked_files: string[];
  modified_files: string[];
  is_clean: boolean;
}

export interface StateDiff {
  before: StateSnapshot;
  after: StateSnapshot;
  new_files: string[];
  modified_files: string[];
  deleted_files: string[];
  diff_summary: string;
  raw_diff: string;
}

// ---- Driver ----

export interface DriveOpts {
  input: string;
  max_session_ms: number;
  settle_timeout_ms: number;
  workDir?: string;  // directory to track for side effects via git
  llmClient?: import("./llm/client.js").LLMClient | null;
}

export interface DriveResult {
  success: boolean;
  final_state: ToolState;
  transcript_path: string;
  output: string;
  duration_ms: number;
  state_diff?: StateDiff;
}

// ---- Healing (agentic-skill-mill) ----

export type LearnFailureClass =
  | "probe_no_output"
  | "classification_ambiguous"
  | "state_gap"
  | "pattern_noise"
  | "probe_timeout"
  | "tool_crash"
  | "convergence_plateau";

export interface LearnHealPatch {
  target: "probe_strategy" | "classification_hint" | "profile_state" | "timing_knob";
  operation: "append" | "replace";
  content: string;
}

export interface LearnHealDecision {
  decision: "RETRY" | "STOP" | "ACCEPT_PARTIAL";
  failure_class: LearnFailureClass;
  root_cause: string;
  patches: LearnHealPatch[];
  learned_rule?: string;
  suggested_probes?: Array<{
    strategy: ProbeStrategy;
    input_text?: string;
    rationale: string;
  }>;
}

export interface LearnSessionState {
  schema_version: "1.0";
  session_id: string;
  tool_id: string;
  tool_command: string;
  started_at: string;
  updated_at: string;
  status: "RUNNING" | "COMPLETED" | "ABORTED";
  abort_reason?: string;

  current_round: number;
  max_rounds: number;
  confidence_threshold: number;
  confidence_history: number[];

  completed_probes: Array<{
    round: number;
    strategy: ProbeStrategy;
    input_text?: string;
    transcript_path: string;
    states_observed: ToolState[];
  }>;

  healing_rounds: Array<{
    round: number;
    failure_signatures: string[];
    decision: string;
    patches_applied: number;
    timestamp: string;
  }>;

  failure_signatures_seen: string[];

  config: {
    settle_timeout_ms: number;
    max_probe_session_ms: number;
    heal_mode: string;
    max_heal_rounds: number;
  };
}
