# pi-herdr-subagent

Visible herdr-based subagents for pi.

## Features

- Spawn 2-4 visible subagents in sibling herdr panes
- Track subagent status by pane
- Collect structured results from subagent sessions
- Bundled skill for supervisor-style workflows

## Included tools

- `herdr_subagents_spawn`
- `herdr_subagents_status`
- `herdr_subagents_collect`

## Install

```bash
pi install https://github.com/hisetu/pi-herdr-subagent
```

## Notes

- Works only inside herdr-managed panes
- First version keeps the model simple: one role per spawn call (`research` or `implement`)
