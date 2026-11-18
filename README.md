# ctask

**A task engine and memory for Claude Code.** Tasks, reminders, automations and project knowledge that survive sessions and span every project on your machine, with hooks that make Claude actually use them.

Claude's built-in task list disappears when the conversation ends. With ctask, you open a new session next week and Claude already knows what is due, what it was in the middle of, what it tried that failed, and the rules of the project.

```text
You:     remind me tomorrow at 9 to send the invoice, and let's start the CSV importer
Claude:  [creates a reminder, creates a task with steps, starts the first step]
...next day, new session...
Claude:  Reminder: send the invoice. The importer is at step 2 of 4; the parser is done,
         streaming failed on Windows paths, next is wiring the tests.
```

It is not a Jira or Linear replacement. It is Claude's own working memory: the step it is on, the follow-up it promised, the reminder you asked for, the job it runs every morning.

## Contents

- [What you get](#what-you-get)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Features](#features)
  - [Tasks and steps](#tasks-and-steps)
  - [Reminders](#reminders)
  - [Automations](#automations)
  - [Handoff notes](#handoff-notes)
  - [Project memory](#project-memory)
  - [Evidence before done](#evidence-before-done)
  - [Dependencies and parallel sessions](#dependencies-and-parallel-sessions)
  - [Code links](#code-links)
  - [Playbooks](#playbooks)
  - [Review](#review)
  - [Search, paging and archive](#search-paging-and-archive)
- [Command reference](#command-reference)
- [Background checker](#background-checker)
- [Configuration](#configuration)
- [Data and privacy](#data-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## What you get

| | |
| --- | --- |
| **Persistent tasks** | Every task keeps its project, owning session, body, instructions, status, due time and a log. |
| **Works across projects** | One local database. Ask "what is open everywhere?" from any project. |
| **Reminders** | A macOS notification when something is due, and Claude raises it in the chat. |
| **Automations** | Recurring work that runs unattended in a headless Claude session. |
| **Handoff notes** | Where a session stood is saved before its context is compacted or it ends. |
| **Project memory** | Rules, decisions and gotchas shown to every session in the project. |
| **Evidence before done** | A task cannot be closed without saying what was checked. |
| **Dependencies** | Tasks wait for each other; parallel sessions do not collide. |
| **Code links** | Which task changed a file, and why. |
| **Playbooks** | Saved recipes for work that repeats. |
| **Enforced, not optional** | Hooks put all of this in front of Claude at the right moments. |

## Install

**Requirements**

- [Claude Code](https://claude.com/claude-code), CLI or desktop app
- Node.js 24 or newer. There are no npm dependencies.
- macOS for notifications and the background checker. Linux has not been tested.

**Install the plugin**

```bash
claude plugin marketplace add omarabulkhair-66/ctask
```

```bash
claude plugin install ctask@ctask
```

Or, inside Claude Code: `/plugin marketplace add omarabulkhair-66/ctask`, then `/plugin install ctask@ctask`.

Start a new session. There is nothing else to set up: the plugin loads its hooks and skill, puts `ctask` on the session's PATH, and installs its own background checker.

**Update**

```bash
claude plugin marketplace update ctask
```

```bash
claude plugin update ctask@ctask
```

**Uninstall**

```bash
ctask daemon uninstall
```

```bash
claude plugin uninstall ctask@ctask
```

Your data stays in `~/.ctask` until you delete that folder.

## Quick start

You mostly do not run commands. You talk to Claude, and Claude runs them.

| Say this | What happens |
| --- | --- |
| "Add a settings page with tests" | Claude creates a task with steps before it starts, and closes each one with what it verified. |
| "Remind me in 20 minutes to check the deploy" | A reminder. You get a notification, and Claude brings it up. |
| "Where were we?" | Claude reads the task log and the last handoff note. |
| "What's open across all my projects?" | A summary of every project with open work. |
| "Remember: we never edit `generated/` by hand" | Stored as a project rule, shown to every future session. |
| "Why was `login.js` changed?" | The tasks that touched that file. |
| "Every morning, summarise the error log" | An automation that runs on its own. |
| "Save what we just did as a playbook called release" | A reusable recipe. |
| "What needs me?" | Due items, things waiting on you, blocked and stalled work. |

To look at the data yourself, the same commands work in a terminal:

```bash
ctask list
```

```bash
ctask projects
```

```bash
ctask review --all
```

(For `ctask` in your own terminal, clone the repository and run `npm link` in it.)

## How it works

A connector alone gives Claude tools it can forget. ctask is a plugin, and its hooks are what make it stick.

| Hook | When | What it does |
| --- | --- | --- |
| SessionStart | A session starts, resumes, or is compacted | Shows Claude the digest: due items, work in progress, open tasks, project memory, playbooks, the last handoff, other projects, and the usage rules. |
| UserPromptSubmit | Every message you send | Adds one line: the active task, anything due, or a nudge to create a task. |
| Stop | Claude finishes a turn | Links the files edited this turn to the active task. Blocks the turn once if a task in progress was not updated. |
| PreCompact | Context is about to be summarised | Saves a handoff note from the transcript. |
| SessionEnd | The session closes | Saves a handoff note from the transcript. |

Alongside the hooks:

- **The CLI** (`ctask`) is the engine. Claude calls it through its shell.
- **The skill** teaches Claude when to write and when to read.
- **The MCP server** exposes the same engine as tools, for surfaces with no shell: `task_add`, `task_list`, `task_get`, `task_update`, `task_next`, `memory_add`, `memory_list`.
- **The background checker** runs once a minute for notifications, automations and housekeeping.

Everything is stored in one SQLite file, `~/.ctask/ctask.db`. A project is the git root above the working directory, or the directory itself.

## Features

### Tasks and steps

A task has a `title`, a `body` (what and why), `instructions` (how), a `status`, a `priority`, tags, and a log of everything that happened to it. Steps are tasks with a parent.

```bash
ctask add "CSV import for orders" --body "Customers upload up to 50k rows" --instructions "Stream, do not load into memory" --start
```

```bash
ctask add "Parser" --parent 12
```

```bash
ctask note 12 "Decided on a streaming parser; the sync one ran out of memory at 20k rows"
```

```bash
ctask show 12
```

Statuses: `todo`, `in_progress`, `blocked`, `waiting` (on you), `done`, `cancelled`. Kinds: `task`, `step`, `reminder`, `automation`.

### Reminders

Any task with a due time is a reminder.

```bash
ctask add "Send the invoice" --next "tomorrow 9:00"
```

```bash
ctask add "Check the error budget" --next "17:30" --every 1w
```

When it comes due you get a macOS notification, and Claude raises it on your next message (or straight away, if the session is open and can schedule a wake-up). A repeating reminder is rescheduled when marked done instead of being closed. `ctask snooze 7 2h` moves one.

Times can be `now`, `30m`, `2h`, `3d`, `17:30`, `today 17:30`, `tomorrow 9:00`, `2026-12-01 14:00`, or an ISO timestamp.

### Automations

Work that runs without you.

```bash
ctask add "Summarise yesterday's error log" --kind automation --every 1d --next "tomorrow 8:00" --instructions "Read storage/logs, group errors by cause, write the top five to the task as a note"
```

When it is due, the background checker runs `claude -p` in the task's project with the body and instructions, records the result on the task, and reschedules it. Add `--resume` to continue the task's original session instead of starting fresh.

Two things to know: the `claude` CLI must be logged in for your terminal, and headless runs use Claude Code's default permissions, so tools that need approval will be refused.

### Handoff notes

Long sessions get compacted and closed sessions forget. Just before either happens, ctask reads the end of the transcript and saves:

- your last three requests,
- where Claude left off,
- the files it edited,
- its last commands.

No model call is involved, so it always happens. The note is attached to the session and to any task it had in progress, and the next session start shows it: to the same session after compaction, or to a new session in the same project for up to 14 days.

Claude can also write a better one itself, which takes priority:

```bash
ctask handoff 12 "state: parser done / failed: streaming on Windows paths / next: wire the tests"
```

### Project memory

Tasks end. Knowledge should not.

```bash
ctask remember "Never edit generated/ by hand, run make gen" --kind rule
```

```bash
ctask remember "Chose Postgres over MySQL for JSONB support" --kind decision
```

Kinds are `rule`, `decision`, `gotcha` and `fact`. Every session that starts in the project is shown the list, rules first. `--global` applies an entry to every project, `ctask memory [words]` searches, and `ctask forget m3` removes one.

### Evidence before done

The usual failure of an agent is saying "done" when it is not. A task or step cannot be marked done without a note saying what was run or checked:

```bash
ctask done 12 --note "Ran the import test suite, 14 passing; imported the 50k sample in 9s"
```

Record what done means up front, and it is printed back if Claude tries to close the task without evidence:

```bash
ctask add "Fix login redirect" --accept "Login test passes and the redirect lands on /dashboard"
```

Reminders and automations are exempt. `--force` overrides.

### Dependencies and parallel sessions

```bash
ctask add "Deploy" --after 14,15
```

A task cannot start until the tasks it waits on are closed. `ctask next` only offers work that is ready, closing a task prints what it unblocked, and cycles are rejected.

A task that is in progress in a session active within the last 30 minutes cannot be started by another session, so several sessions can work on one project without stepping on each other.

### Code links

At the end of every turn, the files Claude edited are attached to the task it was working on. The git branch and commit are recorded when a task is started and finished.

```bash
ctask why src/auth/login.js
```

That lists the tasks that touched the file, so "why is this like this?" has an answer. Add links by hand with `ctask link 12 --pr <url>`.

### Playbooks

A playbook is a saved recipe for work that repeats: a task with ordered steps, instructions and acceptance criteria. Instead of explaining how you do a release every time, save it once.

From a task that went well:

```bash
ctask playbook save release --from 42
```

Or written directly:

```bash
ctask playbook save triage --title "Bug triage" --steps "Reproduce; Find the cause; Fix; Add a regression test"
```

Then run it:

```bash
ctask playbook run release v2.0 --start
```

That creates the task "Release: v2.0" with its steps, each one waiting on the one before (`--parallel` removes the ordering). Claude is shown the playbook names at session start and uses them when the work matches.

### Review

```bash
ctask review --all
```

Lists what needs attention: due, waiting on you, blocked, and work in progress that nobody has touched for three days (`--stale 7` changes that). Once a day the background checker sends the same summary as a notification, and stays quiet when nothing needs you.

### Search, paging and archive

- **Search** matches every word against title, body, instructions, tags and log notes, and includes closed tasks: `ctask search invoice client`. Add `--all` for every project.
- **Lists are paged**, 50 at a time, and end with `showing 51–100 of 340 · next: --page 3`.
- **Archive**: tasks closed more than 30 days ago are archived automatically. They disappear from lists and search but are never deleted. `--archived` brings them back, and reopening a task unarchives it.

With 5,000 tasks, a list, a search and each hook take about 0.2 seconds, most of it Node starting.

## Command reference

`ctask help` prints this. Add `--json` to most commands for machine-readable output.

```text
Create
  ctask add <title> [--body T] [--instructions T] [--kind task|step|reminder|automation]
                    [--priority 1|2|3] [--parent ID] [--tags a,b] [--next WHEN] [--every 30m|2h|1d|1w]
                    [--accept CRITERIA] [--after ID,ID] [--start] [--resume] [--project DIR]

Work
  ctask start|done|block|wait|cancel|reopen <id> [--note T] [--force]
  ctask note <id> <text>
  ctask handoff <id> <text>
  ctask update <id> [--title --body --instructions --kind --priority --tags --parent --status
                     --accept --after --next WHEN|none --every INT|none --note T]
  ctask snooze <id> <WHEN>
  ctask rm <id>

Look
  ctask list [--all] [--status s1,s2] [--kind K] [--due] [--mine] [--closed] [--tag T]
             [--parent ID] [--archived] [--limit N] [--page N]
  ctask search <words> [--all] [--archived]
  ctask show <id>
  ctask next [--all]              what to work on now
  ctask due [--all]               items whose time has come
  ctask projects                  open work across every project
  ctask review [--all] [--stale DAYS]
  ctask context                   the digest Claude sees at session start

Memory
  ctask remember <text> [--kind rule|decision|gotcha|fact] [--global]
  ctask memory [words] [--all] [--kind K]
  ctask forget <mID>

Code
  ctask link <id> [--file a,b] [--commit SHA] [--branch NAME] [--pr URL]
  ctask why <file> [--all]

Playbooks
  ctask playbook save <name> --from <task id>
  ctask playbook save <name> --title T --steps "a; b; c" [--instructions T] [--accept T]
  ctask playbook run <name> [subject] [--start] [--parallel]
  ctask playbook list | show <name> | rm <name>

Archive
  ctask archive [<id>] [--older 30d] [--all] [--dry-run]
  ctask unarchive <id>

Background
  ctask tick [--dry-run]
  ctask daemon install|uninstall|status
```

## Background checker

On macOS the plugin installs and maintains a launchd agent, `com.ctask.tick`, from the SessionStart hook. Once a minute it:

1. shows a notification for anything that has come due,
2. sends the daily review, once, at or after 09:00,
3. runs due automations,
4. archives tasks closed more than 30 days ago.

It runs a small launcher in `~/.ctask/bin/` rather than the plugin directly, so it keeps working when the plugin is updated. Its log is `~/.ctask/tick.log`.

```bash
ctask daemon status
```

After `ctask daemon uninstall` the plugin leaves it off until you run `ctask daemon install`. On Linux, run `ctask tick` from cron instead.

## Configuration

Set these as environment variables.

| Variable | Default | Effect |
| --- | --- | --- |
| `CTASK_HOME` | `~/.ctask` | Data directory. |
| `CTASK_DB` | `$CTASK_HOME/ctask.db` | Database file. |
| `CTASK_STOP_GUARD` | on | `off` disables the end-of-turn check. |
| `CTASK_DAEMON` | on | `off` stops the plugin installing the background checker. |
| `CTASK_NOTIFY` | on | `off` disables macOS notifications. |
| `CTASK_REVIEW_AT` | `09:00` | Time of the daily review notification. `off` disables it. |
| `CTASK_ARCHIVE_AFTER` | `30d` | Age at which closed tasks are archived. `off` disables it. |
| `CTASK_CLAUDE_BIN` | `claude` | The executable used to run automations. |

## Data and privacy

- Everything is stored locally in `~/.ctask/ctask.db`. ctask makes no network requests.
- Handoff notes contain short excerpts of your conversation (your last requests and Claude's last message). They stay in that same local database.
- Automations call your own `claude` CLI, under your account.
- Back up or move your data by copying the `~/.ctask` folder.

## Troubleshooting

**Claude does not seem to know about ctask.** Hooks load when a session starts. Open a new session after installing or updating.

**No notification appeared.** macOS shows them as coming from Script Editor. Allow it under System Settings → Notifications. Check `ctask daemon status` and `~/.ctask/tick.log`.

**Automations fail.** Run `claude` in a terminal and log in; headless runs need it. Remember that they cannot use tools that require approval.

**`node: command not found` in hook output.** The plugin looks for Node on your PATH and in common install locations. If yours is elsewhere, make sure `node` resolves in a login shell.

**A task was attributed to the wrong session.** With two sessions open on the same project at once, a command that cannot see its session id falls back to the most recently active one.

**The end-of-turn check is in the way.** It fires once per turn, only when a task in progress was not touched. Set `CTASK_STOP_GUARD=off` to disable it.

## Development

```bash
git clone https://github.com/omarabulkhair-66/ctask.git
```

```bash
npm test
```

| Path | Contents |
| --- | --- |
| `bin/` | `ctask` entry point, and `ctask-run`, the launcher hooks use to find Node |
| `src/core.js` | Tasks, statuses, dependencies, lists, search, archive |
| `src/hooks.js` | The five hook handlers and the session digest |
| `src/handoff.js` | Transcript summariser |
| `src/memory.js`, `src/links.js`, `src/playbooks.js`, `src/review.js` | One feature each |
| `src/tick.js` | Background checker and launchd agent |
| `src/mcp.js` | MCP server |
| `hooks/hooks.json`, `skills/ctask/SKILL.md`, `.claude-plugin/` | Plugin wiring |

While developing, point `CTASK_DB` at a scratch file and set `CTASK_DAEMON=off`, then load the working copy with `claude --plugin-dir .`. The code has no dependencies beyond Node's built-ins; please keep it that way.

## License

MIT
