// Claude Code hook handlers. Each reads the hook JSON from stdin and prints the hook JSON reply.
// They must never break a session: any failure exits 0 with no output.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countTasks, listTasks, projectsSummary, resolveProject, staleInProgress, touchSession } from './core.js';
import { projectName, taskLine } from './format.js';
import { findTranscript, handoffFor, latestTaskHandoff, saveHandoff, summarizeTranscript, turnFiles } from './handoff.js';
import { linkFilesToSession } from './links.js';
import { countMemory, listMemory, memoryLine } from './memory.js';
import { listPlaybooks } from './playbooks.js';
import { ensureDaemon } from './tick.js';
import { fmtRelative } from './time.js';

const RULES = `How to use ctask (your persistent task engine — it survives sessions, unlike the in-chat task list):
- Multi-step work, anything spanning turns/sessions, or anything the user asks you to remember: \`ctask add "title" --body "..." --instructions "..."\`, then \`ctask start <id>\`. Break big tasks into steps with \`--parent <id>\`.
- Keep it true as you go: \`ctask note <id> "decision / progress"\`, \`ctask done <id> --note "result"\`, \`ctask block <id> --note "why"\`, \`ctask wait <id> --note "what you need from the user"\`. Stopping mid-task: \`ctask handoff <id> "state / what was tried and failed / next step"\`. \`done\` requires \`--note\` with what you actually ran or checked; never mark done on an assumption.
- A decision, convention or gotcha that future sessions must know: \`ctask remember "..." --kind rule|decision|gotcha|fact\`. Order between tasks: \`--after <id>\`. Why a file changed: \`ctask why <file>\`.
- Follow-ups and reminders: \`ctask add "..." --next "tomorrow 9:00"\` (add \`--every 1d\` to repeat). For a reminder due soon, also schedule a one-shot CronCreate wake-up at that minute (if you have that tool) so you say it in the chat on time. Unattended recurring work: \`--kind automation --instructions "..."\`.
- DUE items below: tell the user about them, then \`ctask done <id>\` or \`ctask snooze <id> 2h\`.
- "What's open?" / "where were we?": \`ctask list\` (paged), \`ctask search "<words>"\` (also finds closed tasks and notes), \`ctask show <id>\`, \`ctask projects\` (all projects).`;

export function digest(project, sessionId, { rules = true } = {}) {
  // Each section is its own query with its own total, so the digest stays small and the numbers stay
  // right however many tasks the project has.
  const sections = [
    ['DUE NOW', { project, due: true }, 10],
    ['IN PROGRESS', { project, status: ['in_progress'], notDue: true }, 10],
    ['OPEN', { project, notStatus: 'in_progress', notDue: true }, 8],
  ];
  const openTotal = countTasks({ project });
  const out = [`[ctask] project ${projectName(project)}${sessionId ? ` · session ${sessionId}` : ''}`];
  for (const [label, filter, max] of sections) {
    const total = countTasks(filter);
    if (!total) continue;
    out.push(`${label} (${total}):`);
    out.push(...listTasks({ ...filter, limit: max }).map((t) => `  ${taskLine(t)}`));
    if (total > max) out.push(`  … ${total - max} more (ctask list --page 2, or ctask search "<words>")`);
  }
  if (!openTotal) out.push('No open tasks in this project.');
  // Project memory: standing knowledge, shown before any work starts.
  const memTotal = countMemory(project);
  if (memTotal) {
    const clip = (s) => (s.length > 220 ? `${s.slice(0, 219)}…` : s);
    out.push('', `PROJECT MEMORY (${memTotal}) — follow these:`, ...listMemory({ project, limit: 15 }).map((m) => `  ${clip(memoryLine(m))}`));
    if (memTotal > 15) out.push(`  … ${memTotal - 15} more (ctask memory, or ctask memory <words>)`);
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
  if (shown.size || ho) out.push('Read the handoff before redoing work; `ctask show <id>` has the full log.');
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

const handlers = {
  'session-start'(input, project) {
    touchSession(input.session_id, project);
    // Make the session id visible to `ctask` calls made through Bash in this session.
    if (process.env.CLAUDE_ENV_FILE && /^[\w-]+$/.test(input.session_id ?? '')) {
      fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export CTASK_SESSION_ID='${input.session_id}'\n`);
    }
    // The plugin owns its background checker (notifications + automations); keep it installed.
    try {
      ensureDaemon(fileURLToPath(new URL('../bin/ctask', import.meta.url)));
    } catch {}
    return context('SessionStart', digest(project, input.session_id));
  },

  'user-prompt'(input, project) {
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
    return context('UserPromptSubmit', `[ctask] ${bits.join(' · ')}`);
  },

  // Context is about to be summarised: capture where things stand while the detail still exists.
  'pre-compact'(input, project) {
    return captureHandoff(input, project, `before ${input.trigger === 'manual' ? 'manual ' : ''}compaction`);
  },

  'session-end'(input, project) {
    return captureHandoff(input, project, 'session end');
  },

  stop(input, project) {
    // Remember which files this turn touched, on the task(s) it was working on.
    try {
      const file = input.session_id && findTranscript(input);
      if (file) linkFilesToSession(input.session_id, turnFiles(file), project);
    } catch {}
    if (input.stop_hook_active || process.env.CTASK_STOP_GUARD === 'off') return '';
    const stale = staleInProgress(input.session_id);
    if (!stale.length) return '';
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

function captureHandoff(input, project, reason) {
  if (!input.session_id) return '';
  touchSession(input.session_id, project);
  const file = findTranscript(input);
  const text = file && summarizeTranscript(file, input.cwd || project);
  if (text) saveHandoff(input.session_id, text, reason);
  return '';
}

export function runHook(name) {
  try {
    const handler = handlers[name];
    if (!handler) return;
    const input = readInput();
    const project = resolveProject(input.cwd || process.cwd());
    const out = handler(input, project);
    if (out) process.stdout.write(out + '\n');
  } catch (err) {
    if (process.env.CTASK_DEBUG) console.error(err);
  }
}
