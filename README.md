# pi-plan-stack

Hierarchical plan/task stack extension for the [Pi coding agent](https://github.com/niclas-niclas/pi-coding-agent). Forces the agent to create structured plans before doing work, then auto-continues through tasks with validation and drift detection.

## Features

- **Hierarchical task trees** — break work into nested sub-tasks with `parent_id`
- **Contract-based tasks** — each task specifies an `expected_output` deliverable
- **Auto-continue** — automatically advances to the next pending task after completion
- **Drift detection** — warns when the agent strays into system paths outside the project
- **Journaling** — every action is logged to `~/.pi/plans/<plan-id>/` for auditability
- **Retry & skip** — stalled tasks are retried up to 3 times, then skipped
- **Intermediate outputs** — save and query results between tasks with `plan:save` / `plan:query`
- **Interactive UI** — themed plan overlay via the `/plan` command

## Installation

```bash
pi install pi-plan-stack
```

## Tools

| Tool | Description |
|------|-------------|
| `plan:push` | Add a task to the plan. Set `goal` on the first call. |
| `plan:pop` | Mark a task as done (current focus or by ID). |
| `plan:save` | Save an intermediate output file for a task. |
| `plan:query` | List or read saved outputs from any task. |

## Commands

| Command | Description |
|---------|-------------|
| `/plan` | Show the interactive plan tree overlay. |
| `/plan:clear` | Reset all tasks and start fresh. |

## How It Works

1. When a user sends a message, the extension injects a directive forcing the agent to plan first using `plan:push`.
2. The agent creates 3-8 tasks with descriptions and expected outputs.
3. Focus automatically moves to the deepest pending leaf (DFS order).
4. After each agent turn, the extension validates that real tool calls were made. If the agent stalls, it retries up to 3 times before skipping.
5. On task completion (`plan:pop`), focus advances to the next pending task and the agent auto-continues.
6. All state is journaled to `~/.pi/plans/` with per-task output directories.

## License

MIT
