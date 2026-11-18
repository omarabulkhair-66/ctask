import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEvery, parseWhen } from '../src/time.js';

const bin = fileURLToPath(new URL('../bin/ctask', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctask-test-'));
const env = { ...process.env, CTASK_DB: path.join(dir, 'db.sqlite'), CTASK_SESSION_ID: 'sess-test', CTASK_DAEMON: 'off', CTASK_NOTIFY: 'off', CTASK_ARCHIVE_AFTER: 'off' };
const run = (args, input) => execFileSync(process.execPath, [bin, ...args], { env, cwd: dir, input, encoding: 'utf8' });
const json = (args) => JSON.parse(run([...args, '--json']));

test('time parsing', () => {
  const now = new Date(2026, 10, 18, 12, 0, 0);
  assert.equal(parseEvery('2h'), 7200);
  assert.throws(() => parseEvery('soon'));
  assert.equal(new Date(parseWhen('30m', now)) - now, 30 * 60 * 1000);
  assert.equal(new Date(parseWhen('in 2d', now)) - now, 2 * 86400 * 1000);
  assert.deepEqual(new Date(parseWhen('tomorrow 9:30', now)), new Date(2026, 10, 19, 9, 30));
  assert.deepEqual(new Date(parseWhen('08:00', now)), new Date(2026, 10, 19, 8, 0)); // already past today
  assert.deepEqual(new Date(parseWhen('2026-12-01 14:00', now)), new Date(2026, 11, 1, 14, 0));
  assert.throws(() => parseWhen('whenever', now));
});

test('task lifecycle, steps and session ownership', () => {
  const t = json(['add', 'Ship', 'it', '--body', 'why', '--priority', '1']);
  assert.equal(t.title, 'Ship it');
  assert.equal(t.session_id, 'sess-test');
  const step = json(['add', 'Step one', '--parent', String(t.id)]);
  assert.equal(step.kind, 'step');
  assert.equal(json(['start', String(t.id)]).status, 'in_progress');
  run(['note', String(t.id), 'halfway']);
  const d = json(['show', String(t.id)]);
  assert.equal(d.children.length, 1);
  assert.ok(d.events.some((e) => e.note === 'halfway'));
  const done = json(['done', String(t.id), '--note', 'shipped']);
  assert.equal(done.status, 'done');
  assert.ok(done.completed_at);
  assert.ok(!json(['list']).some((x) => x.id === t.id));
});

test('reminders are due, recurring ones reschedule on done', () => {
  const r = json(['add', 'Ping client', '--next', 'now', '--every', '1d']);
  assert.equal(r.kind, 'reminder');
  assert.ok(json(['due']).some((x) => x.id === r.id));
  const after = json(['done', String(r.id)]);
  assert.equal(after.status, 'todo');
  assert.equal(after.run_count, 1);
  assert.ok(new Date(after.next_run) > new Date());
  assert.ok(!json(['due']).some((x) => x.id === r.id));
});

test('stop hook blocks only for untouched in-progress work', () => {
  const hook = (name, extra = {}) => run(['hook', name], JSON.stringify({ session_id: 'sess-test', cwd: dir, ...extra }));
  const t = json(['add', 'Guarded', '--start']);
  const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  wait();
  assert.match(JSON.parse(hook('user-prompt')).hookSpecificOutput.additionalContext, /active: #\d+ "Guarded"/);
  assert.equal(JSON.parse(hook('stop')).decision, 'block');
  assert.equal(hook('stop', { stop_hook_active: true }), '');
  wait();
  run(['note', String(t.id), 'still going']);
  assert.equal(hook('stop'), '');
  assert.match(JSON.parse(hook('session-start')).hookSpecificOutput.additionalContext, /IN PROGRESS/);
});

test('bad input fails cleanly', () => {
  assert.throws(() => run(['done', '9999']), /not found/);
  assert.throws(() => run(['add', 'x', '--kind', 'nope']), /bad kind/);
});

test('tick announces a due reminder once per due time', () => {
  const r = json(['add', 'Notify me', '--next', 'now']);
  assert.match(run(['tick']), new RegExp(`#${r.id} `));
  assert.doesNotMatch(run(['tick']), new RegExp(`#${r.id} `));
  run(['snooze', String(r.id), 'now']);
  assert.match(run(['tick']), new RegExp(`#${r.id} `));
});

test('search and pagination', () => {
  for (let i = 0; i < 7; i++) run(['add', `Paged item ${i}`, '--tags', 'bulk']);
  const closed = json(['add', 'Archive the quarterly فاتورة']);
  run(['done', String(closed.id), '--note', 'sent to accounting-team']);

  const page2 = run(['list', '--tag', 'bulk', '--limit', '3', '--page', '2']);
  assert.match(page2, /Paged item 3[\s\S]*Paged item 5/);
  assert.match(page2, /showing 4–6 of 7 · next: --page 3/);
  assert.match(run(['list', '--tag', 'bulk', '--limit', '3', '--page', '3']), /showing 7–7 of 7$/m);
  assert.match(run(['list', '--tag', 'bulk', '--page', '9']), /past the end/);

  assert.equal(json(['search', 'فاتورة'])[0].id, closed.id); // closed tasks are searchable
  assert.equal(json(['search', 'accounting-team'])[0].id, closed.id); // so are notes
  assert.equal(json(['search', 'quarterly', 'missingword']).length, 0); // every word must match
  assert.equal(json(['search', 'item_']).length, 0); // LIKE wildcards are literal
});

test('archiving hides old closed tasks without deleting them', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const age = (id, days) => {
    const db = new DatabaseSync(env.CTASK_DB);
    db.prepare('UPDATE tasks SET completed_at=? WHERE id=?').run(new Date(Date.now() - days * 86400e3).toISOString(), id);
    db.close();
  };
  const old = json(['add', 'Ancient xylophone job']);
  const recent = json(['add', 'Recent xylophone job']);
  const parent = json(['add', 'Open xylophone parent']);
  const step = json(['add', 'Old xylophone step', '--parent', String(parent.id)]);
  for (const t of [old, recent, step]) run(['done', String(t.id)]);
  age(old.id, 45);
  age(step.id, 45);

  assert.match(run(['archive', '--dry-run']), /would archive 1 /);
  assert.match(run(['archive']), /archived 1 /);
  const ids = (args) => json(args).map((t) => t.id);
  assert.deepEqual(ids(['search', 'xylophone']).sort(), [recent.id, parent.id, step.id].sort());
  assert.ok(ids(['search', 'xylophone', '--archived']).includes(old.id));
  assert.deepEqual(ids(['list', '--archived']), [old.id]);
  assert.equal(json(['show', String(old.id)]).task.title, 'Ancient xylophone job'); // still there

  assert.throws(() => run(['archive', String(parent.id)]), /still todo/);
  assert.equal(json(['reopen', String(old.id)]).archived_at, null);
  assert.equal(json(['archive', String(recent.id)]).archived_at !== null, true);
  assert.equal(json(['unarchive', String(recent.id)]).archived_at, null);
});
