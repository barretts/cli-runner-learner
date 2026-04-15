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
  for (const helpArgs of HELP_ARG_VARIANTS) {
    const helpText = await captureHelpOutput(command, helpArgs);
    if (!helpText || helpText.length < 20) continue;

    if (llmClient && !llmClient.exhausted) {
      try {
        const prompt = buildToolDiscoveryPrompt(helpText);
        const raw = await llmClient.complete(prompt.system, prompt.user);
        const parsed = parseToolDiscovery(raw);
        if (parsed) {
          return {
            help_text: helpText,
            parsed_description: parsed.parsed_description,
            subcommands: parsed.subcommands,
            common_flags: parsed.common_flags,
            interactive: parsed.interactive,
            discovered_at: new Date().toISOString(),
          };
        }
      } catch {
        // LLM failed -- fall through to regex
      }
    }

    // Regex fallback: extract basic structure from help text
    return regexDiscovery(helpText);
  }

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

  const session = new Session(config);
  let output = "";

  try {
    await session.start();

    const deadline = Date.now() + 10000;
    while (!session.done && Date.now() < deadline) {
      const event = await session.nextEvent(5000);
      if (event.type === "output" && event.data) {
        const text = Buffer.from(event.data, "hex").toString("utf-8");
        output += deepStripTuiArtifacts(stripTermEscapes(text));
      }
      if (event.type === "exit" || event.type === "settled") break;
    }
  } finally {
    await session.cleanup();
  }

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
