## Interaction Modes

CLI tools operate in one of two modes, which determines how input is delivered:

### Interactive Mode

The tool launches, shows a prompt, and waits for input. Communication happens via PTY (pseudo-terminal):

- **Launch**: `tool` (no arguments needed)
- **Input delivery**: Type into the PTY after the `ready` state is detected
- **Output**: Full-screen TUI re-renders, streaming text, spinner animations
- **Session lifecycle**: startup → ready → (working/thinking cycle) → ready → ... → completed
- **Examples**: crush (interactive), opencode

Interactive tools typically need:
- PTY wrapping (`needs_pty: true`)
- Settle detection to know when output has stopped
- Reduce-motion env vars to suppress animations during automated use
- Keyboard input handling (Tab, Ctrl-C, Esc, arrows)

### Args Mode

The tool takes input as command-line arguments and produces output to stdout:

- **Launch**: `tool run "prompt text"` or `tool --prompt "text"`
- **Input delivery**: Positional argument, flag, or stdin pipe
- **Output**: Stdout text, possibly with ANSI formatting
- **Session lifecycle**: startup → working → completed
- **Examples**: `claude --print`, `crush run`, `cursor --print`

Args-mode tools are simpler to automate but may hide information (tool calls, thinking) that's visible in interactive mode.

### Prompt Delivery

The adapter preset specifies how to pass the prompt:

| `promptDelivery` | How | Example |
|-----------------|-----|---------|
| `stdin` | Pipe to stdin | `echo "prompt" \| claude --print` |
| `positional-arg` | Last CLI argument | `crush run "prompt"` |
| `flag` | Named flag | `cursor --prompt "prompt"` |
