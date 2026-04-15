import type { ToolProfile, ToolState, DriveOpts, DriveResult, FifoEvent } from "../types.js";
import { Session, createSessionConfig } from "./session.js";
import { parseTranscript } from "../engine/transcript.js";
import { VtScreen } from "../vt-screen.js";
import { stripTermEscapes, deepStripTuiArtifacts, globMatch } from "../term-utils.js";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";

const PROJECT_ROOT = resolve(new URL("../../", import.meta.url).pathname);

/**
 * Profile-driven state machine that interacts with a CLI tool
 * using learned patterns from the tool profile.
 */
export async function drive(
  profile: ToolProfile,
  opts: DriveOpts,
): Promise<DriveResult> {
  const sessionId = `${profile.tool_id}-drive-${Date.now()}`;
  const logsDir = join(PROJECT_ROOT, "logs");
  await mkdir(logsDir, { recursive: true });

  // For args mode, append input as command-line arguments
  const isArgsMode = profile.interaction_mode === "args";
  const launchArgs = isArgsMode
    ? [...profile.launch.default_args, ...opts.input.split(" ")]
    : profile.launch.default_args;

  const config = createSessionConfig({
    command: profile.tool_command,
    args: launchArgs,
    settle_timeout_ms: opts.settle_timeout_ms,
    max_session_ms: opts.max_session_ms,
    session_dir: PROJECT_ROOT,
    session_id: sessionId,
  });

  const session = new Session(config);
  const startTime = Date.now();
  let currentState: ToolState = "startup";
  let collectedOutput = "";
  let inputSent = isArgsMode; // args mode: input is already "sent" via args
  let outputSinceInput = false; // track whether tool has produced output after input

  const log = (msg: string) => console.log(`[drive] ${msg}`);

  try {
    await session.start();
    log(`Session started: ${sessionId}`);
    log(`State: ${currentState}`);

    const deadline = Date.now() + opts.max_session_ms;

    while (!session.done && Date.now() < deadline) {
      const remainingMs = Math.max(deadline - Date.now(), 1000);
      const event = await session.nextEvent(Math.min(remainingMs, 30000));

      switch (event.type) {
        case "started":
          log(`Process started (pid: ${event.value})`);
          break;

        case "output": {
          const text = event.data
            ? Buffer.from(event.data, "hex").toString("utf-8")
            : "";
          const stripped = deepStripTuiArtifacts(stripTermEscapes(text)).trim();
          collectedOutput += stripped + "\n";
          if (inputSent && stripped.length > 0) outputSinceInput = true;

          // Check for thinking indicators (inline, before profile matching)
          if (currentState === "working" && isThinkingOutput(stripped)) {
            log(`State: working -> thinking (detected thinking output)`);
            currentState = "thinking";
          }

          // Check for state transitions based on output patterns
          const newState = matchOutputToState(stripped, text, profile, currentState);
          if (newState && newState !== currentState) {
            log(`State: ${currentState} -> ${newState}`);
            currentState = newState;
          }

          // Check for prompting sub-states that need auto-response
          const autoResponse = matchSubPrompt(stripped, profile);
          if (autoResponse) {
            log(`Auto-responding to prompt: "${autoResponse.replace(/\r/g, "\\r")}"`);
            session.sendText(autoResponse);
          }
          break;
        }

        case "settled": {
          log(`SETTLED after ${event.value}ms in state: ${currentState}`);

          if (currentState === "startup" || currentState === "ready") {
            if (!inputSent) {
              log(`Sending input: "${opts.input.substring(0, 60)}..."`);
              session.sendText(opts.input + "\r");
              inputSent = true;
              currentState = "working";
              log(`State: ready -> working (input sent)`);
            } else {
              log("Tool settled after input was sent. Assuming completed.");
              currentState = "completed";
            }
          } else if (currentState === "thinking") {
            // Thinking settled -- tool may still produce output, stay in working
            log("Thinking settled. Transitioning to working (awaiting response).");
            currentState = "working";
          } else if (currentState === "working") {
            if (outputSinceInput) {
              log("Tool settled while working (output received). Assuming completed.");
              currentState = "completed";
            } else {
              log("Tool settled while working but no output yet. Still waiting...");
              // Don't transition -- tool may still be processing
            }
          }

          break;
        }

        case "exit":
          log(`Process exited (code: ${event.value})`);
          currentState = "completed";
          break;
      }

      if (currentState === "completed" || currentState === "error") {
        break;
      }
    }

    // Clean exit
    if (!session.done) {
      log("Sending ctrl-c to exit...");
      session.sendCtrlC();
      await new Promise((r) => setTimeout(r, 500));
      session.sendCtrlC();
      // Wait briefly for exit
      const exitDeadline = Date.now() + 5000;
      while (!session.done && Date.now() < exitDeadline) {
        const event = await session.nextEvent(1000);
        if (event.type === "exit") break;
      }
    }
  } finally {
    await session.cleanup();
  }

  const duration_ms = Date.now() - startTime;

  // Post-session: replay transcript through VT screen emulator for clean output
  // Per-event stripping fails for TUI tools with cursor positioning;
  // VT replay reconstructs the actual screen state
  let output = collectedOutput.trim();
  try {
    const transcriptEvents = await parseTranscript(config.transcript_path);
    const cols = profile.metadata?.terminal_cols ?? 80;
    const rows = profile.metadata?.terminal_rows ?? 24;
    const screen = new VtScreen(rows, cols);

    for (const event of transcriptEvents) {
      if (event.type === "recv" && event.data) {
        screen.write(Buffer.from(event.data, "hex").toString("utf-8"));
      }
    }

    const lines = screen.readVisibleLines();
    output = lines.join("\n").trim();
    log(`Post-session: VT replay extracted ${lines.length} lines, ${output.length} chars`);
  } catch (e) {
    log(`Post-session VT extraction failed, using real-time output: ${e}`);
  }

  return {
    success: currentState === "completed" && inputSent,
    final_state: currentState,
    transcript_path: config.transcript_path,
    output,
    duration_ms,
  };
}

/**
 * Match output text against profile state indicators to detect transitions.
 */
function matchOutputToState(
  stripped: string,
  raw: string,
  profile: ToolProfile,
  currentState: ToolState,
): ToolState | null {
  // Check each state's indicators
  for (const [stateName, stateDef] of Object.entries(profile.states)) {
    for (const indicator of stateDef.indicators) {
      if (indicator.type === "output_glob" && indicator.pattern) {
        // Check against stripped text (line by line)
        for (const line of stripped.split("\n")) {
          if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
            return stateName as ToolState;
          }
        }
        // Also check against the full stripped text
        if (globMatch(indicator.pattern, stripped, indicator.case_insensitive)) {
          return stateName as ToolState;
        }
      }
    }
  }

  return null;
}

/**
 * Check if the output matches any sub-prompt that needs auto-response.
 */
function matchSubPrompt(
  stripped: string,
  profile: ToolProfile,
): string | null {
  const promptState = profile.states.prompting;
  if (!promptState?.sub_prompts) return null;

  for (const sp of promptState.sub_prompts) {
    for (const indicator of sp.indicators) {
      if (indicator.type === "output_glob" && indicator.pattern) {
        for (const line of stripped.split("\n")) {
          if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
            return sp.auto_response;
          }
        }
      }
    }
  }

  return null;
}

const THINKING_INDICATORS = [
  /\(thinking\)/i,
  /thinking\.\.\./i,
  /Slithering/,
  /Germinating/,
  /Churning/,
  /Pondering/,
  /Reasoning/,
  /Analyzing/,
];

function isThinkingOutput(stripped: string): boolean {
  return THINKING_INDICATORS.some((pat) => pat.test(stripped));
}
