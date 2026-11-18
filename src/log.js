// Call log: one row for every hook that fires, every ctask command and every MCP tool call.
// It answers "what is ctask actually doing in my sessions, and what does it cost?".
import { open } from './db.js';

/** Never throws: logging must not break the thing being logged. */
export function logCall({ source, name, args, session, project, ms, outChars = 0, ok = true, error, detail }) {
  try {
    if (process.env.CTASK_LOG === 'off') return;
    open()
      .prepare(
        `INSERT INTO calls(at, source, name, args, session_id, project, ms, out_chars, ok, error, detail)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        new Date().toISOString(),
        source,
        name,
        args ? String(args).slice(0, 300) : null,
        session ?? null,
        project ?? null,
        ms != null ? Math.round(ms) : null,
        outChars,
        ok ? 1 : 0,
        error ? String(error).split('\n')[0].slice(0, 300) : null,
        detail && Object.keys(detail).length ? JSON.stringify(detail) : null,
      );
  } catch {}
}

/** filter: { limit, source, name, session, project, all, failed } — newest last. */
export function readLog({ limit = 40, source, name, session, project, all = true, failed = false } = {}) {
  const where = [];
  const args = [];
  const add = (cond, v) => {
    where.push(cond);
    args.push(v);
  };
  if (source) add('source=?', source);
  if (name) add('name LIKE ?', `%${name}%`);
  if (session) add('session_id=?', session);
  if (!all && project) add('project=?', project);
  if (failed) where.push('ok=0');
  return open()
    .prepare(`SELECT * FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit)
    .reverse();
}

export function pruneLog(days = Number(process.env.CTASK_LOG_DAYS) || 90) {
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
  const db = open();
  db.prepare('DELETE FROM recalls WHERE at<?').run(cutoff);
  return db.prepare('DELETE FROM calls WHERE at<?').run(cutoff).changes;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

/** Everything ctask did in the period, in numbers. filter: { days, project, all } */
export function stats({ days = 7, project, all = false } = {}) {
  const db = open();
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const scope = all ? '' : 'AND project=?';
  const a = all ? [since] : [since, project];
  const calls = db.prepare(`SELECT * FROM calls WHERE at>? ${scope}`).all(...a);
  const hooks = calls.filter((c) => c.source === 'hook');
  const detail = (c) => {
    try {
      return c.detail ? JSON.parse(c.detail) : {};
    } catch {
      return {};
    }
  };
  const count = (list, f) => list.filter(f).length;
  const byName = (list) => {
    const m = {};
    for (const c of list) m[c.name] = (m[c.name] ?? 0) + 1;
    return Object.entries(m).sort((x, y) => y[1] - x[1]);
  };
  const hookMs = hooks.map((c) => c.ms ?? 0).sort((x, y) => x - y);
  const injected = hooks.reduce((n, c) => n + (c.out_chars ?? 0), 0);
  const prompts = count(hooks, (c) => c.name === 'user-prompt');
  const failed = calls.filter((c) => !c.ok);
  const refused = (re) => count(failed, (c) => re.test(c.error ?? ''));

  const tScope = all ? '' : 'AND t.project=?';
  const ev = (cond) => db.prepare(`SELECT COUNT(*) AS n FROM events e JOIN tasks t ON t.id=e.task_id WHERE e.at>? ${tScope} AND ${cond}`).get(...a).n;
  const mScope = all ? '' : 'AND (m.project=? OR m.project IS NULL)';
  const recalls = db.prepare(`SELECT r.how, r.memory_id, m.kind, m.text FROM recalls r JOIN memory m ON m.id=r.memory_id WHERE r.at>? ${mScope}`).all(...a);
  const top = {};
  for (const r of recalls.filter((x) => x.how !== 'start')) {
    top[r.memory_id] ??= { id: r.memory_id, kind: r.kind, text: r.text, n: 0 };
    top[r.memory_id].n++;
  }
  const memWrites = calls.filter((c) => c.ok && ((c.source === 'cli' && /^(remember|memory (update|merge)|forget)$/.test(c.name)) || (c.source === 'mcp' && /^memory_(add|update)$/.test(c.name))));

  return {
    days,
    scope: all ? 'all projects' : project,
    sessions: new Set(hooks.map((c) => c.session_id).filter(Boolean)).size,
    prompts,
    calls: { total: calls.length, hook: hooks.length, cli: count(calls, (c) => c.source === 'cli'), mcp: count(calls, (c) => c.source === 'mcp'), tick: count(calls, (c) => c.source === 'tick') },
    hooks: byName(hooks),
    commands: byName(calls.filter((c) => c.source === 'cli' || c.source === 'mcp')).slice(0, 10),
    context: { chars: injected, tokens: Math.round(injected / 4), perPrompt: prompts ? Math.round(hooks.filter((c) => c.name === 'user-prompt').reduce((n, c) => n + (c.out_chars ?? 0), 0) / prompts) : 0 },
    latency: { avg: hookMs.length ? Math.round(hookMs.reduce((x, y) => x + y, 0) / hookMs.length) : 0, p95: pct(hookMs, 0.95), max: hookMs.at(-1) ?? 0 },
    tasks: { created: ev(`e.type='created'`), done: ev(`e.type='status' AND e.note LIKE '%-> done%'`), notes: ev(`e.type='note'`), handoffsWritten: ev(`e.type='handoff' AND e.note NOT LIKE '[auto%'`) },
    guard: {
      stopBlocked: count(hooks, (c) => c.name === 'stop' && detail(c).blocked),
      noEvidence: refused(/needs evidence/),
      waitsOn: refused(/waits on/),
      otherSession: refused(/another session/),
      duplicateMemory: refused(/already remembered/),
    },
    handoff: { captured: count(hooks, (c) => detail(c).handoff === 'captured'), shown: count(hooks, (c) => detail(c).handoffShown) },
    files: hooks.reduce((n, c) => n + (detail(c).filesLinked ?? 0), 0),
    memory: {
      shownAtStart: count(recalls, (r) => r.how === 'start'),
      recalled: count(recalls, (r) => r.how === 'prompt'),
      manual: count(recalls, (r) => r.how === 'manual'),
      promptsWithRecall: count(hooks, (c) => c.name === 'user-prompt' && detail(c).recalled?.length),
      top: Object.values(top).sort((x, y) => y.n - x.n).slice(0, 5),
      written: count(memWrites, (c) => /remember|memory_add/.test(c.name)),
      edited: count(memWrites, (c) => /update|merge/.test(c.name)),
      forgotten: count(memWrites, (c) => c.name === 'forget'),
      nudges: { standing: count(hooks, (c) => detail(c).nudge === 'standing'), checkpoint: count(hooks, (c) => detail(c).nudge === 'checkpoint') },
    },
    tick: { notified: count(calls, (c) => c.source === 'tick' && c.name === 'notify'), automations: count(calls, (c) => c.source === 'tick' && c.name === 'automation'), reviews: count(calls, (c) => c.source === 'tick' && c.name === 'review') },
    errors: failed.length,
  };
}
