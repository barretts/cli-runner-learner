#!/usr/bin/env node

import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Session, createSessionConfig } from "./runner/session.js";
import { parseTranscript, segmentByGaps, segmentByFrames, computeTimingProfile, decodeEventData } from "./engine/transcript.js";
import { stripTermEscapes } from "./term-utils.js";
import { classifySegments, extractTextForState } from "./engine/classifier.js";
import { extractPatterns } from "./engine/pattern-extractor.js";
import { loadProfile, saveProfile, bootstrapProfile, mergeLearnedPatterns } from "./engine/profile-manager.js";
import { drive } from "./runner/driver.js";

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

    const classified = classifySegments(segments, profile);

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
  .action(async (opts) => {
    const toolId = opts.tool;
    const command = opts.command;
    const args = opts.args ? opts.args.split(" ").filter(Boolean) : [];
    const maxRounds = parseInt(opts.rounds, 10);
    const settleMs = parseInt(opts.settleTimeout, 10);
    const maxProbeMs = parseInt(opts.maxProbe, 10);
    const threshold = parseFloat(opts.confidence);
    const interactionMode = opts.mode as "interactive" | "args";

    let profile = await loadProfile(toolId) ?? bootstrapProfile(toolId, command, interactionMode);
    profile.interaction_mode = interactionMode;
    profile.launch.default_args = args;

    console.log(`[learn] Tool: ${toolId}`);
    console.log(`[learn] Command: ${command} ${args.join(" ")}`);
    console.log(`[learn] Max rounds: ${maxRounds}, confidence threshold: ${threshold}`);

    const probeStrategies: Array<{
      name: string;
      action: (session: Session) => Promise<void>;
    }> = [
      {
        name: "observe",
        action: async (session) => {
          // Wait for SETTLED, then ctrl-c to exit
          console.log("[probe] Strategy: observe (passive, wait for settle)");
          await waitForSettledAndExit(session, maxProbeMs);
        },
      },
      {
        name: "enter",
        action: async (session) => {
          // Wait for SETTLED, send enter, wait for next SETTLED, exit
          console.log("[probe] Strategy: enter (send enter after settle)");
          await waitForSettled(session, maxProbeMs);
          console.log("[probe] Sending enter...");
          session.sendEnter();
          await waitForSettledAndExit(session, maxProbeMs);
        },
      },
      {
        name: "input",
        action: async (session) => {
          // Wait for SETTLED, send "hello", wait for next SETTLED, exit
          console.log("[probe] Strategy: input (send text after settle)");
          await waitForSettled(session, maxProbeMs);
          console.log("[probe] Sending 'hello'...");
          session.sendText("hello\r");
          await waitForSettledAndExit(session, maxProbeMs);
        },
      },
      {
        name: "ctrl-c",
        action: async (session) => {
          // Wait for SETTLED, send ctrl-c, record exit behavior
          console.log("[probe] Strategy: ctrl-c (test exit behavior)");
          await waitForSettled(session, maxProbeMs);
          console.log("[probe] Sending ctrl-c...");
          session.sendCtrlC();
          // Wait for another settle or exit
          await waitForSettledAndExit(session, maxProbeMs);
        },
      },
    ];

    const classifiedRuns: Array<{
      transcript_path: string;
      segments: import("./types.js").ClassifiedSegment[];
    }> = [];

    for (let round = 0; round < maxRounds; round++) {
      const strategy = probeStrategies[round % probeStrategies.length];
      const sessionId = `${toolId}-probe-${round}-${Date.now()}`;

      console.log(`\n[learn] === Round ${round + 1}/${maxRounds}: ${strategy.name} ===`);

      const config = createSessionConfig({
        command,
        args,
        settle_timeout_ms: settleMs,
        max_session_ms: maxProbeMs,
        session_dir: PROJECT_ROOT,
        session_id: sessionId,
      });

      const session = new Session(config);

      try {
        await session.start();
        await strategy.action(session);
      } finally {
        await session.cleanup();
      }

      // Parse and classify
      try {
        const events = await parseTranscript(config.transcript_path);
        const segments = segmentByFrames(events);
        const classified = classifySegments(segments, profile);

        classifiedRuns.push({
          transcript_path: config.transcript_path,
          segments: classified,
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

      console.log(`[learn] Profile confidence: ${(profile.confidence * 100).toFixed(1)}% (${profile.learned_patterns.length} patterns)`);

      if (profile.confidence >= threshold) {
        console.log(`[learn] Confidence threshold reached. Converged.`);
        break;
      }
    }

    // Save
    const profilePath = await saveProfile(profile);
    console.log(`\n[learn] Profile saved: ${profilePath}`);
    console.log(`[learn] Confidence: ${(profile.confidence * 100).toFixed(1)}%`);
    console.log(`[learn] Learned patterns: ${profile.learned_patterns.length}`);

    for (const pat of profile.learned_patterns.slice(0, 10)) {
      console.log(`  [${pat.classified_as}] "${pat.pattern}" (conf: ${(pat.confidence * 100).toFixed(0)}%)`);
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
  .action(async (opts) => {
    const profile = await loadProfile(opts.tool);
    if (!profile) {
      console.error(`[run] No profile found for tool: ${opts.tool}`);
      console.error(`[run] Run 'clr learn --tool ${opts.tool} --command <path>' first.`);
      process.exit(1);
    }

    console.log(`[run] Tool: ${opts.tool} (confidence: ${(profile.confidence * 100).toFixed(1)}%)`);
    console.log(`[run] Input: "${opts.input}"`);
    console.log(`[run] Command: ${profile.tool_command} ${profile.launch.default_args.join(" ")}`);

    const result = await drive(profile, {
      input: opts.input,
      settle_timeout_ms: parseInt(opts.settleTimeout, 10),
      max_session_ms: parseInt(opts.maxSession, 10),
    });

    console.log(`\n[run] === Result ===`);
    console.log(`[run] Success: ${result.success}`);
    console.log(`[run] Final state: ${result.final_state}`);
    console.log(`[run] Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
    console.log(`[run] Transcript: ${result.transcript_path}`);
    console.log(`[run] Output:\n`);
    console.log(result.output);
  });

// ---- Shared helpers ----

async function waitForSettled(session: Session, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!session.done && Date.now() < deadline) {
    const event = await session.nextEvent(Math.min(maxMs, deadline - Date.now()));
    if (event.type === "settled") return;
    if (event.type === "exit") return;
  }
}

async function waitForSettledAndExit(session: Session, maxMs: number): Promise<void> {
  await waitForSettled(session, maxMs);
  if (!session.done) {
    session.sendCtrlC();
    await new Promise((r) => setTimeout(r, 500));
    session.sendCtrlC();
    // Wait for exit
    const deadline = Date.now() + 5000;
    while (!session.done && Date.now() < deadline) {
      const event = await session.nextEvent(1000);
      if (event.type === "exit") break;
    }
  }
}

program.parse();
