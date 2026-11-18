// Minimal MCP server over stdio (newline-delimited JSON-RPC), no dependencies.
// Same engine as the CLI, for Claude surfaces that have no shell.
import readline from 'node:readline';
import * as core from './core.js';
import { logCall } from './log.js';
import * as memory from './memory.js';
import { pageText, projectsText, taskDetailText, taskLine, taskList } from './format.js';

const str = (description) => ({ type: 'string', description });
const WHEN = 'e.g. "30m", "2h", "tomorrow 9:00", "2026-12-01 14:00" (local time), or ISO';

const TOOLS = [
  {
    name: 'task_add',
    description:
      'Create a persistent task, step, reminder or automation. Use for multi-step work, anything spanning sessions, and anything the user asks to be reminded of.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: str('Short imperative title'),
        body: str('What and why — context a future session needs'),
        instructions: str('How to carry it out (used verbatim when run as an automation)'),
        accept: str('Acceptance criteria: what must be true before it can be marked done'),
        after: { type: 'array', items: { type: 'integer' }, description: 'Ids of tasks that must be closed before this one can start' },
        kind: { type: 'string', enum: core.KINDS },
        priority: { type: 'integer', enum: [1, 2, 3], description: '1 high, 2 normal, 3 low' },
        parent: { type: 'integer', description: 'Parent task id (makes this a step)' },
        next: str(`When it is due / next runs: ${WHEN}`),
        every: str('Repeat interval: 30m, 2h, 1d, 1w'),
        tags: str('Comma-separated tags'),
        project: str('Project directory (absolute path). Defaults to the server working directory.'),
        start: { type: 'boolean', description: 'Mark in_progress immediately' },
      },
    },
    run(a) {
      let t = core.addTask(a);
      if (a.start) t = core.setStatus(t.id, 'in_progress');
      return `created ${taskLine(t)}`;
    },
  },
  {
    name: 'task_list',
    description:
      'List or search tasks, 50 per page. Defaults to open tasks in the current project; set all=true for every project. With query, searches title, body, instructions, tags and notes, including closed tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project directory (absolute path)'),
        all: { type: 'boolean', description: 'All projects' },
        query: str('Words to search for; every word must match'),
        limit: { type: 'integer', description: 'Page size (default 50)' },
        page: { type: 'integer', description: 'Page number, starting at 1' },
        status: { type: 'array', items: { type: 'string', enum: core.STATUSES } },
        kind: { type: 'string', enum: core.KINDS },
        due: { type: 'boolean', description: 'Only items whose due time has passed' },
        closed: { type: 'boolean', description: 'Include done/cancelled' },
        archived: { type: 'boolean', description: 'Also include archived (old closed) tasks' },
        summary: { type: 'boolean', description: 'Return per-project counts instead of tasks' },
      },
    },
    run(a) {
      if (a.summary) return projectsText(core.projectsSummary());
      const f = { ...a, q: a.query, closed: a.closed || !!a.query, project: a.project ? core.resolveProject(a.project) : undefined };
      return pageText(core.pageTasks(f), { showProject: !!a.all });
    },
  },
  {
    name: 'task_get',
    description: 'Full detail of one task: body, instructions, steps and its log.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    run: (a) => taskDetailText(core.taskDetail(a.id)),
  },
  {
    name: 'task_update',
    description:
      'Update a task: change status (todo, in_progress, blocked, waiting = waiting on the user, done, cancelled), add a progress note, reschedule, or edit fields. Marking a recurring task done reschedules it.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: core.STATUSES },
        note: str('Progress / result / reason, appended to the task log. Required when status is done: say what you ran or checked.'),
        accept: str('Acceptance criteria, or "none" to clear'),
        after: { type: 'array', items: { type: 'integer' }, description: 'Replace the tasks this one waits on' },
        force: { type: 'boolean', description: 'Override the dependency, ownership and evidence checks' },
        title: str('New title'),
        body: str('New body'),
        instructions: str('New instructions'),
        priority: { type: 'integer', enum: [1, 2, 3] },
        next: str(`New due time: ${WHEN}, or "none" to clear`),
        every: str('New repeat interval, or "none" to clear'),
        tags: str('Comma-separated tags'),
      },
    },
    run({ id, note, force, ...patch }) {
      return `updated ${taskLine(core.updateTask(id, patch, { note, force }))}`;
    },
  },
  {
    name: 'memory_add',
    description:
      'Remember durable knowledge that future sessions must know: a rule, a user preference, a decision and its reason, a gotcha, or a fact. Not for work items. Refused if it duplicates an existing entry: use memory_update on that entry, or pass replaces.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: str('One self-contained statement, including the reason when it is a decision'),
        kind: { type: 'string', enum: memory.MEMORY_KINDS },
        global: { type: 'boolean', description: 'Applies to every project' },
        when: str('Comma-separated words or phrases that should always bring this memory back, e.g. "deploy, release"'),
        importance: { type: 'integer', enum: [1, 2, 3], description: '1 high, 2 normal, 3 low' },
        replaces: { type: 'array', items: { type: 'integer' }, description: 'Ids of memories this one supersedes' },
        force: { type: 'boolean', description: 'Store even if a similar entry exists' },
        project: str('Project directory (absolute path)'),
      },
    },
    run(a) {
      const project = core.resolveProject(a.project || undefined);
      return `remembered ${memory.memoryLine(memory.remember({ ...a, project, session: core.currentSession(project) }))}`;
    },
  },
  {
    name: 'memory_update',
    description: 'Correct or refine an existing memory in place (its previous version is kept as history). Use this instead of adding a second entry when something you knew turns out wrong, incomplete or out of date.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        text: str('The corrected statement'),
        kind: { type: 'string', enum: memory.MEMORY_KINDS },
        when: str('Trigger words, or "none" to clear'),
        importance: { type: 'integer', enum: [1, 2, 3] },
      },
    },
    run({ id, ...patch }) {
      const project = core.resolveProject();
      return `updated ${memory.memoryLine(memory.updateMemory(id, patch, { session: core.currentSession(project), project }))}`;
    },
  },
  {
    name: 'memory_recall',
    description: 'Memories relevant to a topic or a piece of work, ranked. Use before starting work in an area, or when unsure how something is done in this project.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: str('Topic, question or task description'), project: str('Project directory') } },
    run(a) {
      const project = core.resolveProject(a.project || undefined);
      const hits = memory.recall({ project, text: a.text, session: core.currentSession(project), how: 'manual' });
      return hits.length ? hits.map(memory.memoryLine).join('\n') : '(no memory is relevant to that)';
    },
  },
  {
    name: 'memory_list',
    description: 'Project memory (rules, decisions, gotchas, facts) for the current project, optionally filtered by words.',
    inputSchema: {
      type: 'object',
      properties: { query: str('Words that must all appear'), all: { type: 'boolean', description: 'Every project' }, project: str('Project directory') },
    },
    run(a) {
      const rows = memory.listMemory({ project: core.resolveProject(a.project || undefined), all: a.all, q: a.query });
      return rows.length ? rows.map(memory.memoryLine).join('\n') : '(nothing remembered)';
    },
  },
  {
    name: 'task_next',
    description: 'What to work on now: due items first, then in-progress, then ready todos.',
    inputSchema: {
      type: 'object',
      properties: { project: str('Project directory'), all: { type: 'boolean', description: 'All projects' } },
    },
    run(a) {
      const project = a.project ? core.resolveProject(a.project) : undefined;
      return taskList(core.nextTasks({ project, all: a.all }), { showProject: !!a.all });
    },
  },
];

export function handle(msg, version) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ctask', version },
        instructions:
          'ctask is a persistent task engine shared across Claude sessions and projects. Track multi-step work, reminders and follow-ups here and keep statuses current.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      const started = Date.now();
      const call = (extra) => {
        let project;
        try {
          project = core.resolveProject(msg.params?.arguments?.project || undefined);
        } catch {}
        logCall({ source: 'mcp', name: String(msg.params?.name), args: JSON.stringify(msg.params?.arguments ?? {}), project, session: project && core.currentSession(project), ms: Date.now() - started, ...extra });
      };
      try {
        if (!tool) throw new Error(`unknown tool ${msg.params?.name}`);
        const text = tool.run(msg.params.arguments ?? {});
        call({ outChars: text.length });
        return reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        call({ ok: false, error: err.message });
        return reply({ content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
      }
    }
    default:
      if (msg.id === undefined) return null; // notification
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

export function serve(version) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let out;
    try {
      out = handle(JSON.parse(line), version);
    } catch {
      out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
    }
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
