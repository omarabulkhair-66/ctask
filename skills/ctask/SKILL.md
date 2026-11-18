---
name: ctask
description: Persistent task engine for your own work — tasks, steps, reminders and automations that survive sessions and span every project. Use at the start of any multi-step request, when the user asks you to remember or follow up on something, when they ask what is open or where things stand (in this project or across projects), when resuming earlier work, and before ending a turn in which you started or finished tracked work.
---

# ctask — your task engine

`ctask` is where your work lives between sessions. The in-chat task list disappears with the conversation; ctask does not. One database covers every project on this machine, and every task records the session that owns it.

Use the `ctask` command through Bash. Where there is no shell, the same engine is exposed as MCP tools (`task_add`, `task_list`, `task_get`, `task_update`, `task_next`).

## When to write to it

- **Multi-step request** → one task for the goal, steps under it, before you start:
  ```bash
  ctask add "Add CSV import for orders" --body "why / scope / constraints" --instructions "how: files, approach, checks" --start
  ctask add "Parser" --parent 12
  ```
- **A decision, a finding, a place you stopped** → `ctask note 12 "…"`. Write what a fresh session would need, not a diary.
- **Finished** → `ctask done 12 --note "what changed, what was verified"`.
- **Need the user** → `ctask wait 12 --note "need the API key for X"`. **Stuck on something else** → `ctask block 12 --note "why"`.
- **"Remind me / follow up / check later"** → `ctask add "Ask about the invoice" --next "tomorrow 9:00"` (add `--every 1w` to repeat). If the reminder is due within the life of this session and you have the `CronCreate` tool, also schedule a one-shot wake-up for the same minute (`recurring: false`, prompt: `ctask reminder #<id> is due: tell the user, then ctask done <id>`), so you speak up in the chat at that time instead of waiting for their next message. ctask stays the record; the wake-up is only the voice.
- **Recurring unattended work** → `ctask add "Summarise error logs" --kind automation --every 1d --instructions "exact steps"`. It runs via `ctask tick` in a headless session, so the instructions must stand on their own.

Trivial one-shot answers do not need a task.

## When to read it

- Session start: the digest is injected for you. Mention due items to the user first.
- Resuming: `ctask show <id>` gives body, instructions, steps and the log. Read it before redoing work.
- Looking for something specific, or an old/closed task → `ctask search "invoice client"` (every word must match; covers notes and closed tasks; `--all` for every project).
- Closed tasks older than 30 days are archived automatically and hidden; add `--archived` to `search` (or `list`) when looking for old history.
- Lists are paged, 50 at a time: follow the `next: --page N` footer rather than assuming you saw everything.
- "What's open?" → `ctask list`. "Across everything?" → `ctask projects`, `ctask list --all`. "What now?" → `ctask next`.

## Rules

- Exactly one task `in_progress` per thing you are actually doing. Start it when you begin, close it when you end.
- A due reminder is handled only when you have told the user: then `ctask done <id>` or `ctask snooze <id> 2h`.
- `body` is what and why; `instructions` is how. Write both so a session with no memory of this conversation can do the task.
- Never leave a turn with an `in_progress` task you did not touch — update its status or add a note. A Stop hook checks this.

Run `ctask help` for every flag.
