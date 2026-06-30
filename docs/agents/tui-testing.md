# Testing pit interactive mode with tmux

> Moved out of `AGENTS.md` to keep the model's per-turn project context lean.
> Loaded on demand only when you are debugging the TUI directly.

To test pit's TUI in a controlled terminal environment:

```bash
# Create tmux session with specific dimensions
tmux new-session -d -s pit-test -x 80 -y 24

# Start pit (installed globally, or `node dist/cli.js` from a built checkout)
tmux send-keys -t pit-test "pit" Enter

# Wait for startup, then capture output
sleep 3 && tmux capture-pane -t pit-test -p

# Send input
tmux send-keys -t pit-test "your prompt here" Enter

# Send special keys
tmux send-keys -t pit-test Escape
tmux send-keys -t pit-test C-o  # ctrl+o

# Cleanup
tmux kill-session -t pit-test
```

> **Windows (no native tmux):** drive the real TUI via computer-use against a
> pre-configured terminal, or run the tmux flow above under WSL. Headless render
> checks (no TTY) go through the `@pit/tui` `VirtualTerminal` in tests.
