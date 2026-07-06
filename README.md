# pi-herdr-subagent

Visible herdr-based subagents for pi.

This package lets a supervisor agent spawn a few **real pi subagents in separate herdr panes** so the user can watch progress directly instead of relying on hidden background workers.

## What it does

It adds three tools:

- `herdr_subagents_spawn`
- `herdr_subagents_status`
- `herdr_subagents_collect`
- `herdr_subagents_clear`

It also bundles a `herdr-subagents` skill for supervisor-style pane orchestration.

## Why use this

Use this when you want:

- one main supervisor pane
- 2-4 visible worker panes
- transparent parallel research or implementation work
- a simple fan-out / fan-in workflow inside herdr

This is especially useful when the user wants to **see what each subagent is doing**.

## Features

- Spawn 2-4 visible subagents in sibling herdr panes
- Track subagent status by pane
- Collect structured results from subagent sessions
- Keep the first version simple with only two roles:
  - `research`
  - `implement`
- Support either one shared default role or per-task role overrides

## Requirements

- [pi](https://github.com/earendil-works/pi)
- [herdr](https://github.com/ogulcancelik/herdr)
- The current pi session must be running **inside a herdr pane**

## Install

```bash
pi install https://github.com/hisetu/pi-herdr-subagent
```

Then reload pi:

```text
/reload
```

## Tool reference

### `herdr_subagents_spawn`

Spawn a few visible subagents in sibling panes.

Parameters:

- `tasks: Array<string | { task: string; role?: "research" | "implement" }>` — 1 to 4 task prompts
- `role?: "research" | "implement"` — default role fallback when a task does not specify its own role
- `model?: string` — optional pi model override
- `thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
- `cwd?: string` — working directory for spawned panes

Example:

```json
{
  "tasks": [
    "Inspect auth token flow in the Postman collection.",
    "Inspect where ssid is generated and consumed in the Android app."
  ],
  "role": "research",
  "thinking": "minimal",
  "cwd": "/Users/lucas"
}
```

Mixed-role example:

```json
{
  "tasks": [
    { "task": "Inspect auth token flow in the Postman collection.", "role": "research" },
    { "task": "Fix one focused Compose state bug in the Android app.", "role": "implement" }
  ],
  "thinking": "minimal",
  "cwd": "/Users/lucas"
}
```

### `herdr_subagents_status`

Show tracked subagent panes for the current session.

Parameters:

- `includeDone?: boolean`
- `latestOnly?: boolean` — show only the newest spawned batch

Example:

```json
{
  "includeDone": true
}
```

### `herdr_subagents_collect`

Collect results from tracked subagent panes.

Parameters:

- `wait?: boolean` — wait until panes settle to `idle` / `done`
- `lines?: number` — fallback pane-read line count
- `timeoutMs?: number`
- `latestOnly?: boolean` — collect only the newest spawned batch

Example:

```json
{
  "wait": true,
  "lines": 60,
  "timeoutMs": 180000
}
```

### `herdr_subagents_clear`

Clear tracked subagent panes and optionally close them.

Parameters:

- `closePanes?: boolean`
- `latestOnly?: boolean`

Example:

```json
{
  "closePanes": true,
  "latestOnly": true
}
```

## Roles

### `research`

Best for:

- code investigation
- API tracing
- log analysis
- fact finding

Expected output shape:

- `Conclusion:`
- `Evidence:`
- `Unknowns:`

### `implement`

Best for:

- small focused code changes
- isolated fixes
- narrow refactors

Expected output shape:

- `Changed files:`
- `Summary:`
- `Risks:`

## Recommended workflow

1. Split the work into 2-4 narrow tasks
2. Call `herdr_subagents_spawn`
3. Check progress with `herdr_subagents_status`
4. Collect results with `herdr_subagents_collect`
5. Clear finished tracked panes with `herdr_subagents_clear` when appropriate
6. Synthesize the final answer in the supervisor pane

## Example workflow

### 1. Spawn two research panes

- investigate API host usage
- investigate Android token/session handling

### 2. Check status

Look for which panes are `working`, `idle`, or `done`.

### 3. Collect

Use `wait: true` if you want to gather results only after all workers settle.

## Notes

- This package only works inside herdr-managed panes
- First version supports either **one shared role per spawn call** or **per-task role overrides**
- Collection prefers reading the spawned subagent's **session output**, then falls back to pane output if needed
- Missing panes are automatically pruned from tracked state
- Use `latestOnly: true` when you only want the newest spawned batch

## Future ideas

- collect only the latest batch
- close/clear tracked panes
- support per-task role selection
- richer supervisor summaries
