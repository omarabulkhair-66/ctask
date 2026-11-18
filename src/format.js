import path from 'node:path';
import { fmtLocal, fmtRelative } from './time.js';

export const projectName = (p) => path.basename(p) || p;

export function taskLine(t, { showProject = false } = {}) {
  const parts = [`#${t.id}`, `[${t.status}]`];
  if (t.priority !== 2) parts.push(`p${t.priority}`);
  if (t.kind !== 'task') parts.push(t.kind);
  parts.push(t.title);
  const meta = [];
  if (t.next_run && !['done', 'cancelled'].includes(t.status)) {
    meta.push(`due ${fmtLocal(t.next_run)} (${fmtRelative(t.next_run)})`);
  }
  if (t.recur) meta.push(`every ${t.recur}`);
  if (t.parent_id) meta.push(`parent #${t.parent_id}`);
  if (t.tags) meta.push(`tags: ${t.tags}`);
  if (t.archived_at) meta.push('archived');
  if (showProject) meta.push(projectName(t.project));
  return parts.join(' ') + (meta.length ? `  — ${meta.join(' · ')}` : '');
}

export function taskList(tasks, opts) {
  return tasks.length ? tasks.map((t) => taskLine(t, opts)).join('\n') : '(no tasks)';
}

export function taskDetailText({ task: t, children, events }) {
  const out = [taskLine(t)];
  out.push(`project: ${t.project}`);
  out.push(`session: ${t.session_id ?? '-'}${t.kind === 'automation' ? ` (run: ${t.resume ? 'resume session' : 'fresh'})` : ''}`);
  out.push(`created: ${fmtLocal(t.created_at)} · updated: ${fmtLocal(t.updated_at)}${t.completed_at ? ` · completed: ${fmtLocal(t.completed_at)}` : ''}`);
  if (t.last_run) out.push(`last run: ${fmtLocal(t.last_run)} · runs: ${t.run_count}`);
  if (t.body) out.push('', 'BODY:', t.body);
  if (t.instructions) out.push('', 'INSTRUCTIONS:', t.instructions);
  if (children.length) out.push('', 'STEPS:', ...children.map((c) => `  ${taskLine(c)}`));
  if (events.length) {
    out.push('', 'LOG:');
    for (const e of events) out.push(`  ${fmtLocal(e.at)} ${e.type}${e.note ? `: ${e.note}` : ''}`);
  }
  return out.join('\n');
}

export function projectsText(rows) {
  if (!rows.length) return '(no open tasks in any project)';
  return rows
    .map((r) => {
      const bits = [`${r.open} open`];
      if (r.in_progress) bits.push(`${r.in_progress} in progress`);
      if (r.blocked) bits.push(`${r.blocked} blocked`);
      if (r.waiting) bits.push(`${r.waiting} waiting on user`);
      if (r.due) bits.push(`${r.due} DUE`);
      return `${projectName(r.project)}: ${bits.join(', ')}  — ${r.project}`;
    })
    .join('\n');
}

/** Footer for a paged result; empty when everything fits on one page. */
export function pageFooter(p) {
  if (p.total <= p.tasks.length && p.page === 1) return '';
  if (!p.tasks.length) return `(page ${p.page} is past the end: ${p.total} tasks, ${p.pages} pages)`;
  return `showing ${p.from}–${p.to} of ${p.total}${p.page < p.pages ? ` · next: --page ${p.page + 1}` : ''}`;
}

export function pageText(p, opts) {
  const footer = pageFooter(p);
  return p.total === 0 ? '(no tasks)' : [p.tasks.length ? taskList(p.tasks, opts) : null, footer].filter(Boolean).join('\n');
}
