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
  if (t.waiting_on) meta.push(`after ${String(t.waiting_on).split(',').map((i) => `#${i}`).join(', ')}`);
  if (t.tags) meta.push(`tags: ${t.tags}`);
  if (t.archived_at) meta.push('archived');
  if (showProject) meta.push(projectName(t.project));
  return parts.join(' ') + (meta.length ? `  — ${meta.join(' · ')}` : '');
}

export function taskList(tasks, opts) {
  return tasks.length ? tasks.map((t) => taskLine(t, opts)).join('\n') : '(no tasks)';
}

export function taskDetailText({ task: t, children, events, links = [], deps = { after: [], before: [] } }) {
  const out = [taskLine(t)];
  out.push(`project: ${t.project}`);
  out.push(`session: ${t.session_id ?? '-'}${t.kind === 'automation' ? ` (run: ${t.resume ? 'resume session' : 'fresh'})` : ''}`);
  out.push(`created: ${fmtLocal(t.created_at)} · updated: ${fmtLocal(t.updated_at)}${t.completed_at ? ` · completed: ${fmtLocal(t.completed_at)}` : ''}`);
  if (t.last_run) out.push(`last run: ${fmtLocal(t.last_run)} · runs: ${t.run_count}`);
  if (t.body) out.push('', 'BODY:', t.body);
  if (t.instructions) out.push('', 'INSTRUCTIONS:', t.instructions);
  if (t.accept) out.push('', 'ACCEPTANCE (must be true before done):', t.accept);
  if (deps.after.length) out.push('', 'AFTER (must be closed first):', ...deps.after.map((d) => `  ${taskLine(d)}`));
  if (deps.before.length) out.push('', 'UNBLOCKS:', ...deps.before.map((d) => `  ${taskLine(d)}`));
  if (children.length) out.push('', 'STEPS:', ...children.map((c) => `  ${taskLine(c)}`));
  if (links.length) {
    const of = (k) => links.filter((l) => l.kind === k).map((l) => l.ref);
    out.push('', 'LINKS:');
    for (const k of ['branch', 'commit', 'pr']) if (of(k).length) out.push(`  ${k}: ${of(k).join(', ')}`);
    const files = of('file');
    if (files.length) out.push(`  files (${files.length}): ${files.slice(-25).join(', ')}${files.length > 25 ? ' …' : ''}`);
  }
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

export function reviewText(r, { showProject = false } = {}) {
  const out = [];
  const section = (label, items) => {
    if (items.length) out.push(`${label} (${items.length}):`, ...items.map((t) => `  ${taskLine(t, { showProject })}`));
  };
  section('DUE', r.due);
  section('WAITING ON YOU', r.waiting);
  section('BLOCKED', r.blocked);
  section(`STALLED (in progress, untouched for ${r.staleDays}+ days)`, r.stale);
  out.push(`Done in the last 24h: ${r.doneToday}`);
  return out.length === 1 ? `Nothing needs attention. ${out[0]}` : out.join('\n');
}

export function playbookText(pb) {
  const out = [`${pb.name} — ${pb.title}`];
  if (pb.body) out.push('', 'BODY:', pb.body);
  if (pb.instructions) out.push('', 'INSTRUCTIONS:', pb.instructions);
  if (pb.accept) out.push('', 'ACCEPTANCE:', pb.accept);
  if (pb.steps.length) out.push('', 'STEPS (each waits on the one before):', ...pb.steps.map((s, i) => `  ${i + 1}. ${s.title}${s.instructions ? ` — ${s.instructions}` : ''}`));
  return out.join('\n');
}
