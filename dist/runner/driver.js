import { Session, createSessionConfig } from "./session.js";
import { ToolStateMachine } from "./state-machine.js";
import { captureState, compareStates } from "../engine/state-verifier.js";
import { parseTranscript } from "../engine/transcript.js";
import { VtScreen } from "../vt-screen.js";
import { stripTermEscapes, deepStripTuiArtifacts, globMatch } from "../term-utils.js";
import { buildSubPromptAnalysisPrompt } from "../llm/prompts.js";
import { parseSubPromptAnalysis } from "../llm/parsers.js";
import { registerSubPrompt } from "../engine/profile-manager.js";
import { mkdir } from "node:fs/promises";
import { getDataDir, getTranscriptDir, getLogsDir } from "../paths.js";
/**
 * Profile-driven state machine that interacts with a CLI tool
 * using learned patterns from the tool profile.
 */
export async function drive(profile, opts) {
    const dataDir = getDataDir();
    const transcriptDir = getTranscriptDir();
    const sessionId = `${profile.tool_id}-drive-${Date.now()}`;
    const logsDir = getLogsDir();
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
        session_dir: dataDir,
        session_id: sessionId,
    });
    const session = new Session(config);
    const machine = new ToolStateMachine(profile);
    const startTime = Date.now();
    let collectedOutput = "";
    let inputSent = isArgsMode; // args mode: input is already "sent" via args
    let outputSinceInput = false; // track whether tool has produced output after input
    let recentOutput = ""; // accumulates output since last settled, for LLM sub-prompt analysis
    const llmClient = opts.llmClient ?? null;
    const log = (msg) => console.log(`[drive] ${msg}`);
    // Capture pre-execution state for side-effect tracking
    let beforeState;
    if (opts.workDir) {
        try {
            beforeState = await captureState(opts.workDir);
            log(`State tracking: ${opts.workDir} (${beforeState.is_clean ? "clean" : "dirty"})`);
        }
        catch (e) {
            log(`State tracking init failed: ${e}`);
        }
    }
    try {
        await session.start();
        log(`Session started: ${sessionId}`);
        log(`State: ${machine.state}`);
        const deadline = Date.now() + opts.max_session_ms;
        while (!session.done && Date.now() < deadline) {
            const remainingMs = Math.max(deadline - Date.now(), 1000);
            // Poll cap must be at least `settle_timeout_ms` so a session.nextEvent
            // timeout does not fire a synthetic "settled" before the real idle
            // detector in session.resetSettleTimer() does. Previously this was
            // hardcoded to 30000ms, which silently overrode profiles that requested
            // longer idle thresholds (e.g. LLM wrappers that take >30s to produce
            // their first byte) and killed the tool via ctrl-c before any output
            // arrived.
            const pollCapMs = Math.max(opts.settle_timeout_ms + 5000, 30000);
            const event = await session.nextEvent(Math.min(remainingMs, pollCapMs));
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
                    recentOutput += stripped + "\n";
                    if (inputSent && stripped.length > 0)
                        outputSinceInput = true;
                    // Check for thinking indicators (inline, before profile matching)
                    if (machine.state === "working" && isThinkingOutput(stripped)) {
                        const prev = machine.state;
                        if (machine.tryTransition("thinking_indicator")) {
                            log(`State: ${prev} -> ${machine.state} (detected thinking output)`);
                        }
                    }
                    // Check for state transitions based on output patterns
                    const matchedState = matchOutputToState(stripped, text, profile, machine.state);
                    if (matchedState && matchedState !== machine.state) {
                        const trigger = `${matchedState}_indicator`;
                        const prev = machine.state;
                        if (machine.tryTransition(trigger)) {
                            log(`State: ${prev} -> ${machine.state}`);
                        }
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
                    log(`SETTLED after ${event.value}ms in state: ${machine.state}`);
                    // LLM sub-prompt fallback: on settled, if output looks prompt-like
                    // but no stored sub-prompt matched, ask LLM for a response
                    if (machine.state === "working" || machine.state === "ready") {
                        if (isPromptLikeOutput(recentOutput) && llmClient && !llmClient.exhausted) {
                            try {
                                const spPrompt = buildSubPromptAnalysisPrompt(recentOutput);
                                const spRaw = await llmClient.complete(spPrompt.system, spPrompt.user);
                                const spParsed = parseSubPromptAnalysis(spRaw);
                                if (spParsed && spParsed.confidence >= 0.6) {
                                    log(`LLM detected sub-prompt: "${spParsed.prompt_text}" -> responding: "${spParsed.suggested_response}"`);
                                    session.sendText(spParsed.suggested_response + "\r");
                                    profile = registerSubPrompt(profile, spParsed);
                                    machine.tryTransition("prompt_indicator");
                                    recentOutput = "";
                                    break;
                                }
                            }
                            catch {
                                // LLM failed -- continue with normal settled logic
                            }
                        }
                    }
                    recentOutput = "";
                    if (machine.state === "startup" || machine.state === "ready") {
                        if (!inputSent) {
                            log(`Sending input: "${opts.input.substring(0, 60)}..."`);
                            session.sendText(opts.input + "\r");
                            inputSent = true;
                            const prev = machine.state;
                            if (machine.tryTransition("input_sent")) {
                                log(`State: ${prev} -> ${machine.state} (input sent)`);
                            }
                        }
                        else {
                            log("Tool settled after input was sent. Assuming completed.");
                            machine.tryTransition("completion_indicator") || machine.tryTransition("process_exit");
                        }
                    }
                    else if (machine.state === "thinking") {
                        log("Thinking settled. Transitioning to working (awaiting response).");
                        machine.tryTransition("output_resumed");
                    }
                    else if (machine.state === "working") {
                        if (outputSinceInput) {
                            log("Tool settled while working (output received). Assuming completed.");
                            machine.tryTransition("completion_indicator") || machine.tryTransition("process_exit");
                        }
                        else {
                            log("Tool settled while working but no output yet. Still waiting...");
                        }
                    }
                    break;
                }
                case "exit":
                    log(`Process exited (code: ${event.value})`);
                    machine.tryTransition("process_exit");
                    break;
            }
            if (machine.state === "completed" || machine.state === "error") {
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
                if (event.type === "exit")
                    break;
            }
        }
    }
    finally {
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
    }
    catch (e) {
        log(`Post-session VT extraction failed, using real-time output: ${e}`);
    }
    // Post-execution state comparison
    let stateDiff;
    if (opts.workDir && beforeState) {
        try {
            const afterState = await captureState(opts.workDir);
            stateDiff = await compareStates(opts.workDir, beforeState, afterState);
            log(`State diff: ${stateDiff.diff_summary}`);
        }
        catch (e) {
            log(`State comparison failed: ${e}`);
        }
    }
    return {
        success: machine.state === "completed" && inputSent,
        final_state: machine.state,
        transcript_path: config.transcript_path,
        output,
        duration_ms,
        state_diff: stateDiff,
    };
}
/**
 * Match output text against profile state indicators to detect transitions.
 */
function matchOutputToState(stripped, raw, profile, currentState) {
    // Check each state's indicators
    for (const [stateName, stateDef] of Object.entries(profile.states)) {
        for (const indicator of stateDef.indicators) {
            if (indicator.type === "output_glob" && indicator.pattern) {
                // Check against stripped text (line by line)
                for (const line of stripped.split("\n")) {
                    if (globMatch(indicator.pattern, line.trim(), indicator.case_insensitive)) {
                        return stateName;
                    }
                }
                // Also check against the full stripped text
                if (globMatch(indicator.pattern, stripped, indicator.case_insensitive)) {
                    return stateName;
                }
            }
        }
    }
    return null;
}
/**
 * Check if the output matches any sub-prompt that needs auto-response.
 */
function matchSubPrompt(stripped, profile) {
    const promptState = profile.states.prompting;
    if (!promptState?.sub_prompts)
        return null;
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
function isThinkingOutput(stripped) {
    return THINKING_INDICATORS.some((pat) => pat.test(stripped));
}
const PROMPT_LIKE_PATTERNS = [
    /\?\s*$/m,
    /:\s*$/m,
    /\(y\/n\)/i,
    /\[y\/N\]/,
    /\[Y\/n\]/,
    /Press.*to continue/i,
    /Allow/i,
    /Approve/i,
    /^\s*\d+[\.\)]\s+/m,
];
function isPromptLikeOutput(text) {
    return PROMPT_LIKE_PATTERNS.some((pat) => pat.test(text));
}
//# sourceMappingURL=driver.js.map