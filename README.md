# pi-herdr-subagent

[繁體中文](./README.zh-TW.md)

Visible herdr-based subagents for pi.

This package lets a supervisor agent spawn a few **real pi subagents in separate herdr panes** so the user can watch progress directly instead of relying on hidden background workers.

## What it does

It adds these tools:

- `herdr_subagents_spawn`
- `herdr_subagents_status`
- `herdr_subagents_message`
- `herdr_subagents_messages`
- `herdr_subagents_global_status`
- `herdr_subagents_collect`
- `herdr_subagents_interrupt`
- `herdr_subagents_clear`

It also bundles a `herdr-subagents` skill for supervisor-style pane orchestration.

## Why use this

Use this when you want:

- one main supervisor pane
- 1-4 visible worker panes
- transparent parallel research, review, or implementation work
- a simple fan-out / fan-in workflow inside herdr

The bundled prompt guidance proactively uses this workflow for non-trivial tasks with two or more independent tracks; the user does not need to explicitly request subagents.

## Features

- Spawn 1-4 visible subagents in sibling herdr panes
- Start each worker through `herdr agent start` with a unique name such as `research-1-a1b2c3`
- Track subagent status by pane and agent name
- Collect structured results from subagent sessions
- Add a lightweight supervisor synthesis on top of per-pane results
- Support lightweight completion notifications routed back to the supervisor pane when tracked panes finish
- Keep the first version simple with three roles:
  - `research`
  - `implement`
  - `review`
- Support either one shared default role or per-task role overrides

> **Shared-checkout warning:** all `implement` workers use the same checkout. Give them strictly non-overlapping files and edits; do not run parallel implement tasks that can modify the same area.

## Requirements

- [pi](https://github.com/earendil-works/pi)
- [herdr](https://github.com/ogulcancelik/herdr)
- The current pi session must be running **inside a herdr pane**

Session records are stored under `$PI_CODING_AGENT_DIR/extensions/herdr-subagents/sessions` when `PI_CODING_AGENT_DIR` is set, otherwise under the portable `~/.pi/agent` fallback.

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

- `tasks: Array<string | { task: string; role?: "research" | "implement" | "review"; model?: string }>` — 1 to 4 task prompts
- `role?: "research" | "implement" | "review"` — default role fallback when a task does not specify its own role
- `model?: string` — optional default pi model override
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
  "cwd": "/path/to/project"
}
```

Mixed-role example:

```json
{
  "tasks": [
    { "task": "Inspect auth token flow in the Postman collection.", "role": "research", "model": "github-copilot/gpt-5.4" },
    { "task": "Review auth/session refactor for API design and migration risk.", "role": "review", "model": "anthropic/claude-opus-4.7" },
    { "task": "Fix one focused Compose state bug in the Android app.", "role": "implement" }
  ],
  "thinking": "minimal",
  "cwd": "/path/to/project"
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

### `herdr_subagents_message`

Record a structured message and report display metadata on a target pane.

This does **not** deliver the body into the target agent's conversation. It stores a metadata record for inspection and reports display-only pane metadata to herdr.

Parameters:

- `toPaneId: string` — target pane ID
- `body: string` — body stored in the message record
- `kind?: "finding" | "question" | "status" | "ack"` — defaults to `status`
- `fromPaneId?: string` — optional logical sender pane ID
- `messageId?: string` — optional caller-supplied record ID
- `ttlMs?: number` — optional herdr display-metadata TTL

### `herdr_subagents_messages`

Show recent structured message records. These are display metadata records, not agent-conversation messages.

Parameters:

- `paneId?: string` — filter records involving one pane ID
- `limit?: number` — maximum records to return, from 1 to 100

### `herdr_subagents_global_status`

Inspect likely subagent panes in the current herdr workspace, even outside the current session's tracked state.

Parameters:

- `lines?: number`
- `includeAllPiPanes?: boolean`

Example:

```json
{
  "lines": 40
}
```

### `herdr_subagents_collect`

Collect results from tracked subagent panes. After collection, `idle` / `done` panes are closed and untracked by default; active, blocked, or unknown panes remain open.

The output includes:

- a lightweight synthesized summary across the selected panes
- the original per-pane structured results

Parameters:

- `wait?: boolean` — wait until panes settle to `idle` / `done`
- `lines?: number` — fallback pane-read line count
- `timeoutMs?: number`
- `latestOnly?: boolean` — collect only the newest spawned batch
- `closePanes?: boolean` — close collected completed panes; defaults to `true`

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

Close tracked subagent panes and clear their tracking records. Closing is the default; set `closePanes` to `false` only when the panes should remain open.

Parameters:

- `closePanes?: boolean` — defaults to `true`
- `latestOnly?: boolean`

Example that clears tracking but keeps panes open:

```json
{
  "closePanes": false,
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
- avoid repeating tests/analyze when one passing run is already enough
- keep a small tool-action budget before writing the answer

### `implement`

All implement workers share the same checkout. Their assigned files and edit regions must not overlap.

Best for:

- small focused code changes
- isolated fixes
- narrow refactors

Expected output shape:

- `Changed files:`
- `Summary:`
- `Risks:`

### `review`

Best for:

- correctness review
- API design review
- migration risk review
- maintainability review

Expected output shape:

- `Findings:`
- `Severity:`
- `Recommended changes:`

## Recommended workflow

1. Split the work into 2-4 narrow tasks
2. Call `herdr_subagents_spawn`
3. Check progress with `herdr_subagents_status`
4. Collect results with `herdr_subagents_collect`
5. Use the built-in lightweight synthesis as a quick supervisor summary
6. Interrupt a stuck pane with `herdr_subagents_interrupt` if needed
7. Completed panes close automatically after collect; use `herdr_subagents_clear` only for leftovers
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
  "cwd": "/path/to/project"
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
  "latestOnly": true
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
- `herdr_subagents_message` and `herdr_subagents_messages` manage display metadata records; they do not send prompts or content into an agent conversation
- Parallel `implement` workers share one checkout and must never receive overlapping edits
- The first worker opens to the right of the supervisor; later workers are balanced breadth-first only inside that right-side worker area, leaving the supervisor pane untouched
- Use `herdr_subagents_global_status` when you are in a different supervisor/session and still want a rough workspace-wide subagent overview
- First version supports either **one shared role per spawn call** or **per-task role overrides**
- Collection prefers reading the spawned subagent's **session output**, then falls back to pane output if needed
- Status and collection keep missing panes visible as `missing`; cleanup-oriented operations may prune stale tracking
- Use `latestOnly: true` when you only want the newest spawned batch
- The extension sends a lightweight completion notify back to the supervisor pane when a tracked pane transitions into `idle` or `done`

## Future ideas

- richer supervisor summaries
