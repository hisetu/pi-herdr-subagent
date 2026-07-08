---
name: herdr-subagents
description: Spawn simple visible subagents in herdr panes. Use when the user wants parallel pane-based subagents, wants to see each agent in its own pane, or asks for a transparent supervisor-style workflow instead of hidden background subagents.
---

# herdr-subagents

use this when:

- the user wants subagents in separate herdr panes
- transparency matters more than minimal UI noise
- you want one supervisor pane and a few visible worker panes
- the user wants to watch progress directly

## prefer this for

- 2 to 4 parallel research tasks
- narrow implementation subtasks
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
5. collect outputs with `herdr_subagents_collect`
6. use the built-in lightweight synthesis to quickly scan combined findings and unknowns
7. interrupt a stuck pane with `herdr_subagents_interrupt` if needed
8. clear finished tracked panes with `herdr_subagents_clear` when you no longer need them
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
- the user does not care about visible pane-by-pane progress
- the work is highly coupled and requires constant shared context

## practical tips

- use `latestOnly: true` when you only want the newest spawned batch
- use per-task roles when one batch mixes investigation and implementation
- use `herdr_subagents_interrupt` if one worker looks stuck
- when a worker finishes, expect a lightweight completion notify in the supervisor pane
- use `herdr_subagents_clear` to avoid stale tracked panes building up over time
- use `closePanes: true` when you want to close worker panes as part of cleanup
