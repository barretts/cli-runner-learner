## The 7-State Model

Every CLI tool learned by cli-runner-learner is modeled as a state machine with these states:

| State | Description | Detection |
|-------|-------------|-----------|
| **startup** | Tool is initializing, loading config, connecting to services | First segment before any user input; matched by startup indicators (banners, version strings) |
| **ready** | Tool is idle and waiting for user input | Silence after output, prompt-like text (e.g. `> Ready...`) |
| **working** | Tool is actively producing output (streaming response, running commands) | High output rate (>10 chars/sec), continuous text flow |
| **thinking** | Tool is processing but not yet producing output (spinner, "Working...") | Thinking labels (`Working...`, `Brrrrr...`, `Processing...`), animation frames |
| **prompting** | Tool is asking the user a question (y/n, confirmation, selection) | Prompt patterns (`Are you sure?`, `(y/n)`, `Press enter to continue`) |
| **completed** | Tool has finished and exited | Process exit event |
| **error** | Tool encountered an error | Non-zero exit code, error patterns in output |

### Transitions

The standard transition graph:

```
startup → ready (tool finished loading)
startup → prompting (tool asks a question during startup)
ready → working (user sends input)
working → thinking (thinking indicator appears)
thinking → working (response content starts streaming)
working → prompting (tool asks a question)
working → ready (response finished, tool idle again)
working → completed (task done, tool exits)
* → error (error at any point)
* → completed (process exit at any point)
```

### Working ↔ Thinking Overlap

In TUI tools (crush, opencode), the **working** and **thinking** states are often intertwined. The tool re-renders the full screen every frame, so thinking labels like `Working...` persist in the chrome while response content streams below. A single transcript segment may contain both thinking indicators AND working content.

The classifier handles this with **bidirectional splitting**: a `thinking` segment with long duration also emits a parallel `working` tag, and a `working` segment containing thinking labels also emits a parallel `thinking` tag. Pattern extraction sees both tags and pulls state-specific n-grams from each.
