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

  metadata?: {
    tool_version?: string;
    terminal_cols?: number;
    terminal_rows?: number;
  };
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

export type ProbeStrategy = "observe" | "enter" | "input" | "prompt_response";

export interface ProbeRound {
  round: number;
  strategy: ProbeStrategy;
  input_text?: string;        // for "input" strategy
  transcript_path: string;
}

export interface LearnOpts {
  max_rounds: number;
  confidence_threshold: number;
  settle_timeout_ms: number;
  max_probe_session_ms: number;
}

// ---- Driver ----

export interface DriveOpts {
  input: string;
  max_session_ms: number;
  settle_timeout_ms: number;
}

export interface DriveResult {
  success: boolean;
  final_state: ToolState;
  transcript_path: string;
  output: string;
  duration_ms: number;
}
