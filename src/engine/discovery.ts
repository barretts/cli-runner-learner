import type { ToolDiscovery } from "../types.js";
import type { LLMClient } from "../llm/client.js";
import { Session, createSessionConfig } from "../runner/session.js";
import { stripTermEscapes, deepStripTuiArtifacts } from "../term-utils.js";
import { buildToolDiscoveryPrompt } from "../llm/prompts.js";
import { parseToolDiscovery } from "../llm/parsers.js";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";

const PROJECT_ROOT = resolve(new URL("../../", import.meta.url).pathname);

const HELP_ARG_VARIANTS = [["--help"], ["-h"], ["help"]];

/**
 * Discover a CLI tool's capabilities by running it with help flags.
 * Tries --help, -h, and help in sequence until one produces output.
 * If an LLM client is available, parses the help text into structured data.
 * Falls back to regex extraction without LLM.
 */
export async function discoverTool(
  command: string,
  llmClient: LLMClient | null,
): Promise<ToolDiscovery | null> {
  console.log(`[discovery] Starting discovery for command: ${command}`);
  console.log(`[discovery] Help arg variants to try: ${HELP_ARG_VARIANTS.map(a => a.join(' ')).join(', ')}`);
  console.log(`[discovery] LLM available: ${!!llmClient}, exhausted: ${llmClient?.exhausted ?? 'N/A'}`);

  for (const helpArgs of HELP_ARG_VARIANTS) {
    console.log(`[discovery] Trying: ${command} ${helpArgs.join(' ')}`);
    const helpText = await captureHelpOutput(command, helpArgs);
    if (!helpText || helpText.length < 20) {
      console.log(`[discovery]   Result: ${helpText ? `too short (${helpText.length} chars)` : 'no output'}`);
      continue;
    }
    console.log(`[discovery]   Captured ${helpText.length} chars of help text`);
    console.log(`[discovery]   First 200 chars: ${helpText.substring(0, 200).replace(/\n/g, '\\n')}`);

    if (llmClient && !llmClient.exhausted) {
      console.log(`[discovery] Attempting LLM-based parsing...`);
      try {
        const prompt = buildToolDiscoveryPrompt(helpText);
        console.log(`[discovery]   Prompt lengths: system=${prompt.system.length}, user=${prompt.user.length}`);
        const raw = await llmClient.complete(prompt.system, prompt.user);
        console.log(`[discovery]   LLM response: ${raw.length} chars`);
        const parsed = parseToolDiscovery(raw);
        if (parsed) {
          console.log(`[discovery]   LLM parsed successfully: ${parsed.subcommands.length} subcommands, ${parsed.common_flags.length} flags, interactive=${parsed.interactive}`);
          console.log(`[discovery]   Description: ${parsed.parsed_description.substring(0, 120)}`);
          return {
            help_text: helpText,
            parsed_description: parsed.parsed_description,
            subcommands: parsed.subcommands,
            common_flags: parsed.common_flags,
            interactive: parsed.interactive,
            discovered_at: new Date().toISOString(),
          };
        }
        console.log(`[discovery]   LLM parse returned null -- falling through to regex`);
      } catch (e) {
        console.log(`[discovery]   LLM failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    console.log(`[discovery] Using regex fallback`);
    const result = regexDiscovery(helpText);
    console.log(`[discovery]   Regex found: ${result.subcommands.length} subcommands, ${result.common_flags.length} flags`);
    return result;
  }

  console.log(`[discovery] All help variants exhausted -- no discovery data`);
  return null;
}

async function captureHelpOutput(command: string, args: string[]): Promise<string | null> {
  const sessionId = `discovery-${Date.now()}`;
  const transcriptDir = join(PROJECT_ROOT, "transcripts");
  await mkdir(transcriptDir, { recursive: true });

  const config = createSessionConfig({
    command,
    args,
    settle_timeout_ms: 3000,
    max_session_ms: 10000,
    session_dir: PROJECT_ROOT,
    session_id: sessionId,
  });

  console.log(`[discovery] captureHelpOutput: session=${sessionId}, timeout=10s`);
  const session = new Session(config);
  let output = "";
  let eventCount = 0;

  try {
    await session.start();

    const deadline = Date.now() + 10000;
    while (!session.done && Date.now() < deadline) {
      const event = await session.nextEvent(5000);
      eventCount++;
      if (event.type === "output" && event.data) {
        const text = Buffer.from(event.data, "hex").toString("utf-8");
        output += deepStripTuiArtifacts(stripTermEscapes(text));
      }
      if (event.type === "exit" || event.type === "settled") {
        console.log(`[discovery] captureHelpOutput: stopped on ${event.type} after ${eventCount} events`);
        break;
      }
    }
  } finally {
    await session.cleanup();
  }

  console.log(`[discovery] captureHelpOutput: collected ${output.trim().length} stripped chars from ${eventCount} events`);
  return output.trim() || null;
}

/**
 * Basic regex extraction of flags and subcommands from help text.
 */
function regexDiscovery(helpText: string): ToolDiscovery {
  // Extract flags like -f, --flag, --flag=value, --flag <value>
  const flagRe = /(?:^|\s)(-[a-zA-Z](?:,\s*)?|--[a-z][-a-z0-9]*(?:=\S+|\s+<\S+>)?)/gm;
  const flags = new Set<string>();
  for (const m of helpText.matchAll(flagRe)) {
    const flag = m[1].trim().replace(/[,=].*/, "");
    if (flag.startsWith("-")) flags.add(flag);
  }

  // Extract subcommands: lines that look like "  command-name  description"
  const subcommandRe = /^\s{2,4}([a-z][-a-z0-9]+)\s{2,}(.+)/gm;
  const subcommands: Array<{ name: string; description: string; flags: string[] }> = [];
  for (const m of helpText.matchAll(subcommandRe)) {
    subcommands.push({ name: m[1], description: m[2].trim(), flags: [] });
  }

  // Extract first non-empty line as description
  const firstLine = helpText.split("\n").find((l) => l.trim().length > 10)?.trim() ?? "";

  return {
    help_text: helpText,
    parsed_description: firstLine.substring(0, 200),
    subcommands,
    common_flags: [...flags].slice(0, 20),
    interactive: false,
    discovered_at: new Date().toISOString(),
  };
}
