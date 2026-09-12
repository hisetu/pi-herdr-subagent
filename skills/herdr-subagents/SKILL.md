---
name: herdr-subagents
description: >-
  Proactively spawn visible subagents in Herdr panes for non-trivial work that can be split into two or more independent tracks. Use automatically, without waiting for the user to request subagents, for parallel research, multi-module investigation, debugging across layers, independent code review, comparing alternatives, or isolated implementation tasks. Also use when the user asks for agents, parallel work, visible panes, or a supervisor workflow.
---

# herdr-subagents

use this proactively when:

- a task has 2 or more independent workstreams
- investigation spans multiple modules, layers, repositories, APIs, or hypotheses
- debugging benefits from checking separate likely causes in parallel
- review benefits from independent correctness, architecture, security, or performance perspectives
- implementation can be divided into isolated files or components without overlapping edits
- the user wants subagents in separate herdr panes
- transparency matters more than minimal UI noise
- you want one supervisor pane and a few visible worker panes
- the user wants to watch progress directly

Do not wait for the user to explicitly mention subagents when the task clearly meets these conditions.

## prefer this for

- 2 to 4 parallel research tasks
- non-trivial codebase exploration
- root-cause analysis across frontend, backend, infrastructure, or logs
- comparing multiple implementation approaches
- narrow, non-overlapping implementation subtasks
- independent review and verification
- review or investigation work where visual status matters

## first version limits

- keep tasks narrowly scoped
- prefer 2 to 4 panes max
- prefer `research` unless code changes are clearly required
- use a shared default role or set role per task when tasks differ
- available roles are `research`, `implement`, and `review`

## available tools

- `herdr_subagents_spawn`
- `herdr_subagents_status`
- `herdr_subagents_global_status`
- `herdr_subagents_collect`
- `herdr_subagents_interrupt`
- `herdr_subagents_clear`

## role guidance

### research

use for:
- code investigation
- api tracing
- log analysis
- finding evidence

expected result shape:
1. conclusion
2. evidence
3. unknowns

### implement

use for:
- small focused code changes
- isolated refactors
- narrow fixes

expected result shape:
1. changed files
2. summary
3. risks

### review

use for:
- correctness review
- API design review
- migration risk review
- maintainability review

expected result shape:
1. findings
2. severity
3. recommended changes

## suggested flow

1. split the work into a few narrow tasks
2. spawn panes with `herdr_subagents_spawn`
3. inspect progress with `herdr_subagents_status`
4. use `herdr_subagents_global_status` if you need a rough workspace-wide view beyond the current session
5. collect outputs with `herdr_subagents_collect`; completed panes close automatically by default
6. use the built-in lightweight synthesis to quickly scan combined findings and unknowns
7. interrupt a stuck pane with `herdr_subagents_interrupt` if needed
8. use `herdr_subagents_clear` only for leftover, interrupted, or intentionally retained panes
9. synthesize the final answer in the supervisor pane when more refinement is needed

## examples

spawn 2 research panes:
- inspect auth token flow in the postman collection
- inspect where ssid is generated and consumed in the android app

spawn mixed-role panes:
- `research`: inspect auth token flow in the postman collection
- `review`: review auth/session refactor for API design and migration risk
- `implement`: fix one compose state bug

## when not to use

do not use this when:
- the task is tiny and does not benefit from parallelism
- the user explicitly asks not to open panes or not to use subagents
- the work is highly coupled and requires constant shared context
- parallel workers would edit the same files or depend on one another's unfinished output

## herdr CLI reference

> For full pane/tab/workspace/agent CLI operations, see the **herdr-ops** skill.

## practical tips

- the first worker opens to the supervisor's right; later workers are distributed breadth-first inside that right-side worker area without splitting the supervisor again
- before creating panes, spawn validates every requested `provider/model` ID against Pi's currently available model catalog
- each worker starts with jcode first; if jcode startup fails, spawn falls back to pi for that worker
- each worker receives a unique Herdr agent name based on its role, batch, and position
- use `latestOnly: true` when you only want the newest spawned batch
- use per-task roles when one batch mixes investigation and implementation
- use `herdr_subagents_interrupt` if one worker looks stuck
- when a worker finishes, expect a lightweight completion notify in the supervisor pane
- `herdr_subagents_collect` closes and untracks collected `idle` / `done` panes by default; active or blocked panes stay open
- pass `closePanes: false` to collect when you want completed worker panes to remain open
- use `herdr_subagents_clear` to close leftover panes and remove stale tracking; closing is the default
