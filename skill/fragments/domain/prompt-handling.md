## Prompt Handling

### Sub-Prompts

During operation, CLI tools may ask the user questions that block progress. These are **sub-prompts** — secondary prompts that appear within a session:

- **Permission requests**: "Allow file access? (y/n)"
- **Confirmation dialogs**: "Are you sure you want to quit? Yep! Nope"
- **Selection menus**: "Choose a model: [1] GPT-4 [2] Claude"
- **MCP approvals**: "MCP Server Approval: Allow access?"

Each sub-prompt has:
- **Indicators**: Output patterns that detect the prompt (e.g., `*Are you sure*`)
- **Auto-response**: What to send when detected (e.g., `Yep!`, `y`, `enter`)
- **Type**: `yes_no`, `selection`, `text_input`, `confirmation`, `unknown`

### Sentinel Pattern

For args-mode tools, the **sentinel adapter** injects instructions into the prompt asking the tool to wrap its output in sentinel markers:

```
<TASK_RESULT>
{"status": "DONE", "summary": "..."}
</TASK_RESULT>
```

This gives structured output extraction even from tools that don't natively support it. The sentinel is appended to the user's prompt, and the parser extracts the JSON from between the markers.

### Auto-Response Strategy

When driving a tool automatically:

1. Monitor output for sub-prompt indicators
2. When detected, send the configured auto-response
3. If no auto-response is configured, escalate to the orchestrator
4. Permission prompts default to "yes" in `--yolo` mode, "no" otherwise

The profile's `states.prompting.sub_prompts` array contains all known sub-prompts for a tool, learned from probing sessions where the tool asked questions.
