// Review: what needs attention across projects. Run by hand, and once a day by the background checker.
import { spawnSync } from 'node:child_process';
import { open } from './db.js';

/** filter: { project, all, staleDays } */
export function review({ project, all = false, staleDays = 3 } = {}) {
  const db = open();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - staleDays * 86400e3).toISOString();
  const dayAgo = new Date(Date.now() - 86400e3).toISOString();
  const scope = all ? '' : 'AND project=?';
  const a = all ? [] : [project];
  const q = (cond, ...args) => db.prepare(`SELECT * FROM tasks WHERE archived_at IS NULL AND ${cond} ${scope} ORDER BY project, priority, id LIMIT 50`).all(...args, ...a);
  return {
    due: q(`status IN ('todo','in_progress','blocked','waiting') AND next_run IS NOT NULL AND next_run<=?`, now),
    waiting: q(`status='waiting'`),
    blocked: q(`status='blocked'`),
    stale: q(`status='in_progress' AND updated_at<?`, staleBefore),
    doneToday: db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status='done' AND completed_at>? ${scope}`).get(dayAgo, ...a).n,
    staleDays,
  };
}

export const reviewSummary = (r) =>
  [
    r.due.length && `${r.due.length} due`,
    r.waiting.length && `${r.waiting.length} waiting on you`,
    r.blocked.length && `${r.blocked.length} blocked`,
    r.stale.length && `${r.stale.length} stalled`,
  ]
    .filter(Boolean)
    .join(', ');

/**
 * Once a day, at or after CTASK_REVIEW_AT (default 09:00 local), show a notification summarising
 * what needs attention in every project. Returns the summary if one was shown.
 */
export function dailyReview({ dryRun = false } = {}) {
  const at = process.env.CTASK_REVIEW_AT || '09:00';
  if (at === 'off') return null;
  const nowD = new Date();
  const [h, m] = at.split(':').map(Number);
  if (nowD.getHours() * 60 + nowD.getMinutes() < h * 60 + (m || 0)) return null;
  const today = `${nowD.getFullYear()}-${nowD.getMonth() + 1}-${nowD.getDate()}`;
  const db = open();
  if (db.prepare(`SELECT value FROM meta WHERE key='review_day'`).get()?.value === today) return null;
  const summary = reviewSummary(review({ all: true }));
  if (dryRun) return summary || null;
  db.prepare(`INSERT INTO meta(key, value) VALUES('review_day', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(today);
  if (!summary) return null; // nothing needs attention: stay quiet
  if (process.platform === 'darwin' && process.env.CTASK_NOTIFY !== 'off') {
    const script = `display notification ${JSON.stringify(summary)} with title "ctask daily review" subtitle "ask Claude: ctask review --all"`;
    spawnSync('osascript', ['-e', script], { timeout: 5000 });
  }
  return summary;
}
