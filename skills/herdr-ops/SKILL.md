---
name: herdr-ops
description: Herdr terminal workspace CLI operations — pane, tab, workspace, agent, and layout management. Use when the user asks to rename panes, split terminals, move panes, manage agents, read output, resize layout, swap panes, zoom, or perform any herdr CLI operation beyond basic subagent spawning. Triggers: herdr pane, herdr tab, herdr workspace, herdr agent, rename pane, split pane, move pane, swap pane, zoom pane, resize pane, herdr CLI, terminal layout, herdr操作, pane管理.
---

# herdr-ops

Herdr CLI reference for terminal workspace management.

## environment variables

| Variable | Purpose |
|----------|---------|
| `HERDR_PANE_ID` | Current pane ID (set automatically in every herdr pane) |
| `HERDR_TAB_ID` | Current tab ID |
| `HERDR_WORKSPACE_ID` | Current workspace ID |
| `HERDR_ENV` | Set to `1` inside herdr-managed panes |
| `HERDR_SOCKET_PATH` | Low-level socket path override |

## pane operations

### identify current pane

```bash
echo $HERDR_PANE_ID
```

### rename a pane

```bash
herdr pane rename <pane_id> <label>
herdr pane rename <pane_id> --clear
```

### list panes

```bash
herdr pane list
herdr pane list --workspace <workspace_id>
herdr pane get <pane_id>
herdr pane current                    # uses $HERDR_PANE_ID
herdr pane process-info --current     # foreground process info
```

### split a pane

```bash
herdr pane split --direction right              # split focused pane right
herdr pane split --direction down               # split focused pane down
herdr pane split --current --direction right    # split calling pane
herdr pane split <pane_id> --direction right --ratio 0.3 --cwd ~/project --no-focus
```

Response includes `.result.pane.pane_id` for the new pane.

### read output

```bash
herdr pane read <pane_id>                                    # default: recent 80 lines, text
herdr pane read <pane_id> --source visible                   # current screen
herdr pane read <pane_id> --source recent-unwrapped --lines 120  # logs without soft wrap
herdr pane read <pane_id> --format ansi                      # preserve ANSI styling
herdr pane read <pane_id> --source detection                 # agent detection snapshot
```

| Source | Best for |
|--------|----------|
| `visible` | UI feedback loops |
| `recent` | Recent scrollback with wrapping |
| `recent-unwrapped` | Logs and transcripts |
| `detection` | Agent screen detection |

### send input

```bash
herdr pane send-text <pane_id> "some text"     # send text without Enter
herdr pane send-keys <pane_id> enter           # send Enter key
herdr pane send-keys <pane_id> ctrl+c          # interrupt
herdr pane run <pane_id> "ls -la"              # submit command atomically with Enter
```

Key syntax: `enter`, `tab`, `esc`, `backspace`, `left`, `right`, `up`, `down`, `ctrl+c`, `alt+x`, `shift+tab`, `f1`, `minus`, `plus`, `backtick`.

**Prefer `pane run`** over `send-text` + `send-keys enter` for commands.

### wait for output

```bash
herdr pane wait-output <pane_id> --match "ready"                     # literal substring
herdr pane wait-output <pane_id> --regex "error|failed" --timeout 30000
herdr pane wait-output <pane_id> --match "done" --source recent-unwrapped --lines 200
```

Waits indefinitely if `--timeout` is omitted.

### resize and zoom

```bash
herdr pane resize --direction right --amount 0.1     # grow right 10%
herdr pane resize --direction left --amount 0.05
herdr pane zoom --toggle                             # toggle zoom on focused pane
herdr pane zoom <pane_id> --on
herdr pane zoom <pane_id> --off
```

### swap panes

```bash
herdr pane swap --direction right               # swap with right neighbor
herdr pane swap --source-pane ID --target-pane ID
```

### move panes

```bash
herdr pane move <pane_id> --tab <tab_id> --split right
herdr pane move <pane_id> --new-tab --label "server"
herdr pane move <pane_id> --new-workspace --label "debug"
```

After move, use `.result.move_result.pane.pane_id` for new ID.

### navigate neighbors

```bash
herdr pane neighbor --direction left
herdr pane focus --direction right
herdr pane edges --current
herdr pane layout --current
```

### close a pane

```bash
herdr pane close <pane_id>
```

## tab operations

```bash
herdr tab list
herdr tab list --workspace <workspace_id>
herdr tab create --label "tests" --cwd ~/project --no-focus
herdr tab get <tab_id>
herdr tab focus <tab_id>
herdr tab rename <tab_id> <label>
herdr tab close <tab_id>
```

Response includes `.result.tab.tab_id` and `.result.root_pane.pane_id`.

## workspace operations

```bash
herdr workspace list
herdr workspace create --label "api" --cwd ~/project --no-focus
herdr workspace get <workspace_id>
herdr workspace focus <workspace_id>
herdr workspace rename <workspace_id> <label>
herdr workspace close <workspace_id>
```

Response includes `.result.workspace.workspace_id`, `.result.tab.tab_id`, `.result.root_pane.pane_id`.

## worktree operations

```bash
herdr worktree list
herdr worktree create --branch feature/new --base main --label "feature"
herdr worktree open --branch feature/new
herdr worktree remove --workspace ID --force
```

## agent operations

### list and inspect

```bash
herdr agent list
herdr agent get <target>           # target = agent name or pane ID
herdr agent read <target> --source recent-unwrapped --lines 100
herdr agent explain <target>       # show detection info
```

### start an agent

```bash
herdr agent start <name> --kind <KIND> --pane <pane_id> [--timeout MS] [-- <agent-args>]
```

Supported kinds: `pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, `maki`.

Requirements:
- Pane must have an interactive shell with no foreground command
- Name must match `[a-z][a-z0-9_-]{0,31}`
- Name must be unique among live agents

### prompt and wait

```bash
herdr agent prompt <target> "do something"              # fire and forget
herdr agent prompt <target> "do something" --wait       # wait for idle/done/blocked
herdr agent prompt <target> "do something" --wait --until idle --timeout 60000
herdr agent wait <target>                               # wait for idle/done/blocked
herdr agent wait <target> --until idle --timeout 30000
```

Lifecycle states: `idle`, `working`, `blocked`, `done`, `unknown`.
- `idle` = ready after tab was seen in focused UI
- `done` = ready after unseen background work
- `blocked` = approval or question UI detected
- `unknown` = agent present but unclassifiable

### rename and focus

```bash
herdr agent rename <target> new-name
herdr agent rename <target> --clear
herdr agent focus <target>
herdr agent send-keys <target> esc
```

## notifications

```bash
herdr notification show "Build complete" --body "All tests passed" --sound done
herdr notification show "Error" --position top-right --sound request
```

## sessions

```bash
herdr session list
herdr session attach work
herdr session stop default
herdr session delete old-session
```

## integrations

```bash
herdr integration status
herdr integration status --outdated-only
herdr integration install pi
herdr integration uninstall pi
```

## report metadata (advanced)

Display-only metadata without taking over semantic state:

```bash
herdr pane report-metadata <pane_id> \
  --source my-tool \
  --title "Running tests" \
  --state-label working="test suite" \
  --ttl-ms 60000
```

Report agent state from custom hooks:

```bash
herdr pane report-agent <pane_id> \
  --source my-hook \
  --agent pi \
  --state working \
  --message "processing files"
```

## common patterns

### create a worker pane and run a command

```bash
# split right, get new pane ID, run command
NEW_PANE=$(herdr pane split --current --direction right --no-focus | jq -r '.result.pane.pane_id')
herdr pane rename "$NEW_PANE" "test-runner"
herdr pane run "$NEW_PANE" "npm test"
herdr pane wait-output "$NEW_PANE" --match "Tests:" --timeout 60000
```

### start a named agent in a new pane

```bash
NEW_PANE=$(herdr pane split --current --direction right --no-focus | jq -r '.result.pane.pane_id')
herdr agent start my-worker --kind pi --pane "$NEW_PANE"
herdr agent prompt my-worker "investigate the auth flow" --wait
herdr agent read my-worker --source recent-unwrapped --lines 80
```

### move a pane to its own tab

```bash
herdr pane move "$HERDR_PANE_ID" --new-tab --label "isolated"
```

## agent attach (direct terminal)

Attach your current terminal directly to an agent's terminal:

```bash
herdr agent attach <target>
herdr agent attach <target> --takeover   # replace existing attach client
```

- Detach with `ctrl+b q`
- Send literal `ctrl+b` with `ctrl+b ctrl+b`
- Scroll with mouse wheel or `page up`/`page down`
- Use `herdr terminal attach <terminal_id>` for non-agent terminals

## state rollups

Herdr rolls agent state upward in the sidebar:

- **blocked** agent → pane, tab, and workspace all show blocked
- **working** agent → workspace shows active
- **done** agent → stays visible until you view (focus) it

This is the core workflow: start several agents, let them work, use sidebar to see which needs attention.

## alternate-screen caveat

Full-screen agents (Claude Code, OpenCode) may use the alternate screen. Those rows don't enter host scrollback.

If `agent read` with increased `--lines` returns no extra text:
1. Try `--source visible` to read the current rendered page
2. Ask the agent to write its response to a temp Markdown file and return the path
3. Read that file directly

## VM and sandbox wrappers

When a wrapper hides the real agent process:

```bash
HERDR_AGENT=claude fence -- claude              # Linux
HERDR_AGENT=claude nono run --profile claude-code -- claude  # macOS
```

The hint tells Herdr which agent screen manifest to use. Only set it on the wrapper command, not globally.

## session and persistence

### detach and reattach

```bash
# Detach: ctrl+b q
# Reattach:
herdr
herdr --session work
```

Processes keep running while detached. This is the strongest persistence path.

### what survives a server restart

| Item | Survives? |
|------|----------|
| Layout (workspace/tab/pane) | ✅ restored from snapshot |
| Running processes | ❌ gone |
| Pane screen history | ⚠️ only if `pane_history = true` |
| Agent conversations | ⚠️ only with native session restore |

Enable pane history (stores output, may include secrets):

```toml
# ~/.config/herdr/config.toml
[experimental]
pane_history = true
```

### native agent session restore

Enabled by default. After server restart, Herdr resumes agent panes using integration-reported session IDs.

Check integration versions:

```bash
herdr integration status
herdr integration install pi    # reinstall if outdated
```

Disable with:

```toml
[session]
resume_agents_on_restore = false
```

### live handoff (experimental)

```bash
herdr update --handoff          # keep processes alive across update
herdr --remote workbox --handoff
```

## plugins

```bash
herdr plugin install <owner>/<repo>[/subdir] [--ref REF] [--yes]
herdr plugin list [--json]
herdr plugin uninstall <plugin_id>
herdr plugin enable <plugin_id>
herdr plugin disable <plugin_id>
herdr plugin link <path>              # local development
herdr plugin unlink <plugin_id>
herdr plugin action list
herdr plugin action invoke <action_id>
herdr plugin pane open --plugin ID --entrypoint ID [--placement overlay|popup|split|tab|zoomed]
herdr plugin config-dir <plugin_id>   # stable config path for .env files
herdr plugin log list [--plugin ID]
```

## troubleshooting

### diagnostics

```bash
herdr -V
herdr status
herdr agent explain <target>          # why is detection wrong?
herdr agent explain --file screen.txt --agent codex --json
```

### log locations

```
~/.config/herdr/herdr.log
~/.config/herdr/herdr-client.log
~/.config/herdr/herdr-server.log
```

Set `HERDR_LOG=herdr=debug` for more detail.

### common issues

| Problem | Fix |
|---------|-----|
| Updated but session is old | `herdr server stop` then `herdr` |
| `herdr` not found | Restart terminal, check PATH |
| Agent state wrong | `herdr agent explain <target>` |
| Double keypress (Enter/Tab) | Update outer terminal (kitty≥0.33, foot≥1.20, alacritty≥0.15) |
| CJK IME misplaced (Windows) | Set `[ui] host_cursor = "native"` |
| Option+arrows inserts `;3D` | Add zsh `bindkey` or kitty key map |

### reload config without restart

```bash
herdr server reload-config
```

### reload agent detection manifests

```bash
herdr server update-agent-manifests   # fetch remote + reload
herdr server reload-agent-manifests   # reload local overrides only
```

Local manifest overrides: `~/.config/herdr/agent-detection/<agent>.toml`

## tips

- Always use `--no-focus` when creating layout for background work
- Use `pane run` instead of `send-text` + `send-keys enter`
- Use `recent-unwrapped` source for reading logs and transcripts
- After `pane move`, the pane ID changes — use the response `.result.move_result.pane.pane_id`
- `--current` resolves from `$HERDR_PANE_ID` of the calling shell
- Agent names follow the terminal even after `pane move`
- `herdr pane wait-output` checks existing output immediately, then polls
- Timeout is in milliseconds; omit for indefinite wait
- `workspace close` only closes Herdr state; `worktree remove` deletes the Git checkout
- Use `herdr notification show` with `--sound done` to notify when background work finishes
- Agent `done` state = idle but unseen; focusing the tab or using `agent focus` marks it seen
