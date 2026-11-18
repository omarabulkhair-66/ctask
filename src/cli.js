import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import { dbPath } from './db.js';
import { pageText, projectsText, taskDetailText, taskLine, taskList } from './format.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `ctask ${VERSION} — persistent task engine for Claude (tasks, steps, reminders, automations)

Create
  ctask add <title> [--body T] [--instructions T] [--kind task|step|reminder|automation]
                    [--priority 1|2|3] [--parent ID] [--tags a,b] [--next WHEN] [--every 30m|2h|1d|1w]
                    [--start] [--resume] [--project DIR] [--session ID]
Work
  ctask start|done|block|wait|cancel|reopen <id> [--note T]
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

const BOOL = new Set(['archived', 'json', 'all', 'due', 'mine', 'closed', 'dry-run', 'help', 'start', 'resume']);

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
    const t = core.setStatus(needId(), STATUS_VERBS[cmd], { note: opt.note ?? (pos.slice(1).join(' ') || undefined) });
    return print(t, taskLine(t));
  }

  switch (cmd) {
    case 'add': {
      let t = core.addTask({ ...opt, title: pos.join(' '), project });
      if (opt.start) t = core.setStatus(t.id, 'in_progress');
      return print(t, `created ${taskLine(t)}`);
    }
    case 'update': {
      const { note, json, ...patch } = opt;
      const t = core.updateTask(needId(), patch, { note });
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
      const tasks = core.nextTasks({ project, all: opt.all });
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

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(`ctask: ${err.message}`);
  process.exitCode = 1;
}
