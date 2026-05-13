/**
 * Generate a skill markdown file from a learned ToolProfile.
 *
 * The output is a standalone skill document that teaches an agent how to
 * launch, interact with, and interpret the states of a CLI tool.
 */
import { loadAdapterOverrides } from "./adapter-generator.js";
export function generateSkillMarkdown(profile, useOverrides = true) {
    const tool = profile.tool_id;
    const cmd = profile.tool_command;
    const desc = profile.discovery?.parsed_description ?? `CLI tool: ${tool}`;
    const lines = [];
    const ov = useOverrides ? loadAdapterOverrides()[tool] : undefined;
    // --- Frontmatter ---
    lines.push("---");
    lines.push(`name: drive-${tool}`);
    lines.push(`version: "1.0"`);
    lines.push(`description: "How to drive the ${tool} CLI tool. Learned automatically by cli-runner-learner at ${(profile.confidence * 100).toFixed(0)}% confidence."`);
    lines.push("---");
    lines.push("");
    // --- Title & Description ---
    lines.push(`# Driving ${tool}`);
    lines.push("");
    lines.push(desc);
    lines.push("");
    // --- Launch (interactive) ---
    lines.push("## Launch");
    lines.push("");
    lines.push("```bash");
    const launchLine = [cmd, ...profile.launch.default_args].join(" ");
    lines.push(launchLine);
    lines.push("```");
    lines.push("");
    lines.push(`- **Interaction mode**: ${profile.interaction_mode}`);
    lines.push(`- **Needs PTY**: ${profile.launch.needs_pty ? "yes" : "no"}`);
    lines.push(`- **Startup timeout**: ${profile.launch.startup_timeout_sec}s`);
    if (Object.keys(profile.launch.env).length > 0) {
        lines.push(`- **Environment**: ${Object.entries(profile.launch.env).map(([k, v]) => `\`${k}=${v}\``).join(", ")}`);
    }
    if (profile.reduce_motion_env && Object.keys(profile.reduce_motion_env).length > 0) {
        lines.push(`- **Reduce-motion env**: ${Object.entries(profile.reduce_motion_env).map(([k, v]) => `\`${k}=${v}\``).join(", ")}`);
    }
    lines.push("");
    // --- Batch Invocation (from overrides) ---
    if (ov?.defaultArgs && ov.defaultArgs.length > 0) {
        lines.push("## Batch / Non-Interactive Invocation");
        lines.push("");
        lines.push("For automated / orchestrator use:");
        lines.push("");
        lines.push("```bash");
        const batchArgs = [...ov.defaultArgs];
        if (ov.promptDelivery === "positional-arg") {
            lines.push(`${cmd} ${batchArgs.join(" ")} "<prompt>"`);
        }
        else if (ov.promptDelivery === "flag" && ov.promptFlag) {
            lines.push(`${cmd} ${batchArgs.join(" ")} ${ov.promptFlag} "<prompt>"`);
        }
        else {
            lines.push(`echo "<prompt>" | ${cmd} ${batchArgs.join(" ")}`);
        }
        lines.push("```");
        lines.push("");
        lines.push(`- **Prompt delivery**: ${ov.promptDelivery ?? "stdin"}`);
        if (ov.stdinIgnore) {
            lines.push("- **stdin**: must be set to \"ignore\" (tool does NOT read prompts from stdin pipe)");
        }
        lines.push("");
    }
    // --- State Machine ---
    lines.push("## State Machine");
    lines.push("");
    lines.push("The tool moves through these states during a session:");
    lines.push("");
    const stateOrder = ["startup", "ready", "working", "thinking", "prompting", "completed", "error"];
    for (const stateName of stateOrder) {
        const state = profile.states[stateName];
        if (!state)
            continue;
        lines.push(`### ${stateName}`);
        lines.push("");
        lines.push(state.description);
        lines.push("");
        // Indicators
        const globs = state.indicators.filter(i => i.type === "output_glob" && i.pattern);
        const structural = state.indicators.filter(i => i.type !== "output_glob");
        if (globs.length > 0) {
            lines.push("**Recognition patterns** (output globs):");
            lines.push("");
            for (const ind of globs) {
                lines.push(`- \`${ind.pattern}\``);
            }
            lines.push("");
        }
        if (structural.length > 0) {
            lines.push("**Structural indicators**:");
            lines.push("");
            for (const ind of structural) {
                if (ind.type === "silence_after_output_ms") {
                    lines.push(`- Silence after output: ${ind.value}ms`);
                }
                else if (ind.type === "process_exit") {
                    lines.push("- Process exits");
                }
                else if (ind.type === "exit_code_nonzero") {
                    lines.push("- Non-zero exit code");
                }
                else if (ind.type === "continuous_output_rate") {
                    lines.push(`- Continuous output: >${ind.min_chars_per_sec} chars/sec`);
                }
            }
            lines.push("");
        }
        if (state.timeout_sec) {
            lines.push(`**Timeout**: ${state.timeout_sec}s`);
            lines.push("");
        }
    }
    // --- Transitions ---
    lines.push("## Transitions");
    lines.push("");
    lines.push("| From | To | Trigger |");
    lines.push("|------|----|---------|");
    for (const t of profile.transitions) {
        lines.push(`| ${t.from} | ${t.to} | ${t.on} |`);
    }
    lines.push("");
    // --- Timing ---
    lines.push("## Timing");
    lines.push("");
    lines.push(`- **Typical startup**: ${profile.timing.typical_startup_sec}s`);
    lines.push(`- **Idle threshold**: ${profile.timing.idle_threshold_sec}s`);
    lines.push(`- **Max session**: ${profile.timing.max_session_sec}s`);
    lines.push("");
    // --- Prompt Handling ---
    const subPrompts = profile.states.prompting?.sub_prompts ?? [];
    if (subPrompts.length > 0) {
        lines.push("## Sub-Prompts");
        lines.push("");
        lines.push("The tool may ask these questions during operation:");
        lines.push("");
        for (const sp of subPrompts) {
            lines.push(`### ${sp.id}`);
            if (sp.description)
                lines.push(sp.description);
            lines.push("");
            const spGlobs = sp.indicators.filter(i => i.type === "output_glob" && i.pattern);
            if (spGlobs.length > 0) {
                lines.push("**Detect**: " + spGlobs.map(i => `\`${i.pattern}\``).join(", "));
            }
            if (sp.auto_response) {
                lines.push(`**Auto-response**: \`${sp.auto_response}\``);
            }
            lines.push("");
        }
    }
    // --- Subcommands ---
    if (profile.discovery?.subcommands && profile.discovery.subcommands.length > 0) {
        lines.push("## Subcommands");
        lines.push("");
        lines.push("| Command | Description |");
        lines.push("|---------|-------------|");
        for (const sub of profile.discovery.subcommands) {
            lines.push(`| \`${cmd} ${sub.name}\` | ${sub.description} |`);
        }
        lines.push("");
    }
    // --- Flags ---
    if (profile.discovery?.common_flags && profile.discovery.common_flags.length > 0) {
        lines.push("## Common Flags");
        lines.push("");
        for (const flag of profile.discovery.common_flags) {
            lines.push(`- \`${flag}\``);
        }
        lines.push("");
    }
    // --- Forbidden Flags (from overrides) ---
    if (ov?.forbiddenArgs && ov.forbiddenArgs.length > 0) {
        lines.push("## Forbidden Flags");
        lines.push("");
        lines.push("These flags cause failures when used in batch/automated mode:");
        lines.push("");
        for (const entry of ov.forbiddenArgs) {
            lines.push(`- \`${entry.flag}\` — ${entry.reason}`);
        }
        lines.push("");
    }
    // --- Noise Patterns (from overrides) ---
    if (ov?.noisePatterns && ov.noisePatterns.length > 0) {
        lines.push("## Stderr Noise Patterns");
        lines.push("");
        lines.push("These stderr lines are non-actionable and should be filtered from terminal output:");
        lines.push("");
        for (const p of ov.noisePatterns) {
            lines.push(`- \`${p}\``);
        }
        lines.push("");
    }
    // --- Learned Patterns ---
    const patterns = profile.learned_patterns.filter(p => p.confidence >= 0.5);
    if (patterns.length > 0) {
        lines.push("## Learned Patterns");
        lines.push("");
        lines.push("High-confidence patterns extracted from live probing:");
        lines.push("");
        const byState = new Map();
        for (const p of patterns) {
            const arr = byState.get(p.classified_as) ?? [];
            arr.push(p);
            byState.set(p.classified_as, arr);
        }
        for (const [state, pats] of byState) {
            lines.push(`**${state}**:`);
            for (const p of pats.slice(0, 5)) {
                lines.push(`- \`${p.pattern}\` (${(p.confidence * 100).toFixed(0)}%)`);
            }
            lines.push("");
        }
    }
    // --- Operational Notes (from overrides) ---
    if (ov?.notes && ov.notes.length > 0) {
        lines.push("## Operational Notes");
        lines.push("");
        for (const note of ov.notes) {
            lines.push(`- ${note}`);
        }
        lines.push("");
    }
    // --- Metadata ---
    lines.push("## Metadata");
    lines.push("");
    lines.push(`- **Profile confidence**: ${(profile.confidence * 100).toFixed(1)}%`);
    lines.push(`- **Probe count**: ${profile.probe_count}`);
    lines.push(`- **Last updated**: ${profile.last_updated}`);
    if (profile.metadata?.tool_version) {
        lines.push(`- **Tool version**: ${profile.metadata.tool_version}`);
    }
    lines.push("");
    return lines.join("\n");
}
//# sourceMappingURL=skill-generator.js.map