# ctask

A persistent task engine for Claude Code. Tasks, steps, reminders and automations that survive sessions and span every project on your machine, with hooks that keep Claude using it.

Claude's built-in task list disappears with the conversation. ctask does not: every task records its project, the session that owns it, a body, instructions, a status, a due time and a log, in one local SQLite file. Open a new session next week and Claude starts with the list of what is due, in progress and open.

It is not a Jira or Linear replacement. It is Claude's own working memory for work: a step it is in the middle of, a follow-up it promised, a reminder you asked for, a job it should run every morning.

## Requirements

- [Claude Code](https://claude.com/claude-code) (CLI or desktop app)
- Node.js 24 or newer (uses the built-in `node:sqlite`; no npm dependencies)
- macOS for notifications and the background checker. Everything else works on Linux.

## Install

In a terminal:

```bash
claude plugin marketplace add omarabulkhair-66/ctask
```

```bash
claude plugin install ctask@ctask
```

Or inside Claude Code, run `/plugin marketplace add omarabulkhair-66/ctask` and then `/plugin install ctask@ctask`.

Start a new session. That is the whole setup: the plugin puts `ctask` on the session's PATH, loads the hooks and the skill, and installs its own background checker.

To use `ctask` in your own terminal as well, clone the repository and run `npm link` in it.

## Try it

In a new Claude Code session:

1. Ask for something with several steps. Claude creates a task with steps before starting and closes them as it goes.
2. Say "remind me in 5 minutes to review the invoice". You get a macOS notification when it is due, and Claude brings it up in the chat.
3. Close the session halfway through a task, open a new one in the same project and ask "where were we?".
4. From any project, ask "what is open across all my projects?".

Or look at the data yourself:

```bash
ctask list
```

```bash
ctask projects
```

## How Claude is kept on it

A connector alone gives Claude tools it can forget. The hooks are what make it stick.

| Hook | What it does |
| --- | --- |
| SessionStart | Injects the project digest (due now, in progress, open, other projects) and the usage rules. Records the session id. Keeps the background checker installed. |
| UserPromptSubmit | Adds one line to every prompt: the active task, anything due, or a nudge to create a task. |
| Stop | Blocks the end of a turn once if the session has an `in_progress` task it did not touch that turn. |
| PreCompact, SessionEnd | Capture a handoff note from the transcript before context is lost. |

The skill (`skills/ctask/SKILL.md`) teaches Claude when to write and when to read. The MCP server exposes the same engine as tools (`task_add`, `task_list`, `task_get`, `task_update`, `task_next`, `memory_add`, `memory_list`) for surfaces without a shell.

## Handoff notes

Long sessions get compacted and closed sessions forget. Just before either happens, ctask reads the end of the session transcript and saves a handoff: the user's last requests, where Claude left off, the files it edited and its last commands. No model call is involved, so it always happens. The handoff is attached to the session and to any task it had in progress.

The next SessionStart shows it: to the same session after compaction or resume, or to a new session in the same project (up to 14 days later). Claude can also write its own with `ctask handoff <id> "state / what failed / next step"`, which takes priority on that task. Handoffs contain excerpts of your conversation and stay in the local database.

## Project memory

Tasks end; knowledge should not. `ctask remember "Never edit generated/ by hand, run make gen" --kind rule` stores a rule, decision, gotcha or fact for the project (`--global` for every project). Every session that starts there is shown the list, rules first, so you stop explaining the same thing twice. `ctask memory [words]` searches it and `ctask forget m3` removes an entry.

## Evidence before done

The common failure of an agent is saying "done" when it is not. A task or step cannot be marked done without `--note` saying what was run or checked, and `--accept "criteria"` records up front what done means; the criteria are printed if Claude tries to close the task without evidence. Reminders and automations are exempt, and `--force` overrides.

## Dependencies and parallel sessions

`ctask add "Deploy" --after 14,15` makes a task wait. It cannot be started until what it waits on is closed, `ctask next` only offers ready work, and closing a task prints what it unblocked. Cycles are rejected. A task that is in progress in a session active in the last 30 minutes cannot be started by another session, so several sessions can work one project without colliding.

## Code links

At the end of every turn the files Claude edited are attached to the task it was working on, along with the git branch and commit when a task is started or finished. `ctask why src/auth/login.js` then answers "which tasks touched this file, and why". `ctask link <id> --pr URL` adds links by hand.

## Playbooks

A playbook is a saved recipe for work that repeats: a task with ordered steps, instructions and acceptance criteria. Save one from a task that went well with `ctask playbook save release --from 42`, or write it directly with `--title` and `--steps "Bump version; Run tests; Tag and push"`. `ctask playbook run release v2.0 --start` creates the task and its steps, each waiting on the one before. Sessions are shown the playbook names at start, so Claude reaches for them on matching work.

## Review

`ctask review` (`--all` for every project) lists what needs attention: due, waiting on you, blocked, and work in progress that nobody has touched for three days. Once a day the background checker sends the same summary as a notification, at or after `CTASK_REVIEW_AT` (default `09:00`, `off` to disable), and stays quiet when nothing needs you.

## Commands

```text
Create   ctask add <title> [--body T] [--instructions T] [--kind task|step|reminder|automation]
                           [--priority 1|2|3] [--parent ID] [--tags a,b] [--next WHEN] [--every 30m|2h|1d|1w] [--start]
                           [--accept CRITERIA] [--after ID,ID]
Work     ctask start|done|block|wait|cancel|reopen <id> [--note T]
         ctask note <id> <text>
         ctask update <id> [--title --body --instructions --status --priority --next --every ...]
         ctask snooze <id> <WHEN>
Look     ctask list [--all] [--status s1,s2] [--kind K] [--due] [--mine] [--closed] [--tag T] [--limit N] [--page N]
         ctask search <words> [--all] [--archived]
         ctask show <id>
         ctask next | due | projects | context
Know     ctask remember <text> [--kind rule|decision|gotcha|fact] [--global] | memory [words] | forget <mID>
         ctask link <id> [--file a,b] [--commit SHA] [--branch NAME] [--pr URL] | why <file>
         ctask playbook save|run|list|show|rm <name> ...
         ctask review [--all] [--stale DAYS]
Archive  ctask archive [<id>] [--older 30d] [--all] [--dry-run]
         ctask unarchive <id>
```

`WHEN` accepts `now`, `30m`, `2h`, `3d`, `17:30`, `today 17:30`, `tomorrow 9:00`, `2026-12-01 14:00` or an ISO timestamp. Statuses are `todo`, `in_progress`, `blocked`, `waiting` (on the user), `done` and `cancelled`. `ctask help` lists everything; add `--json` for machine-readable output.

## Reminders and automations

- A task with `--next` is a **reminder**. When it comes due it shows a macOS notification, appears in the next prompt's context, and Claude tells you about it. With `--every`, marking it done reschedules it instead of closing it.
- A task with `--kind automation` is run unattended by the background checker with `claude -p` in the task's project, using its body and instructions. Add `--resume` to continue the task's original session instead of starting a fresh one. Headless runs use Claude Code's default permissions and need `claude` to be logged in for the terminal.

## Background checker

On macOS the plugin installs and maintains a launchd agent (`com.ctask.tick`) from the SessionStart hook. Every minute it runs `ctask tick`, which notifies due reminders, runs due automations, and archives closed tasks older than 30 days.

The agent runs a small launcher in `~/.ctask/bin/` rather than the plugin directly, so it keeps working when the plugin is updated to a new version.

`ctask daemon status|uninstall|install` inspects or controls it. After `uninstall` the plugin leaves it off until you run `install`. Its log is `~/.ctask/tick.log`. On Linux, run `ctask tick` from cron.

## Scale

Lists are paged, 50 at a time, and end with `showing a–b of N`. Search matches every word against title, body, instructions, tags and log notes, and includes closed tasks. Hook digests show a fixed number of lines with true totals. With 5,000 tasks, list, search and each hook take about 0.2 seconds, most of it Node starting.

Archived tasks are hidden from lists and search but never deleted. `--archived` brings them back, and reopening a task unarchives it.

## Configuration

| Variable | Effect |
| --- | --- |
| `CTASK_HOME` | Data directory. Default `~/.ctask`. |
| `CTASK_DB` | Path to the database file. |
| `CTASK_STOP_GUARD=off` | Disable the Stop hook check. |
| `CTASK_DAEMON=off` | Do not install the background checker. |
| `CTASK_NOTIFY=off` | No macOS notifications. |
| `CTASK_ARCHIVE_AFTER` | Age at which closed tasks are archived, such as `14d`. Default `30d`; `off` disables it. |
| `CTASK_REVIEW_AT` | Time of the daily review notification. Default `09:00`; `off` disables it. |
| `CTASK_CLAUDE_BIN` | The `claude` executable used for automations. |

## Data and privacy

Everything stays on your machine, in `~/.ctask/ctask.db`. ctask makes no network requests. Automations call your own `claude` CLI.

## Uninstall

```bash
ctask daemon uninstall
```

```bash
claude plugin uninstall ctask@ctask
```

Delete `~/.ctask` to remove the data.

## Develop

```bash
git clone https://github.com/omarabulkhair-66/ctask.git
```

```bash
npm test
```

Layout: `bin/` (entry point and the launcher hooks use), `src/` (engine, CLI, hooks, MCP server, background checker), `hooks/hooks.json`, `skills/ctask/SKILL.md`, `.claude-plugin/` (plugin and marketplace manifests). Point `CTASK_DB` at a scratch file while developing, and load the working copy with `claude --plugin-dir .`.

## License

MIT
