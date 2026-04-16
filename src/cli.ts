#!/usr/bin/env node

import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Session, createSessionConfig } from "./runner/session.js";
import { parseTranscript, segmentByGaps, segmentByFrames, computeTimingProfile, decodeEventData } from "./engine/transcript.js";
import { stripTermEscapes, extractDiagnosticLines } from "./term-utils.js";
import { classifySegments, extractTextForState } from "./engine/classifier.js";
import { extractPatterns } from "./engine/pattern-extractor.js";
import { loadProfile, saveProfile, bootstrapProfile, mergeLearnedPatterns, registerStructuralIndicators } from "./engine/profile-manager.js";
import { drive } from "./runner/driver.js";
import { createLLMClient } from "./llm/client.js";
import { discoverTool } from "./engine/discovery.js";
import { planNextProbe, type PlannedProbe } from "./engine/probe-planner.js";
import type { ProbeResult } from "./types.js";
import { diagnoseLearnFailures, heal, applyHealPatches, type HealerContext } from "./engine/healer.js";
import { initLearnState, checkpointLearnState, loadLearnState, clearLearnState } from "./engine/learn-state.js";

const PROJECT_ROOT = resolve(new URL("../", import.meta.url).pathname);

const program = new Command();
program
  .name("clr")
  .description("CLI Runner Learner -- forced learning cycle for interactive CLI tools")
  .version("0.1.0");

// ---- record subcommand ----

program
  .command("record")
  .description("Record a single session with a CLI tool. Detects SETTLED state, then sends ctrl-c to exit.")
  .requiredOption("--command <path>", "Path to the CLI tool binary")
  .option("--args <args>", "Arguments to pass to the tool (space-separated)", "")
  .option("--settle-timeout <ms>", "Silence threshold in ms to consider settled", "3000")
  .option("--max-session <ms>", "Maximum session duration in ms", "60000")
  .option("--id <session-id>", "Session ID for transcript filename")
  .action(async (opts) => {
    const sessionId = opts.id ?? `session-${Date.now()}`;
    const transcriptDir = join(PROJECT_ROOT, "transcripts");
    await mkdir(transcriptDir, { recursive: true });

    const config = createSessionConfig({
      command: opts.command,
      args: opts.args ? opts.args.split(" ").filter(Boolean) : [],
      settle_timeout_ms: parseInt(opts.settleTimeout, 10),
      max_session_ms: parseInt(opts.maxSession, 10),
      session_dir: PROJECT_ROOT,
      session_id: sessionId,
    });

    console.log(`[clr] Recording session: ${sessionId}`);
    console.log(`[clr] Command: ${config.command} ${config.args.join(" ")}`);
    console.log(`[clr] Settle timeout: ${config.settle_timeout_ms}ms`);
    console.log(`[clr] Transcript: ${config.transcript_path}`);

    const session = new Session(config);

    try {
      await session.start();
      console.log("[clr] Harness started. Waiting for events...");

      let settledCount = 0;
      const maxSettled = 1; // exit after first SETTLED for record mode

      while (!session.done) {
        const event = await session.nextEvent(config.max_session_ms);

        switch (event.type) {
          case "started":
            console.log(`[clr] Process started (pid: ${event.value})`);
            break;

          case "output": {
            const text = event.data ? Buffer.from(event.data, "hex").toString("utf-8") : "";
            const stripped = stripTermEscapes(text).trim();
            if (stripped) {
              // Show truncated output for visibility
              const preview = stripped.length > 120 ? stripped.substring(0, 120) + "..." : stripped;
              process.stdout.write(`[out] ${preview}\n`);
            }
            break;
          }

          case "settled":
            settledCount++;
            console.log(`[clr] SETTLED after ${event.value}ms of silence (${settledCount}/${maxSettled})`);
            if (settledCount >= maxSettled) {
              console.log("[clr] Sending ctrl-c to exit...");
              await session.sendCtrlC();
              await new Promise((r) => setTimeout(r, 500));
              await session.sendCtrlC();
              // Give it a moment to exit
              await new Promise((r) => setTimeout(r, 2000));
              break;
            }
            break;

          case "exit":
            console.log(`[clr] Process exited (code: ${event.value})`);
            break;
        }

        if (event.type === "exit" || (event.type === "settled" && settledCount >= maxSettled)) {
          break;
        }
      }
    } finally {
      await session.cleanup();
    }

    console.log(`\n[clr] Transcript saved: ${config.transcript_path}`);

    // Quick stats
    try {
      const events = await parseTranscript(config.transcript_path);
      const timing = computeTimingProfile(events);
      const segments = segmentByGaps(events, 2000);

      console.log(`[clr] Events: ${events.length} total (${timing.recv_event_count} recv, ${timing.send_event_count} send)`);
      console.log(`[clr] Duration: ${(timing.total_duration_ms / 1000).toFixed(1)}s`);
      console.log(`[clr] SETTLED events: ${timing.settled_events.length}`);
      console.log(`[clr] Segments (2s gap): ${segments.length}`);

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const dur = seg.end_ts - seg.start_ts;
        const preview = seg.stripped_text.substring(0, 80).replace(/\n/g, " ");
        console.log(`  [${i}] ${dur}ms | ${seg.events.length} events | "${preview}..."`);
      }
    } catch (e) {
      console.log(`[clr] Could not parse transcript: ${e}`);
    }
  });

// ---- inspect subcommand (utility) ----

program
  .command("inspect")
  .description("Inspect a recorded transcript file")
  .requiredOption("--transcript <path>", "Path to the JSONL transcript")
  .option("--raw", "Show raw base64 data instead of decoded text")
  .action(async (opts) => {
    const events = await parseTranscript(opts.transcript);
    const timing = computeTimingProfile(events);
    const segments = segmentByGaps(events, 2000);

    console.log(`Transcript: ${opts.transcript}`);
    console.log(`Events: ${events.length} (${timing.recv_event_count} recv, ${timing.send_event_count} send)`);
    console.log(`Duration: ${(timing.total_duration_ms / 1000).toFixed(1)}s`);
    console.log(`SETTLED events: ${timing.settled_events.length}`);
    console.log(`Segments: ${segments.length}\n`);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const dur = seg.end_ts - seg.start_ts;
      console.log(`--- Segment ${i} (${dur}ms, ${seg.events.length} events) ---`);
      console.log(seg.stripped_text);
      console.log();
    }
  });

// ---- classify subcommand ----

program
  .command("classify")
  .description("Classify segments of a recorded transcript into tool states")
  .requiredOption("--transcript <path>", "Path to the JSONL transcript")
  .option("--profile <tool-id>", "Use an existing profile for indicator matching")
  .action(async (opts) => {
    const events = await parseTranscript(opts.transcript);
    const segments = segmentByFrames(events);

    let profile = undefined;
    if (opts.profile) {
      profile = await loadProfile(opts.profile) ?? undefined;
      if (profile) {
        console.log(`Using profile: ${opts.profile} (confidence: ${profile.confidence.toFixed(2)})`);
      }
    }

    const llmClient = createLLMClient();
    const classified = await classifySegments(segments, profile, llmClient);

    console.log(`\nTranscript: ${opts.transcript}`);
    console.log(`Segments: ${classified.length}\n`);

    for (let i = 0; i < classified.length; i++) {
      const seg = classified[i];
      const dur = seg.end_ts - seg.start_ts;
      const stateTag = seg.state.toUpperCase().padEnd(10);
      const confTag = `(${(seg.confidence * 100).toFixed(0)}%)`.padStart(6);
      const textPreview = seg.stripped_text.substring(0, 100).replace(/\n/g, " ").trim();

      console.log(`[${i}] ${stateTag} ${confTag} | ${dur}ms | ${seg.reason}`);
      console.log(`     "${textPreview}..."`);
      console.log();
    }
  });

// ---- discover subcommand ----

program
  .command("discover")
  .description("Discover a CLI tool's capabilities by parsing its help output")
  .requiredOption("--command <path>", "Path to the CLI tool binary")
  .action(async (opts) => {
    const llmClient = createLLMClient();
    console.log(`[discover] Command: ${opts.command}`);
    if (llmClient) console.log("[discover] LLM enabled for structured parsing");

    const discovery = await discoverTool(opts.command, llmClient);

    if (!discovery) {
      console.error("[discover] Could not extract help information.");
      process.exit(1);
    }

    console.log(`\n[discover] Description: ${discovery.parsed_description}`);
    console.log(`[discover] Interactive: ${discovery.interactive}`);
    console.log(`[discover] Subcommands: ${discovery.subcommands.length}`);
    for (const sc of discovery.subcommands.slice(0, 15)) {
      console.log(`  ${sc.name.padEnd(20)} ${sc.description}`);
    }
    console.log(`[discover] Common flags: ${discovery.common_flags.join(", ")}`);

    if (llmClient) {
      const usage = llmClient.getUsage();
      console.log(`\n[discover] LLM usage: ${usage.calls} calls, ${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens`);
    }
  });

// ---- learn subcommand ----

program
  .command("learn")
  .description("Run the forced learning loop: probe a CLI tool, build a profile")
  .requiredOption("--tool <id>", "Tool identifier (used for profile filename)")
  .requiredOption("--command <path>", "Path to the CLI tool binary")
  .option("--args <args>", "Default arguments (space-separated)", "")
  .option("--rounds <n>", "Maximum probe rounds", "4")
  .option("--settle-timeout <ms>", "Silence threshold in ms", "5000")
  .option("--max-probe <ms>", "Max duration per probe session", "45000")
  .option("--confidence <threshold>", "Confidence threshold to stop learning", "0.8")
  .option("--mode <mode>", "Interaction mode: interactive (default) or args", "interactive")
  .option("--heal <mode>", "Healing mode: off (default), auto, manual", "off")
  .option("--max-heal-rounds <n>", "Maximum healing rounds", "4")
  .option("--resume", "Resume a previously interrupted learn session")
  .action(async (opts) => {
    const toolId = opts.tool;
    const command = opts.command;
    const args = opts.args ? opts.args.split(" ").filter(Boolean) : [];
    const maxRounds = parseInt(opts.rounds, 10);
    let settleMs = parseInt(opts.settleTimeout, 10);
    let maxProbeMs = parseInt(opts.maxProbe, 10);
    const originalSettleMs = settleMs;
    const originalMaxProbeMs = maxProbeMs;
    const threshold = parseFloat(opts.confidence);
    const interactionMode = opts.mode as "interactive" | "args";
    const healMode = opts.heal as "off" | "auto" | "manual";
    const maxHealRounds = parseInt(opts.maxHealRounds, 10);

    const llmClient = createLLMClient();
    const healerLlmClient = healMode !== "off" ? createLLMClient() : null;

    console.log(`[learn] Settings: settleMs=${settleMs}, maxProbeMs=${maxProbeMs}, healMode=${healMode}, maxHealRounds=${maxHealRounds}`);
    console.log(`[learn] Interaction mode: ${interactionMode}`);

    let profile = await loadProfile(toolId);
    if (profile) {
      console.log(`[learn] Loaded existing profile: confidence=${(profile.confidence*100).toFixed(1)}%, patterns=${profile.learned_patterns.length}, probes=${profile.probe_count}`);
    }
    if (!profile) {
      // Run discovery before bootstrapping
      console.log(`[learn] No existing profile. Running discovery...`);
      const discovery = await discoverTool(command, llmClient) ?? undefined;
      if (discovery) {
        console.log(`[learn] Discovered: ${discovery.parsed_description.substring(0, 80)}`);
        console.log(`[learn]   Interactive: ${discovery.interactive}, Subcommands: ${discovery.subcommands.length}, Flags: ${discovery.common_flags.length}`);
      } else {
        console.log(`[learn] Discovery returned no results. Bootstrapping with defaults.`);
      }
      profile = bootstrapProfile(toolId, command, interactionMode, discovery);
    }
    profile.interaction_mode = interactionMode;
    profile.launch.default_args = args;

    console.log(`[learn] Tool: ${toolId}`);
    console.log(`[learn] Command: ${command} ${args.join(" ")}`);
    console.log(`[learn] Max rounds: ${maxRounds}, confidence threshold: ${threshold}`);
    if (llmClient) console.log(`[learn] LLM enabled (budget: ${llmClient.getUsage().calls} / call limit)`);

    // ---- Resume / Init learn state ----
    let learnState = opts.resume ? await loadLearnState(toolId) : null;
    if (learnState) {
      if (learnState.status !== "RUNNING") {
        console.log(`[learn] Previous session ${learnState.status}. Nothing to resume.`);
        return;
      }
      console.log(`[learn] Resuming session ${learnState.session_id} from round ${learnState.current_round}`);
      settleMs = learnState.config.settle_timeout_ms;
      maxProbeMs = learnState.config.max_probe_session_ms;
    } else {
      learnState = initLearnState(toolId, command, {
        maxRounds,
        confidenceThreshold: threshold,
        settleTimeoutMs: settleMs,
        maxProbeSessionMs: maxProbeMs,
        healMode,
        maxHealRounds,
      });
    }

    const classifiedRuns: Array<{
      transcript_path: string;
      segments: import("./types.js").ClassifiedSegment[];
    }> = [];
    const completedProbes: ProbeResult[] = [];
    let prevConfidence = profile.confidence;
    let healRoundsUsed = learnState.healing_rounds.length;
    const confidenceHistory: number[] = [...learnState.confidence_history];
    let healerSuggestion: PlannedProbe | undefined;
    const startRound = learnState.current_round;

    for (let round = startRound; round < maxRounds; round++) {
      const planned = await planNextProbe(profile, completedProbes, llmClient, healerSuggestion);
      healerSuggestion = undefined;
      const sessionId = `${toolId}-probe-${round}-${Date.now()}`;

      console.log(`\n[learn] === Round ${round + 1}/${maxRounds}: ${planned.strategy} ===`);
      console.log(`[learn] Rationale: ${planned.rationale}`);
      if (planned.expected_outcome) console.log(`[learn] Expected: ${planned.expected_outcome}`);

      const config = createSessionConfig({
        command,
        args,
        settle_timeout_ms: settleMs,
        max_session_ms: maxProbeMs,
        session_dir: PROJECT_ROOT,
        session_id: sessionId,
      });

      console.log(`[learn] Session config: settle=${settleMs}ms, maxProbe=${maxProbeMs}ms`);
      console.log(`[learn] Transcript: ${config.transcript_path}`);

      const probeStartTime = Date.now();
      const session = new Session(config);

      try {
        await session.start();
        await executeProbeStrategy(session, planned.strategy, planned.input_text, maxProbeMs);
      } finally {
        await session.cleanup();
      }
      console.log(`[learn] Probe completed in ${((Date.now() - probeStartTime) / 1000).toFixed(1)}s`);

      // Parse and classify
      try {
        const events = await parseTranscript(config.transcript_path);
        const segments = segmentByFrames(events);
        const classified = await classifySegments(segments, profile, llmClient);

        classifiedRuns.push({
          transcript_path: config.transcript_path,
          segments: classified,
        });

        completedProbes.push({
          round,
          strategy: planned.strategy,
          input_text: planned.input_text,
          transcript_path: config.transcript_path,
          classified_segments: classified,
          rationale: planned.rationale,
        });

        console.log(`[learn] Classified ${classified.length} segments:`);
        for (const seg of classified) {
          const preview = seg.stripped_text.substring(0, 60).replace(/\n/g, " ").trim();
          console.log(`  ${seg.state.toUpperCase().padEnd(10)} (${(seg.confidence * 100).toFixed(0)}%) "${preview}..."`);
        }
      } catch (e) {
        console.log(`[learn] Failed to parse transcript: ${e}`);
        continue;
      }

      // Extract patterns and merge
      const patterns = extractPatterns(classifiedRuns);
      profile = mergeLearnedPatterns(profile, patterns, {
        terminal_cols: process.stdout.columns ?? 80,
        terminal_rows: process.stdout.rows ?? 24,
      });

      // Register structural indicators (e.g., silence_after_output_ms for ready state)
      profile = registerStructuralIndicators(profile, classifiedRuns);

      console.log(`[learn] Profile confidence: ${(profile.confidence * 100).toFixed(1)}% (${profile.learned_patterns.length} patterns)`);

      confidenceHistory.push(profile.confidence);

      // Checkpoint learn state
      learnState.current_round = round + 1;
      learnState.confidence_history = confidenceHistory;
      learnState.completed_probes.push({
        round,
        strategy: planned.strategy,
        input_text: planned.input_text,
        transcript_path: config.transcript_path,
        states_observed: classifiedRuns[classifiedRuns.length - 1]?.segments.map((s) => s.state) ?? [],
      });
      learnState.config.settle_timeout_ms = settleMs;
      learnState.config.max_probe_session_ms = maxProbeMs;
      await checkpointLearnState(learnState);

      if (profile.confidence >= threshold) {
        console.log(`[learn] Confidence threshold reached. Converged.`);
        learnState.status = "COMPLETED";
        await checkpointLearnState(learnState);
        break;
      }

      // ---- Healing check ----
      const delta = profile.confidence - prevConfidence;
      prevConfidence = profile.confidence;

      if (
        healMode !== "off" &&
        round > 0 &&
        delta < 0.02 &&
        healRoundsUsed < maxHealRounds
      ) {
        console.log(`\n[heal] Confidence delta ${(delta * 100).toFixed(1)}% < 2% -- invoking healer`);
        const diagnosis = diagnoseLearnFailures(completedProbes, profile);
        const signatures = diagnosis.map((d) => d.signature);
        console.log(`[heal] Failure signatures: ${signatures.length}`);
        for (const d of diagnosis) console.log(`  [${d.failure_class}] ${d.detail}`);

        // Check for repeated signatures (non-convergent)
        // Compare against the most recent heal round, not the cumulative set.
        // If the set shrank or changed composition, that's progress -- continue.
        const prevHealRound = learnState.healing_rounds.length > 0
          ? learnState.healing_rounds[learnState.healing_rounds.length - 1]
          : null;
        const isNonConvergent = prevHealRound !== null &&
          signatures.length > 0 &&
          signatures.length === prevHealRound.failure_signatures.length &&
          signatures.every((s) => prevHealRound.failure_signatures.includes(s));
        if (isNonConvergent) {
          console.log(`[heal] Same failure signatures as previous heal round -- non-convergent. Stopping.`);
          learnState.status = "COMPLETED";
          learnState.abort_reason = "Non-convergent: same failure signatures after healing";
          await checkpointLearnState(learnState);
          break;
        }
        for (const s of signatures) {
          if (!learnState.failure_signatures_seen.includes(s)) {
            learnState.failure_signatures_seen.push(s);
          }
        }

        const latestProbe = completedProbes[completedProbes.length - 1];
        const latestRawText = latestProbe
          ? latestProbe.classified_segments.map((s) => s.stripped_text).join("\n")
          : "";

        const healCtx: HealerContext = {
          profile,
          completedProbes,
          confidenceHistory,
          failureSignatures: signatures,
          diagnosticLines: latestRawText ? extractDiagnosticLines(latestRawText) : undefined,
          config: { settle_timeout_ms: settleMs, max_probe_session_ms: maxProbeMs },
        };

        const decision = await heal(healCtx, healerLlmClient);
        console.log(`[heal] Decision: ${decision.decision} (${decision.failure_class})`);
        console.log(`[heal] Root cause: ${decision.root_cause}`);

        learnState.healing_rounds.push({
          round,
          failure_signatures: signatures,
          decision: decision.decision,
          patches_applied: decision.patches.length,
          timestamp: new Date().toISOString(),
        });
        healRoundsUsed++;

        if (decision.decision === "STOP") {
          console.log(`[heal] Learning non-convergent. Stopping.`);
          learnState.status = "COMPLETED";
          learnState.abort_reason = decision.root_cause;
          await checkpointLearnState(learnState);
          break;
        }

        if (decision.decision === "ACCEPT_PARTIAL") {
          console.log(`[heal] Accepting partial profile.`);
          learnState.status = "COMPLETED";
          await checkpointLearnState(learnState);
          break;
        }

        // RETRY: apply patches and continue
        if (decision.patches.length > 0) {
          const patched = applyHealPatches(profile, decision, {
            settle_timeout_ms: originalSettleMs,
            max_probe_session_ms: originalMaxProbeMs,
          });
          profile = patched.profile;
          if (patched.configOverrides.settle_timeout_ms) {
            settleMs = patched.configOverrides.settle_timeout_ms;
            console.log(`[heal] Adjusted settle_timeout: ${settleMs}ms`);
          }
          if (patched.configOverrides.max_probe_session_ms) {
            maxProbeMs = patched.configOverrides.max_probe_session_ms;
            console.log(`[heal] Adjusted max_probe_session: ${maxProbeMs}ms`);
          }
        }

        if (decision.suggested_probes && decision.suggested_probes.length > 0) {
          const sp = decision.suggested_probes[0];
          healerSuggestion = {
            strategy: sp.strategy,
            input_text: sp.input_text,
            rationale: sp.rationale,
          };
          console.log(`[heal] Next probe: ${sp.strategy}${sp.input_text ? ` "${sp.input_text}"` : ""} -- ${sp.rationale}`);
        }

        if (decision.learned_rule) {
          console.log(`[heal] Learned rule: ${decision.learned_rule}`);
        }

        await checkpointLearnState(learnState);
      }
    }

    // Finalize learn state
    if (learnState.status === "RUNNING") {
      learnState.status = "COMPLETED";
    }
    await checkpointLearnState(learnState);

    // Save profile
    const profilePath = await saveProfile(profile);
    console.log(`\n[learn] Profile saved: ${profilePath}`);
    console.log(`[learn] Confidence: ${(profile.confidence * 100).toFixed(1)}%`);
    console.log(`[learn] Learned patterns: ${profile.learned_patterns.length}`);

    for (const pat of profile.learned_patterns.slice(0, 10)) {
      console.log(`  [${pat.classified_as}] "${pat.pattern}" (conf: ${(pat.confidence * 100).toFixed(0)}%)`);
    }

    // Healing summary
    if (healRoundsUsed > 0) {
      console.log(`\n[learn] Healing: ${healRoundsUsed} rounds, ${learnState.failure_signatures_seen.length} unique signatures`);
      if (learnState.abort_reason) console.log(`[learn] Abort reason: ${learnState.abort_reason}`);
    }

    if (llmClient) {
      const usage = llmClient.getUsage();
      console.log(`\n[learn] Worker LLM: ${usage.calls} calls, ${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens`);
    }
    if (healerLlmClient) {
      const usage = healerLlmClient.getUsage();
      console.log(`[learn] Healer LLM: ${usage.calls} calls, ${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens`);
    }
  });

// ---- run subcommand ----

program
  .command("run")
  .description("Drive a CLI tool using a learned profile")
  .requiredOption("--tool <id>", "Tool identifier (must have a learned profile)")
  .requiredOption("--input <text>", "Text input to send to the tool")
  .option("--settle-timeout <ms>", "Silence threshold in ms", "5000")
  .option("--max-session <ms>", "Maximum session duration in ms", "120000")
  .option("--work-dir <path>", "Directory to track for side effects via git")
  .action(async (opts) => {
    const profile = await loadProfile(opts.tool);
    if (!profile) {
      console.error(`[run] No profile found for tool: ${opts.tool}`);
      console.error(`[run] Run 'clr learn --tool ${opts.tool} --command <path>' first.`);
      process.exit(1);
    }

    const workDir = opts.workDir ? resolve(opts.workDir) : undefined;

    console.log(`[run] Tool: ${opts.tool} (confidence: ${(profile.confidence * 100).toFixed(1)}%)`);
    console.log(`[run] Input: "${opts.input}"`);
    console.log(`[run] Command: ${profile.tool_command} ${profile.launch.default_args.join(" ")}`);
    if (workDir) console.log(`[run] Tracking side effects: ${workDir}`);

    const result = await drive(profile, {
      input: opts.input,
      settle_timeout_ms: parseInt(opts.settleTimeout, 10),
      max_session_ms: parseInt(opts.maxSession, 10),
      workDir,
    });

    console.log(`\n[run] === Result ===`);
    console.log(`[run] Success: ${result.success}`);
    console.log(`[run] Final state: ${result.final_state}`);
    console.log(`[run] Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
    console.log(`[run] Transcript: ${result.transcript_path}`);

    if (result.state_diff) {
      const diff = result.state_diff;
      console.log(`[run] Side effects: ${diff.diff_summary}`);
      if (diff.new_files.length > 0) console.log(`[run]   New: ${diff.new_files.join(", ")}`);
      if (diff.modified_files.length > 0) console.log(`[run]   Modified: ${diff.modified_files.join(", ")}`);
      if (diff.deleted_files.length > 0) console.log(`[run]   Deleted: ${diff.deleted_files.join(", ")}`);
    }

    console.log(`[run] Output:\n`);
    console.log(result.output);
  });

// ---- Shared helpers ----

async function executeProbeStrategy(
  session: Session,
  strategy: import("./types.js").ProbeStrategy,
  inputText: string | undefined,
  maxMs: number,
): Promise<void> {
  switch (strategy) {
    case "observe":
      console.log("[probe] Strategy: observe (passive, wait for settle)");
      await waitForSettledAndExit(session, maxMs);
      break;
    case "enter":
      console.log("[probe] Strategy: enter (send enter after settle)");
      await waitForSettled(session, maxMs);
      console.log("[probe] Sending enter...");
      session.sendEnter();
      await waitForSettledAndExit(session, maxMs);
      break;
    case "input": {
      const text = inputText ?? "hello";
      console.log(`[probe] Strategy: input (send "${text}" after settle)`);
      await waitForSettled(session, maxMs);
      console.log(`[probe] Sending '${text}'...`);
      session.sendText(text + "\r");
      await waitForSettledAndExit(session, maxMs);
      break;
    }
    case "custom": {
      // Custom strategy for side-effect probes: send input, wait for settle
      // (which may be a permission prompt), send affirmative response, then
      // wait for final settle and exit. This navigates:
      //   ready -> working/thinking -> prompting -> working -> completed
      const text = inputText ?? "hello";
      console.log(`[probe] Strategy: custom (send "${text}", handle prompts)`);
      await waitForSettled(session, maxMs);
      console.log(`[probe] Sending '${text}'...`);
      session.sendText(text + "\r");

      // Wait for next settle -- may be a permission prompt or completion
      console.log("[probe] Waiting for response/prompt...");
      await waitForSettled(session, maxMs);

      if (!session.done) {
        // Tool settled but didn't exit -- likely a permission prompt.
        // Send affirmative response to navigate through it.
        console.log("[probe] Sending affirmative 'y' to potential prompt...");
        session.sendText("y\r");
        // Wait for the action to complete
        await waitForSettledAndExit(session, maxMs);
      }
      break;
    }
    case "prompt_response":
      // Send a side-effect command that triggers a permission prompt,
      // then respond affirmatively to capture the prompting state.
      console.log("[probe] Strategy: prompt_response (trigger and navigate permission prompt)");
      await waitForSettled(session, maxMs);
      console.log("[probe] Sending side-effect command...");
      session.sendText("write the word 'test' to /tmp/clr-probe-test.txt\r");
      console.log("[probe] Waiting for permission prompt...");
      await waitForSettled(session, maxMs);
      if (!session.done) {
        console.log("[probe] Sending affirmative response...");
        session.sendText("y\r");
        await waitForSettledAndExit(session, maxMs);
      }
      break;
  }
}

async function waitForSettled(session: Session, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  const startTime = Date.now();
  let eventCount = 0;
  console.log(`[wait] waitForSettled: maxMs=${maxMs}`);
  while (!session.done && Date.now() < deadline) {
    const remaining = Math.min(maxMs, deadline - Date.now());
    const event = await session.nextEvent(remaining);
    eventCount++;
    if (event.type === "settled") {
      console.log(`[wait] Settled after ${eventCount} events, ${Date.now() - startTime}ms`);
      return;
    }
    if (event.type === "exit") {
      console.log(`[wait] Exit after ${eventCount} events, ${Date.now() - startTime}ms`);
      return;
    }
  }
  console.log(`[wait] waitForSettled timed out after ${eventCount} events, ${Date.now() - startTime}ms (done=${session.done})`);
}

async function waitForSettledAndExit(session: Session, maxMs: number): Promise<void> {
  console.log(`[wait] waitForSettledAndExit: maxMs=${maxMs}`);
  await waitForSettled(session, maxMs);
  if (!session.done) {
    console.log(`[wait] Not done after settle -- sending ctrl-c x2`);
    session.sendCtrlC();
    await new Promise((r) => setTimeout(r, 500));
    session.sendCtrlC();
    // Wait for exit
    const deadline = Date.now() + 5000;
    let exitWaitEvents = 0;
    while (!session.done && Date.now() < deadline) {
      const event = await session.nextEvent(1000);
      exitWaitEvents++;
      if (event.type === "exit") {
        console.log(`[wait] Exit received after ${exitWaitEvents} events`);
        break;
      }
    }
    if (!session.done) console.log(`[wait] Exit wait timed out after ${exitWaitEvents} events`);
  } else {
    console.log(`[wait] Session already done after settle`);
  }
}

// ---- orchestrate subcommand ----

program
  .command("orchestrate")
  .description("Run a manifest of tasks against LLM CLI tools using learned profiles")
  .requiredOption("--manifest <path>", "Path to task manifest JSON")
  .option("--resume", "Resume a previously interrupted run")
  .option("--concurrency <n>", "Override policy concurrency", "1")
  .option("--dry-run", "Print task plan without executing")
  .option("--state-dir <path>", "Directory for state files", "./state")
  .option("--llm-budget <n>", "Max LLM calls for healer", "20")
  .option("--status", "Print current state summary and exit")
  .action(async (opts) => {
    const { loadManifest } = await import("./orchestration/manifest.js");
    const { loadOrInitState, initState } = await import("./orchestration/state.js");
    const { Orchestrator } = await import("./orchestration/orchestrator.js");
    const { DEFAULT_POLICY } = await import("./orchestration/types.js");

    const manifestPath = resolve(opts.manifest);
    const stateDir = resolve(opts.stateDir);
    await mkdir(stateDir, { recursive: true });

    const manifest = await loadManifest(manifestPath);
    const policy = {
      ...DEFAULT_POLICY,
      ...manifest.policy,
      concurrency: parseInt(opts.concurrency, 10),
    };

    const statePath = join(stateDir, "state.json");
    const transcriptDir = join(PROJECT_ROOT, "transcripts");

    if (opts.status) {
      const { readFile } = await import("node:fs/promises");
      try {
        const raw = await readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        console.log(`Run: ${state.run_id} (${state.run_status})`);
        console.log(`Updated: ${state.updated_at}`);
        const counts: Record<string, number> = {};
        for (const ts of Object.values(state.tasks) as Array<{ status: string }>) {
          counts[ts.status] = (counts[ts.status] ?? 0) + 1;
        }
        for (const [status, count] of Object.entries(counts)) {
          console.log(`  ${status}: ${count}`);
        }
        console.log(`Healing rounds: ${state.healing_rounds?.length ?? 0}`);
      } catch {
        console.log("No state file found.");
      }
      return;
    }

    if (opts.dryRun) {
      console.log(`[dry-run] Manifest: ${manifestPath}`);
      console.log(`[dry-run] Tasks: ${manifest.tasks.length}`);
      console.log(`[dry-run] Policy: concurrency=${policy.concurrency}, batch=${policy.batch_strategy}, heal=${policy.heal_schedule}`);
      for (const task of manifest.tasks) {
        const deps = task.depends_on.length > 0 ? ` (after: ${task.depends_on.join(", ")})` : "";
        console.log(`  [${task.id}] tool=${task.tool_id} timeout=${task.timeout_sec}s${deps}`);
        console.log(`    input: "${task.input.slice(0, 80)}${task.input.length > 80 ? "..." : ""}"`);
      }
      return;
    }

    const state = opts.resume
      ? await loadOrInitState(statePath, manifest, policy)
      : initState(manifest, policy);

    if (opts.resume) {
      console.log(`[orch] Resuming run ${state.run_id}`);
    }

    const llmClient = createLLMClient({ maxCalls: parseInt(opts.llmBudget, 10) });

    console.log(`[orch] Manifest: ${manifestPath} (${manifest.tasks.length} tasks)`);
    console.log(`[orch] Policy: concurrency=${policy.concurrency}, batch=${policy.batch_strategy}, heal=${policy.heal_schedule}`);
    console.log(`[orch] State: ${statePath}`);
    if (llmClient) console.log(`[orch] Healer LLM: budget=${opts.llmBudget}`);

    const orchestrator = new Orchestrator({
      manifest,
      state,
      statePath,
      llmClient,
      transcriptDir,
    });

    await orchestrator.run();
  });

program.parse();
