// Project memory: durable knowledge about a project (decisions, rules, gotchas, facts).
// Unlike tasks it is never "done": it is shown to every session that starts in the project.
import { open } from './db.js';

export const MEMORY_KINDS = ['rule', 'decision', 'gotcha', 'fact'];
const RANK = `CASE kind WHEN 'rule' THEN 0 WHEN 'gotcha' THEN 1 WHEN 'decision' THEN 2 ELSE 3 END`;

export function remember({ text, kind = 'fact', project, global = false, session = null }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('usage: ctask remember <text> [--kind rule|decision|gotcha|fact] [--global]');
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`bad kind "${kind}" (one of: ${MEMORY_KINDS.join(', ')})`);
  const { lastInsertRowid } = open()
    .prepare('INSERT INTO memory(project, kind, text, session_id, created_at) VALUES(?,?,?,?,?)')
    .run(global ? null : project, kind, body, session, new Date().toISOString());
  return open().prepare('SELECT * FROM memory WHERE id=?').get(Number(lastInsertRowid));
}

/** Memory for a project (plus global entries), rules first. `q`: every word must match. */
export function listMemory({ project, all = false, q, kind, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (!all) {
    where.push('(project=? OR project IS NULL)');
    args.push(project);
  }
  if (kind) {
    where.push('kind=?');
    args.push(kind);
  }
  for (const word of String(q ?? '').split(/\s+/).filter(Boolean)) {
    where.push(`text LIKE ? ESCAPE '\\'`);
    args.push(`%${word.replace(/[\\%_]/g, '\\$&')}%`);
  }
  return open()
    .prepare(`SELECT * FROM memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${RANK}, id DESC LIMIT ?`)
    .all(...args, limit);
}

export function countMemory(project) {
  return open().prepare('SELECT COUNT(*) AS n FROM memory WHERE project=? OR project IS NULL').get(project).n;
}

export function forget(id) {
  const n = Number(String(id).replace(/^m/i, ''));
  const row = Number.isInteger(n) ? open().prepare('SELECT * FROM memory WHERE id=?').get(n) : undefined;
  if (!row) throw new Error(`memory ${id} not found`);
  open().prepare('DELETE FROM memory WHERE id=?').run(n);
  return row;
}

export const memoryLine = (m) => `m${m.id} [${m.kind}]${m.project ? '' : ' (global)'} ${m.text}`;
