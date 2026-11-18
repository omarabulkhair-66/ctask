import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import { dbPath } from './db.js';
import { logText, memoryDetailText, memoryReviewText, pageText, playbookText, projectsText, reviewText, statsText, taskDetailText, taskLine, taskList } from './format.js';
import * as links from './links.js';
import * as memory from './memory.js';
import * as playbooks from './playbooks.js';
import { logCall, readLog, stats } from './log.js';
import { review } from './review.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `ctask ${VERSION} — persistent task engine for Claude (tasks, steps, reminders, automations)

Create
  ctask add <title> [--body T] [--instructions T] [--kind task|step|reminder|automation]
                    [--priority 1|2|3] [--parent ID] [--tags a,b] [--next WHEN] [--every 30m|2h|1d|1w]
                    [--accept CRITERIA] [--after ID,ID]
                    [--start] [--resume] [--project DIR] [--session ID]
Work
  ctask start|done|block|wait|cancel|reopen <id> [--note T] [--force]
                                done needs --note: what you ran or checked
  ctask note <id> <text>
  ctask handoff <id> <text>     where it stands, what failed, the next step (shown to the next session)
  ctask update <id> [--title --body --instructions --kind --priority --tags --parent --status
                     --next WHEN|none --every INT|none --session ID --note T]
  ctask snooze <id> <WHEN>
  ctask rm <id>
  ctask archive [<id>] [--older 30d] [--all] [--dry-run]   hide old closed tasks (default: closed 30+ days ago)
  ctask unarchive <id>
Look
  ctask list [--all] [--status s1,s2] [--kind K] [--due] [--mine] [--closed] [--tag T] [--parent ID] [--archived]
             [--limit N] [--page N]     50 per page by default
  ctask search <words> [--all] [same filters]   title, body, instructions, tags and notes; includes closed
  ctask show <id>
  ctask next [--all]            what to work on now
  ctask due [--all]             items whose time has come
  ctask projects                open work across every project
  ctask context                 the digest injected at session start
Memory     (what Claude knows about the project; edited over time, recalled when relevant)
  ctask remember <text> [--kind rule|preference|decision|gotcha|fact] [--when "words, phrases"]
                        [--importance 1|2|3] [--replaces mID] [--global] [--force]
  ctask memory [words] [--all] [--kind K]        list, or search ranked by relevance
  ctask memory update <mID> [new text] [--kind K] [--when W|none] [--importance N]
  ctask memory merge <mID> <mID> [...] <combined text>
  ctask memory show <mID>       versions, what it replaced, how often it was recalled
  ctask memory review [--all]   duplicates and entries nothing recalls
  ctask recall <text>           what memory is relevant to this
  ctask forget <mID>
Insight    (what ctask is doing in your sessions)
  ctask stats [--days 7] [--all]
  ctask log [--limit 40] [--source hook|cli|mcp|tick] [--session ID] [--name N] [--failed]
Code
  ctask link <id> [--file a,b] [--commit SHA] [--branch NAME] [--pr URL]
  ctask why <file> [--all]      tasks that touched a file
Playbooks  (reusable recipes: a task with ordered steps)
  ctask playbook save <name> --from <task id> | --title T --steps "a; b; c" [--instructions T] [--accept T]
  ctask playbook run <name> [subject] [--start] [--parallel]
  ctask playbook list | show <name> | rm <name>
Review
  ctask review [--all] [--stale DAYS]   due, waiting on you, blocked, stalled
Automation
  ctask tick [--dry-run]        notify due reminders, run due automations with \`claude -p\`
  ctask daemon install|uninstall|status   background checker (the plugin installs it itself)
Integration
  ctask hook session-start|user-prompt|stop|pre-compact|session-end     Claude Code hooks (JSON on stdin)
  ctask mcp                     MCP server on stdio

WHEN: now, 30m, 2h, 3d, 17:30, today 17:30, tomorrow [9:00], 2026-12-01 [14:00], or ISO.
Statuses: todo, in_progress, blocked, waiting (on the user), done, cancelled.
Add --json to add/list/show/next/due/projects for machine-readable output.
Data: ${dbPath()}`;

const BOOL = new Set(['failed', 'force', 'global', 'parallel', 'archived', 'json', 'all', 'due', 'mine', 'closed', 'dry-run', 'help', 'start', 'resume']);

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) opt[key] = a.slice(eq + 1);
      else if (BOOL.has(key)) opt[key] = true;
      else {
        if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`);
        opt[key] = argv[++i];
      }
    } else if (a === '-h') opt.help = true;
    else pos.push(a);
  }
  return { pos, opt };
}

const STATUS_VERBS = { start: 'in_progress', done: 'done', block: 'blocked', wait: 'waiting', cancel: 'cancelled', reopen: 'todo' };

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === '--version' || cmd === 'version') return console.log(VERSION);

  // Integration entry points first: they have their own I/O contracts.
  if (cmd === 'hook') return import('./hooks.js').then((m) => m.runHook(rest[0]));
  if (cmd === 'mcp') return import('./mcp.js').then((m) => m.serve(VERSION));

  const { pos, opt } = parse(rest);
  if (opt.help) return console.log(HELP);
  const project = opt.project ? core.resolveProject(opt.project) : core.resolveProject();
  const print = (data, text) => console.log(opt.json ? JSON.stringify(data, null, 2) : text);
  const needId = () => {
    if (!pos[0]) throw new Error(`usage: ctask ${cmd} <id>`);
    return pos[0];
  };

  if (cmd in STATUS_VERBS) {
    const t = core.setStatus(needId(), STATUS_VERBS[cmd], { note: opt.note ?? (pos.slice(1).join(' ') || undefined), force: opt.force });
    const freed = cmd === 'done' ? core.unblockedBy(t.id) : [];
    return print(t, taskLine(t) + (freed.length ? `\nunblocked: ${freed.map((u) => `#${u.id} ${u.title}`).join(', ')}` : ''));
  }

  switch (cmd) {
    case 'add': {
      let t = core.addTask({ ...opt, title: pos.join(' '), project });
      if (opt.start) t = core.setStatus(t.id, 'in_progress');
      return print(t, `created ${taskLine(t)}`);
    }
    case 'update': {
      const { note, json, force, ...patch } = opt;
      const t = core.updateTask(needId(), patch, { note, force });
      return print(t, taskLine(t));
    }
    case 'note': {
      const t = core.addNote(needId(), pos.slice(1).join(' '));
      return console.log(`noted on #${t.id}`);
    }
    case 'handoff': {
      const t = core.addNote(needId(), pos.slice(1).join(' '), { type: 'handoff' });
      return console.log(`handoff saved on #${t.id}`);
    }
    case 'snooze': {
      if (!pos[1]) throw new Error('usage: ctask snooze <id> <WHEN>');
      const t = core.updateTask(needId(), { next: pos.slice(1).join(' ') });
      return print(t, taskLine(t));
    }
    case 'remember': {
      const m = memory.remember({ text: pos.join(' '), kind: opt.kind, project, global: opt.global, session: core.currentSession(project), when: opt.when, importance: opt.importance, replaces: opt.replaces, force: opt.force });
      return print(m, `remembered ${memory.memoryLine(m)}${opt.replaces ? ` (replaces ${opt.replaces})` : ''}`);
    }
    case 'memory': {
      const [sub, ...more] = pos;
      const session = core.currentSession(project);
      if (sub === 'update') {
        if (!more[0]) throw new Error('usage: ctask memory update <mID> [new text] [--kind K] [--when W] [--importance N]');
        const m = memory.updateMemory(more[0], { text: more.slice(1).join(' ') || undefined, kind: opt.kind, when: opt.when, importance: opt.importance, global: opt.global ? true : undefined }, { session, project });
        return print(m, `updated ${memory.memoryLine(m)}`);
      }
      if (sub === 'merge') {
        const ids = [];
        while (more.length && /^m?\d+$/i.test(more[0])) ids.push(more.shift());
        const m = memory.mergeMemory(ids, more.join(' '), { session, kind: opt.kind });
        return print(m, `merged ${ids.join(', ')} into ${memory.memoryLine(m)}`);
      }
      if (sub === 'show') {
        if (!more[0]) throw new Error('usage: ctask memory show <mID>');
        const d = memory.memoryDetail(more[0]);
        return print(d, memoryDetailText(d));
      }
      if (sub === 'review') {
        const r = memory.reviewMemory({ project, all: opt.all });
        return print(r, memoryReviewText(r));
      }
      const rows = memory.listMemory({ project, all: opt.all, q: pos.join(' '), kind: opt.kind, status: opt.status ?? 'active' });
      return print(rows, rows.length ? rows.map(memory.memoryLine).join('\n') : '(nothing remembered)');
    }
    case 'recall': {
      if (!pos.length) throw new Error('usage: ctask recall <text>');
      const hits = memory.recall({ project, text: pos.join(' '), session: core.currentSession(project), how: 'manual' });
      return print(hits, hits.length ? hits.map(memory.memoryLine).join('\n') : '(no memory is relevant to that)');
    }
    case 'stats': {
      const s = stats({ days: opt.days ? Number(opt.days) : undefined, project, all: opt.all });
      return print(s, statsText(s));
    }
    case 'log': {
      const rows = readLog({ limit: opt.limit ? Number(opt.limit) : undefined, source: opt.source, name: opt.name, session: opt.session, failed: opt.failed });
      return print(rows, logText(rows));
    }
    case 'forget': {
      const m = memory.forget(needId());
      return console.log(`forgot m${m.id}: ${m.text}`);
    }
    case 'link': {
      const t = core.getTask(needId());
      let n = 0;
      for (const f of (opt.file ?? '').split(',').filter(Boolean)) n += links.addLink(t.id, 'file', links.relFile(f.trim(), t.project));
      for (const k of ['commit', 'branch', 'pr']) if (opt[k]) n += links.addLink(t.id, k, opt[k]);
      if (!opt.file && !opt.commit && !opt.branch && !opt.pr) links.linkGit(t.id, t.project);
      return console.log(`linked on #${t.id}${n ? ` (${n} new)` : ''}`);
    }
    case 'why': {
      if (!pos[0]) throw new Error('usage: ctask why <file>');
      const rows = links.why(pos[0], { project, all: opt.all });
      return print(rows, rows.length ? rows.map((r) => `${taskLine(r, { showProject: opt.all })}  [${r.file}]`).join('\n') : `no task is linked to ${pos[0]}`);
    }
    case 'review': {
      const r = review({ project, all: opt.all, staleDays: opt.stale ? Number(opt.stale) : undefined });
      return print(r, reviewText(r, { showProject: opt.all }));
    }
    case 'playbook': {
      const [sub, name, ...restPos] = pos;
      if (sub === 'list' || !sub) {
        const rows = playbooks.listPlaybooks();
        return print(rows, rows.length ? rows.map((b) => `${b.name} — ${b.title} (${b.steps.length} steps)`).join('\n') : '(no playbooks) — save one: ctask playbook save <name> --from <task id>');
      }
      if (!name) throw new Error(`usage: ctask playbook ${sub} <name>`);
      if (sub === 'save') {
        const pb = playbooks.savePlaybook(name, { from: opt.from, title: opt.title, body: opt.body, instructions: opt.instructions, accept: opt.accept, steps: opt.steps });
        return print(pb, `saved playbook ${playbookText(pb)}`);
      }
      if (sub === 'show') {
        const pb = playbooks.getPlaybook(name);
        return print(pb, playbookText(pb));
      }
      if (sub === 'rm') return console.log(`removed playbook ${playbooks.removePlaybook(name).name}`);
      if (sub === 'run') {
        const res = playbooks.runPlaybook(name, { subject: restPos.join(' ') || undefined, project, start: opt.start, priority: opt.priority, parallel: opt.parallel });
        return print(res, [`created ${taskLine(res.task)}`, ...res.steps.map((s) => `  ${taskLine(s)}`)].join('\n'));
      }
      throw new Error('usage: ctask playbook save|run|list|show|rm');
    }
    case 'rm': {
      const t = core.removeTask(needId());
      return console.log(`removed #${t.id} ${t.title}`);
    }
    case 'archive': {
      if (pos[0]) {
        const t = core.archiveTask(pos[0]);
        return print(t, taskLine(t));
      }
      const rows = core.archiveOld({ older: opt.older, project, all: opt.all, dryRun: opt['dry-run'] });
      return print(rows, `${opt['dry-run'] ? 'would archive' : 'archived'} ${rows.length} closed task(s) older than ${opt.older ?? '30d'}` +
        (opt['dry-run'] && rows.length ? '\n' + taskList(rows.slice(0, 20), { showProject: opt.all }) : ''));
    }
    case 'unarchive': {
      const t = core.unarchiveTask(needId());
      return print(t, taskLine(t));
    }
    case 'show': {
      const d = core.taskDetail(needId());
      return print(d, taskDetailText(d));
    }
    case 'ls':
    case 'list':
    case 'due':
    case 'search': {
      if (cmd === 'search' && !pos.length) throw new Error('usage: ctask search <words>');
      const p = core.pageTasks({
        q: cmd === 'search' ? pos.join(' ') : undefined,
        project,
        all: opt.all,
        status: opt.status?.split(',').map((s) => s.trim()),
        kind: opt.kind,
        due: opt.due || cmd === 'due',
        closed: opt.closed || cmd === 'search',
        archived: opt.archived ? (cmd === 'search' ? true : 'only') : undefined,
        tag: opt.tag,
        parent: opt.parent,
        session: opt.mine ? core.currentSession(project) ?? '-' : opt.session,
        limit: opt.limit,
        page: opt.page,
      });
      return print(p.tasks, pageText(p, { showProject: opt.all }));
    }
    case 'next': {
      const tasks = core.nextTasks({ project, all: opt.all, limit: opt.limit ? Number(opt.limit) : undefined });
      return print(tasks, taskList(tasks, { showProject: opt.all }));
    }
    case 'projects': {
      const rows = core.projectsSummary();
      return print(rows, projectsText(rows));
    }
    case 'context':
      return import('./hooks.js').then((m) => console.log(m.digest(project, core.currentSession(project))));
    case 'tick':
      return import('./tick.js').then((m) => m.tick({ dryRun: opt['dry-run'] }));
    case 'daemon':
      return import('./tick.js').then((m) => m.daemon(pos[0], fileURLToPath(new URL('../bin/ctask', import.meta.url))));
    default:
      throw new Error(`unknown command "${cmd}" — run \`ctask help\``);
  }
}

// Every command is logged (hooks and the MCP server log themselves; the viewers are not worth logging).
const argv = process.argv.slice(2);
const logged = argv[0] && !['hook', 'mcp', 'help', '--help', '-h', 'version', '--version', 'log', 'stats', 'context', 'tick', 'daemon'].includes(argv[0]);
const record = (err) => {
  if (!logged) return;
  let project;
  let session;
  try {
    project = core.resolveProject();
    session = core.currentSession(project);
  } catch {}
  const sub = ['memory', 'playbook'].includes(argv[0]) && /^(update|merge|show|review|save|run|list|rm)$/.test(argv[1] ?? '') ? ` ${argv[1]}` : '';
  logCall({ source: 'cli', name: argv[0] + sub, args: argv.slice(sub ? 2 : 1).join(' '), session, project, ms: process.uptime() * 1000, ok: !err, error: err?.message });
};
try {
  await main(argv);
  record();
} catch (err) {
  console.error(`ctask: ${err.message}`);
  process.exitCode = 1;
  record(err);
}
