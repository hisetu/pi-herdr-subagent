# pi-herdr-subagent

Visible herdr-based subagents for pi.

This package lets a supervisor agent spawn a few **real pi subagents in separate herdr panes** so the user can watch progress directly instead of relying on hidden background workers.

## What it does

It adds three tools:

- `herdr_subagents_spawn`
- `herdr_subagents_status`
- `herdr_subagents_collect`
- `herdr_subagents_interrupt`
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
- Add a lightweight supervisor synthesis on top of per-pane results
- Support lightweight completion notifications when tracked panes finish
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

The output includes:

- a lightweight synthesized summary across the selected panes
- the original per-pane structured results

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

### `herdr_subagents_interrupt`

Interrupt tracked subagent panes.

Parameters:

- `paneId?: string`
- `latestOnly?: boolean`

Example:

```json
{
  "latestOnly": true
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

Research workers are also instructed to:

- keep scope narrow
- stop once they have enough evidence
- fall back quickly if one tool path fails

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
5. Use the built-in lightweight synthesis as a quick supervisor summary
6. Interrupt a stuck pane with `herdr_subagents_interrupt` if needed
7. Clear finished tracked panes with `herdr_subagents_clear` when appropriate
8. Synthesize the final answer in the supervisor pane if more refinement is needed

## Example workflow

### 1. Spawn two research panes

- investigate API host usage
- investigate Android token/session handling

### 2. Check status

Look for which panes are `working`, `idle`, or `done`.

### 3. Collect

Use `wait: true` if you want to gather results only after all workers settle.

## Smoke test

Use this quick checklist after install and `/reload`:

1. Spawn a small batch

```json
{
  "tasks": [
    { "task": "Inspect auth flow", "role": "research" },
    { "task": "Do not edit files; verify implement contract only", "role": "implement" }
  ],
  "thinking": "minimal",
  "cwd": "/Users/lucas"
}
```

2. Check the latest batch

```json
{
  "includeDone": true,
  "latestOnly": true
}
```

3. Collect the latest batch

```json
{
  "wait": true,
  "latestOnly": true,
  "timeoutMs": 120000
}
```

Expected result:

- a `# Synthesis` block
- per-pane structured output
- research panes using `Conclusion / Evidence / Unknowns`
- implement panes using `Changed files / Summary / Risks`

4. Clear the latest batch and close panes

```json
{
  "latestOnly": true,
  "closePanes": true
}
```

5. Verify cleanup

```json
{
  "includeDone": true,
  "latestOnly": true
}
```

Expected result:

- `No tracked herdr subagents in this session.`

## Notes

- This package only works inside herdr-managed panes
- First version supports either **one shared role per spawn call** or **per-task role overrides**
- Collection prefers reading the spawned subagent's **session output**, then falls back to pane output if needed
- Missing panes are automatically pruned from tracked state
- Use `latestOnly: true` when you only want the newest spawned batch
- The extension shows a lightweight notify when a tracked pane transitions into `idle` or `done`

## Future ideas

- collect only the latest batch
- close/clear tracked panes
- support per-task role selection
- richer supervisor summaries
