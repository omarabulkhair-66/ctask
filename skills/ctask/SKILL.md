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
- **Stopping with work unfinished** → `ctask handoff 12 "state: … / tried and failed: … / next: …"`. The next session (or this one after its context is compacted) is shown the latest handoff first. An automatic one is captured from the transcript before compaction and at session end, but it only records what happened; yours records what you concluded.
- **Finished** → `ctask done 12 --note "what changed and what you ran or checked"`. The note is required: it is the evidence. If the task has acceptance criteria (`--accept`), check each one first. Never mark done on an assumption; if you could not verify, say so in a `note` and leave it open or `wait`.
- **Work that must happen in order** → `ctask add "Deploy" --after 14,15`. A task cannot start until what it waits on is closed, and `ctask next` only offers what is ready.
- **Something every future session must know** → see [Memory](#memory) below. It is not a task.
- **Repeatable work** → if a playbook matches (they are listed at session start), `ctask playbook run <name> [subject] --start` instead of inventing the steps. After doing a multi-step job well that will recur, offer to save it: `ctask playbook save <name> --from <task id>`.
- **Need the user** → `ctask wait 12 --note "need the API key for X"`. **Stuck on something else** → `ctask block 12 --note "why"`.
- **"Remind me / follow up / check later"** → `ctask add "Ask about the invoice" --next "tomorrow 9:00"` (add `--every 1w` to repeat). If the reminder is due within the life of this session and you have the `CronCreate` tool, also schedule a one-shot wake-up for the same minute (`recurring: false`, prompt: `ctask reminder #<id> is due: tell the user, then ctask done <id>`), so you speak up in the chat at that time instead of waiting for their next message. ctask stays the record; the wake-up is only the voice.
- **Recurring unattended work** → `ctask add "Summarise error logs" --kind automation --every 1d --instructions "exact steps"`. It runs via `ctask tick` in a headless session, so the instructions must stand on their own.

Trivial one-shot answers do not need a task.

## Memory

Memory is what makes the next session smarter than this one. Treat it as a small, accurate set of statements you maintain, not a log you append to.

**Save** the moment you learn something durable, not at the end:

```bash
ctask remember "Never edit generated/ by hand, run make gen" --kind rule
ctask remember "User wants commit messages in English, replies in Arabic" --kind preference --global
ctask remember "Chose SQLite over Postgres: local, single user, no server, hooks must start in 0.2s" --kind decision
ctask remember "Seed a demo database with --class=DemoSeeder" --kind fact --when "demo, seed"
```

- Kinds: `rule` and `preference` are shown at every session start; `decision`, `gotcha` and `fact` are recalled when a message is about them. Write one self-contained statement, with the reason for a decision.
- `--when "words, phrases"` makes an entry come back whenever those words appear. Use it for things that matter only in one situation. Recall matches words and does not translate: when the user writes in a different language from the memory text, add trigger words in their language too (`--when "deploy, نشر, رفع"`), and when you look something up yourself, `ctask recall` in the language the memories are written in.
- `--global` for what is true in every project (mostly user preferences).

**Correct, do not duplicate.** When a memory you were shown is wrong, incomplete or out of date:

```bash
ctask memory update m3 "The rate limit is 120 per minute, raised in March"
ctask remember "We moved from Redis to Valkey" --kind decision --replaces m7
ctask memory merge m4 m9 "One statement that covers both"
```

A new entry that repeats an existing one is refused and names the entry to update. Fix it there. If the user contradicts a memory, update it in the same turn.

**Recall.** Relevant entries are added to the conversation for you as it moves ("RELEVANT MEMORY"), once per context and again after compaction. Before starting work in an area you have not touched this session, look yourself: `ctask recall "payments webhook"`.

**When prompted.** "MEMORY CHECKPOINT" and "MEMORY: this message reads like a lasting instruction" mean: decide now whether there is something to save or correct. It is fine for the answer to be no.

**Upkeep.** `ctask memory review` lists near-duplicates and entries nothing recalls; merge, re-word or forget them when it comes up.

Do not save: what the code or git history already says, the current task's progress (that is a note or a handoff), or anything true only for this conversation.

## Insight

`ctask stats` shows what ctask did in the last week (context added, memories recalled, where it stepped in, what it cost) and `ctask log` shows the individual calls. Use them when the user asks what difference ctask is making.

## When to read it

- Session start: the digest is injected for you. If it has a HANDOFF section, that is where the previous context stopped: read it before doing anything else. Mention due items to the user first.
- Resuming: `ctask show <id>` gives body, instructions, steps and the log. Read it before redoing work.
- Looking for something specific, or an old/closed task → `ctask search "invoice client"` (every word must match; covers notes and closed tasks; `--all` for every project).
- Closed tasks older than 30 days are archived automatically and hidden; add `--archived` to `search` (or `list`) when looking for old history.
- Lists are paged, 50 at a time: follow the `next: --page N` footer rather than assuming you saw everything.
- Before changing a file you did not write this session → `ctask why <file>` shows the tasks that touched it and why.
- "What needs me?" / start of day → `ctask review` (`--all` for every project): due, waiting on the user, blocked, stalled.
- "What's open?" → `ctask list`. "Across everything?" → `ctask projects`, `ctask list --all`. "What now?" → `ctask next`.

## Rules

- If `start` says a task is in progress in another active session, pick different work; do not `--force` unless the user says that session is dead.
- Exactly one task `in_progress` per thing you are actually doing. Start it when you begin, close it when you end.
- A due reminder is handled only when you have told the user: then `ctask done <id>` or `ctask snooze <id> 2h`.
- `body` is what and why; `instructions` is how. Write both so a session with no memory of this conversation can do the task.
- Never leave a turn with an `in_progress` task you did not touch — update its status or add a note. A Stop hook checks this.

Run `ctask help` for every flag.
