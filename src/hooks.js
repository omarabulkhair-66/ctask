// Claude Code hook handlers. Each reads the hook JSON from stdin and prints the hook JSON reply.
// They must never break a session: any failure exits 0 with no output.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countTasks, listTasks, projectsSummary, resolveProject, staleInProgress, touchSession } from './core.js';
import { projectName, taskLine } from './format.js';
import { findTranscript, handoffFor, latestTaskHandoff, saveHandoff, summarizeTranscript, turnFiles } from './handoff.js';
import { linkFilesToSession } from './links.js';
import { logCall } from './log.js';
import { memoryLine, promptTick, recall, startEpoch, startMemory } from './memory.js';
import { listPlaybooks } from './playbooks.js';
import { ensureDaemon } from './tick.js';
import { fmtRelative } from './time.js';

const RULES = `How to use ctask (your persistent task engine and memory — it survives sessions, unlike the in-chat task list):
- Multi-step work, anything spanning turns/sessions, or anything the user asks you to remember: \`ctask add "title" --body "..." --instructions "..."\`, then \`ctask start <id>\`. Break big tasks into steps with \`--parent <id>\`.
- Keep it true as you go: \`ctask note <id> "decision / progress"\`, \`ctask done <id> --note "result"\`, \`ctask block <id> --note "why"\`, \`ctask wait <id> --note "what you need from the user"\`. Stopping mid-task: \`ctask handoff <id> "state / what was tried and failed / next step"\`. \`done\` requires \`--note\` with what you actually ran or checked; never mark done on an assumption.
- Memory is how you get smarter over time. Save what a future session must know the moment you learn it: \`ctask remember "..." --kind rule|preference|decision|gotcha|fact\` (add \`--when "deploy, release"\` to make it come back when those words appear; recall matches words and does not translate, so when the user writes in another language put trigger words in that language too). When something you were shown is wrong or out of date, FIX it, do not add a second entry: \`ctask memory update m3 "corrected text"\`, or \`ctask remember "..." --replaces m3\`. Relevant memories are recalled for you as the conversation moves; to look yourself: \`ctask recall "<topic>"\`.
- Order between tasks: \`--after <id>\`. Why a file changed: \`ctask why <file>\`.
- Follow-ups and reminders: \`ctask add "..." --next "tomorrow 9:00"\` (add \`--every 1d\` to repeat). For a reminder due soon, also schedule a one-shot CronCreate wake-up at that minute (if you have that tool) so you say it in the chat on time. Unattended recurring work: \`--kind automation --instructions "..."\`.
- DUE items below: tell the user about them, then \`ctask done <id>\` or \`ctask snooze <id> 2h\`.
- "What's open?" / "where were we?": \`ctask list\` (paged), \`ctask search "<words>"\` (also finds closed tasks and notes), \`ctask show <id>\`, \`ctask projects\` (all projects).`;

const clip = (s, n = 260) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The text a starting context is given. `record` marks the memories as shown to this session, so the
 * per-prompt recall does not repeat them; `meta` collects what happened, for the call log.
 */
export function digest(project, sessionId, { rules = true, epoch = 0, record = false, meta = {} } = {}) {
  // Each section is its own query with its own total, so the digest stays small and the numbers stay
  // right however many tasks the project has.
  const sections = [
    ['DUE NOW', { project, due: true }, 10],
    ['IN PROGRESS', { project, status: ['in_progress'], notDue: true }, 10],
    ['OPEN', { project, notStatus: 'in_progress', notDue: true }, 8],
  ];
  const openTotal = countTasks({ project });
  meta.open = openTotal;
  const out = [`[ctask] project ${projectName(project)}${sessionId ? ` · session ${sessionId}` : ''}`];
  for (const [label, filter, max] of sections) {
    const total = countTasks(filter);
    if (!total) continue;
    if (label === 'DUE NOW') meta.due = total;
    out.push(`${label} (${total}):`);
    out.push(...listTasks({ ...filter, limit: max }).map((t) => `  ${taskLine(t)}`));
    if (total > max) out.push(`  … ${total - max} more (ctask list --page 2, or ctask search "<words>")`);
  }
  if (!openTotal) out.push('No open tasks in this project.');

  // Memory: the standing rules and preferences, plus the few most valuable other entries.
  // Everything else comes back on its own when a message is about it.
  const mem = startMemory({ project, session: sessionId, epoch, record });
  if (mem.total) {
    meta.memoryShown = mem.shown.map((m) => m.id);
    out.push('', `PROJECT MEMORY (${mem.total}) — follow these:`, ...mem.shown.map((m) => `  ${clip(memoryLine(m))}`));
    const rest = mem.total - mem.shown.length;
    if (rest > 0) out.push(`  … ${rest} more are recalled automatically when relevant (ctask recall "<topic>", ctask memory)`);
    out.push('  If any of these is wrong or stale, correct it now: ctask memory update <mID> "<text>".');
  }
  const books = listPlaybooks();
  if (books.length) out.push('', `PLAYBOOKS: ${books.slice(0, 12).map((b) => b.name).join(', ')} — for matching work use: ctask playbook run <name> [subject] --start`);

  // Handoff: what the previous context knew that this one does not.
  const active = listTasks({ project, status: ['in_progress'], limit: 2 });
  const shown = new Set();
  for (const t of active) {
    const ho = latestTaskHandoff(t.id);
    if (!ho) continue;
    shown.add(ho.note.replace(/^\[auto[^\]]*\]\n/, ''));
    out.push('', `HANDOFF for #${t.id} (${ago(ho.at)}):`, ho.note);
  }
  const ho = handoffFor(sessionId, project);
  if (ho && !shown.has(ho.handoff)) {
    out.push(
      '',
      ho.own
        ? `HANDOFF — this session before its context was compacted (${ago(ho.handoff_at)}):`
        : `HANDOFF — the previous session in this project (${ago(ho.handoff_at)}):`,
      ho.handoff,
    );
  }
  if (shown.size || ho) {
    meta.handoffShown = true;
    out.push('Read the handoff before redoing work; `ctask show <id>` has the full log.');
  }
  const others = projectsSummary().filter((p) => p.project !== project);
  if (others.length) {
    out.push(
      `OTHER PROJECTS: ${others
        .slice(0, 8)
        .map((p) => `${projectName(p.project)} (${p.open} open${p.due ? `, ${p.due} due` : ''})`)
        .join(', ')}`,
    );
  }
  if (rules) out.push('', RULES);
  return out.join('\n');
}

function readInput() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const context = (event, text) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

const NUDGE = {
  standing:
    'MEMORY: this message reads like a lasting instruction, preference or correction. If it should hold in future sessions, save it now (ctask remember "..." --kind rule|preference), or correct the existing entry (ctask memory update <mID> "...") if it changes something you already had.',
  checkpoint:
    'MEMORY CHECKPOINT: several messages have passed with nothing saved. Before this detail is lost to compaction, save what a future session would need — decisions and their reasons, things that failed and why, user preferences, project conventions (ctask remember) — and correct any memory this conversation proved wrong (ctask memory update). Skip if there is truly nothing new.',
};

const handlers = {
  'session-start'(input, project, meta) {
    touchSession(input.session_id, project);
    // Make the session id visible to `ctask` calls made through Bash in this session.
    if (process.env.CLAUDE_ENV_FILE && /^[\w-]+$/.test(input.session_id ?? '')) {
      fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export CTASK_SESSION_ID='${input.session_id}'\n`);
    }
    // The plugin owns its background checker (notifications + automations); keep it installed.
    try {
      ensureDaemon(fileURLToPath(new URL('../bin/ctask', import.meta.url)));
    } catch {}
    // A new context: whatever memory was shown before is gone from it (most importantly after compaction).
    const epoch = startEpoch(input.session_id);
    meta.source = input.source;
    return context('SessionStart', digest(project, input.session_id, { epoch, record: true, meta }));
  },

  'user-prompt'(input, project, meta) {
    touchSession(input.session_id, project, { prompt: true });
    const due = listTasks({ project, due: true, limit: 4 });
    const mine = input.session_id
      ? listTasks({ project, status: ['in_progress'], session: input.session_id, limit: 4 })
      : [];
    const brief = (ts) => ts.map((t) => `#${t.id} "${t.title}"`).join(', ');
    const bits = [];
    if (mine.length) bits.push(`active: ${brief(mine)} — keep its status/notes current`);
    else bits.push('no active task in this session — if this request is multi-step, or a follow-up/reminder, track it (ctask add, ctask start)');
    if (due.length) bits.push(`DUE NOW: ${brief(due)} — surface to the user, then done/snooze`);
    bits.push(`${countTasks({ project })} open here`);
    const lines = [`[ctask] ${bits.join(' · ')}`];
    if (mine.length) meta.active = mine.map((t) => t.id);
    if (due.length) meta.due = due.length;

    // Memory that this message is about, and that this context has not seen yet.
    const { epoch, nudge } = promptTick(input.session_id, input.prompt);
    const hits = input.prompt ? recall({ project, text: input.prompt, session: input.session_id, epoch }) : [];
    if (hits.length) {
      meta.recalled = hits.map((m) => m.id);
      lines.push('RELEVANT MEMORY (recalled for this message — apply it, and fix it if it is wrong):', ...hits.map((m) => `  ${clip(memoryLine(m), 320)}`));
    }
    if (nudge) {
      meta.nudge = nudge;
      lines.push(NUDGE[nudge]);
    }
    return context('UserPromptSubmit', lines.join('\n'));
  },

  // Context is about to be summarised: capture where things stand while the detail still exists.
  'pre-compact'(input, project, meta) {
    return captureHandoff(input, project, `before ${input.trigger === 'manual' ? 'manual ' : ''}compaction`, meta);
  },

  'session-end'(input, project, meta) {
    return captureHandoff(input, project, 'session end', meta);
  },

  stop(input, project, meta) {
    // Remember which files this turn touched, on the task(s) it was working on.
    try {
      const file = input.session_id && findTranscript(input);
      if (file) meta.filesLinked = linkFilesToSession(input.session_id, turnFiles(file), project);
    } catch {}
    if (input.stop_hook_active || process.env.CTASK_STOP_GUARD === 'off') return '';
    const stale = staleInProgress(input.session_id);
    if (!stale.length) return '';
    meta.blocked = stale.map((t) => t.id);
    return JSON.stringify({
      decision: 'block',
      reason:
        `[ctask] Before stopping, update the task(s) you have in progress — they were not touched this turn:\n` +
        stale.map((t) => `  ${taskLine(t)}`).join('\n') +
        `\nFor each: \`ctask done <id> --note "result"\`, \`ctask wait <id> --note "what you need"\`, ` +
        `\`ctask block <id> --note "why"\`, or \`ctask note <id> "where it stands"\` if work continues next turn.`,
    });
  },
};

function ago(iso) {
  const r = fmtRelative(iso);
  return r === 'now' ? 'just now' : `${r.replace('overdue ', '')} ago`;
}

function captureHandoff(input, project, reason, meta) {
  if (!input.session_id) return '';
  touchSession(input.session_id, project);
  const file = findTranscript(input);
  const text = file && summarizeTranscript(file, input.cwd || project);
  if (text) {
    saveHandoff(input.session_id, text, reason);
    meta.handoff = 'captured';
  }
  return '';
}

export function runHook(name) {
  let input = {};
  let project;
  const meta = {};
  let out = '';
  let error;
  try {
    const handler = handlers[name];
    if (!handler) return;
    input = readInput();
    project = resolveProject(input.cwd || process.cwd());
    out = handler(input, project, meta) || '';
    if (out) process.stdout.write(out + '\n');
  } catch (err) {
    error = err;
    if (process.env.CTASK_DEBUG) console.error(err);
  }
  if (!handlers[name]) return;
  // Log what was injected (not the JSON wrapper), so the numbers mean "context added to the conversation".
  let injected = 0;
  try {
    const j = out ? JSON.parse(out) : {};
    injected = (j.hookSpecificOutput?.additionalContext ?? j.reason ?? '').length;
  } catch {}
  logCall({ source: 'hook', name, session: input.session_id, project, ms: process.uptime() * 1000, outChars: injected, ok: !error, error: error?.message, detail: meta });
}
