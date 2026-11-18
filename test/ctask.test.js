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
const env = { ...process.env, CTASK_DB: path.join(dir, 'db.sqlite'), CTASK_SESSION_ID: 'sess-test', CTASK_DAEMON: 'off', CTASK_NOTIFY: 'off', CTASK_ARCHIVE_AFTER: 'off', CTASK_REVIEW_AT: 'off' };
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
  for (const t of [old, recent, step]) run(['done', String(t.id), '--note', 'checked']);
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

test('background launcher survives a plugin update', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctask-home-'));
  const cache = path.join(home, 'plugins', 'cache', 'mk', 'ctask');
  const fake = (version) => {
    const bin = path.join(cache, version, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ctask'), '');
    fs.writeFileSync(path.join(bin, 'ctask-run'), `#!/bin/sh\necho "${version} $1"\n`, { mode: 0o755 });
    return path.join(bin, 'ctask');
  };
  const v1 = fake('1.0.0');
  process.env.CTASK_HOME = home;
  const { writeLauncher } = await import('../src/tick.js');
  const launcher = writeLauncher(v1);
  delete process.env.CTASK_HOME;
  const fire = () => execFileSync(launcher, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();
  assert.equal(fire(), '1.0.0 tick');

  fake('1.1.0'); // update: new version installed, old one removed
  fs.rmSync(path.join(cache, '1.0.0'), { recursive: true });
  assert.equal(fire(), '1.1.0 tick');

  fs.rmSync(cache, { recursive: true }); // plugin gone entirely: stay quiet
  assert.equal(fire(), '');
});

test('handoff is captured from the transcript and shown to the next session', () => {
  const transcript = path.join(dir, 'transcript.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(
    transcript,
    line({ type: 'user', message: { content: 'Migrate the billing tables' } }) +
      line({ type: 'user', message: { content: '<task-notification>ignored</task-notification>' } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }) +
      line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } }) +
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: path.join(dir, 'db/schema.sql') } },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
            { type: 'text', text: 'Two migrations applied, the third fails on a foreign key.' },
          ],
        },
      }) +
      'not json\n',
  );
  const hook = (name, session, extra = {}) => run(['hook', name], JSON.stringify({ session_id: session, cwd: dir, ...extra }));
  const t = json(['add', 'Billing migration', '--start', '--session', 'sess-ho']);
  run(['update', String(t.id), '--session', 'sess-ho']);
  assert.equal(hook('pre-compact', 'sess-ho', { transcript_path: transcript, trigger: 'auto' }), '');

  const detail = json(['show', String(t.id)]);
  const note = detail.events.find((e) => e.type === 'handoff').note;
  assert.match(note, /Migrate the billing tables/);
  assert.match(note, /third fails on a foreign key/);
  assert.match(note, /db\/schema\.sql/);
  assert.match(note, /Run the tests/);
  assert.doesNotMatch(note, /ignored|subagent chatter/);

  hook('pre-compact', 'sess-ho', { transcript_path: transcript }); // a second capture replaces the first
  assert.equal(json(['show', String(t.id)]).events.filter((e) => e.type === 'handoff').length, 1);

  const next = JSON.parse(hook('session-start', 'sess-after')).hookSpecificOutput.additionalContext;
  assert.match(next, new RegExp(`HANDOFF for #${t.id}[\\s\\S]*third fails on a foreign key`));
  assert.equal(hook('session-end', 'sess-none', { transcript_path: path.join(dir, 'missing.jsonl') }), '');
  run(['done', String(t.id), '--note', 'migrated', '--force']);
});

const fails = (args, re, extraEnv) =>
  assert.throws(() => execFileSync(process.execPath, [bin, ...args], { env: { ...env, ...extraEnv }, cwd: dir, encoding: 'utf8', stdio: 'pipe' }), re);
const as = (session, args) => execFileSync(process.execPath, [bin, ...args], { env: { ...env, CTASK_SESSION_ID: session }, cwd: dir, encoding: 'utf8', stdio: 'pipe' });

test('done needs evidence; acceptance criteria are shown', () => {
  const t = json(['add', 'Fix login', '--accept', 'login test passes']);
  fails(['done', String(t.id)], /needs evidence[\s\S]*login test passes/);
  assert.equal(json(['done', String(t.id), '--note', 'ran login test: green']).status, 'done');
  const r = json(['add', 'Call back', '--next', 'now']); // reminders are exempt
  assert.equal(json(['done', String(r.id)]).status, 'done');
  const f = json(['add', 'Skip it']);
  assert.equal(json(['done', String(f.id), '--force']).status, 'done');
});

test('dependencies order work and report what they unblock', () => {
  const a = json(['add', 'Dep schema']);
  const b = json(['add', 'Dep api', '--after', String(a.id)]);
  assert.equal(b.waiting_on, String(a.id));
  assert.match(run(['list']), new RegExp(`#${b.id} .*after #${a.id}`));
  assert.ok(!json(['next', '--limit', '50']).some((t) => t.id === b.id));
  fails(['start', String(b.id)], /waits on/);
  fails(['update', String(a.id), '--after', String(b.id)], /cycle/);
  assert.match(run(['done', String(a.id), '--note', 'schema applied']), new RegExp(`unblocked: #${b.id} Dep api`));
  assert.equal(json(['start', String(b.id)]).status, 'in_progress');
  run(['done', String(b.id), '--note', 'api ok']);
});

test('a task in progress in an active session cannot be taken by another', () => {
  run(['hook', 'user-prompt'], JSON.stringify({ session_id: 'sess-A', cwd: dir }));
  const t = JSON.parse(as('sess-A', ['add', 'Shared work', '--start', '--json']));
  assert.throws(() => as('sess-B', ['start', String(t.id)]), /in progress in another session/);
  assert.equal(JSON.parse(as('sess-B', ['start', String(t.id), '--force', '--json'])).session_id, 'sess-B');
  as('sess-B', ['cancel', String(t.id)]);
});

test('project memory is stored, searched and shown at session start', () => {
  const m = json(['remember', 'Never edit generated/ by hand, run make gen', '--kind', 'rule']);
  run(['remember', 'Chose Postgres over MySQL for JSONB', '--kind', 'decision']);
  assert.equal(json(['memory', 'postgres']).length, 1);
  assert.equal(json(['memory'])[0].id, m.id); // rules come first
  fails(['remember', 'x', '--kind', 'nope'], /bad kind/);
  const ctx = JSON.parse(run(['hook', 'session-start'], JSON.stringify({ session_id: 'sess-mem', cwd: dir }))).hookSpecificOutput.additionalContext;
  assert.match(ctx, /PROJECT MEMORY \(2\)[\s\S]*\[rule\] Never edit generated/);
  run(['forget', `m${m.id}`]);
  assert.equal(json(['memory']).length, 1);
});

test('files edited in a turn are linked to the task and found by why', () => {
  const transcript = path.join(dir, 'turn.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  const edit = (p) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(fs.realpathSync(dir), p) } }] } });
  fs.writeFileSync(transcript, line({ type: 'user', message: { content: 'earlier' } }) + edit('old/untouched.js') + line({ type: 'user', message: { content: 'now fix auth' } }) + edit('src/auth/login.js') + edit('src/auth/session.js'));
  const t = JSON.parse(as('sess-link', ['add', 'Fix auth', '--start', '--json']));
  run(['hook', 'user-prompt'], JSON.stringify({ session_id: 'sess-link', cwd: dir }));
  run(['note', String(t.id), 'working']);
  assert.equal(run(['hook', 'stop'], JSON.stringify({ session_id: 'sess-link', cwd: dir, transcript_path: transcript })), '');
  const files = json(['show', String(t.id)]).links.filter((l) => l.kind === 'file').map((l) => l.ref);
  assert.deepEqual(files.sort(), ['src/auth/login.js', 'src/auth/session.js']);
  assert.equal(json(['why', 'src/auth/login.js'])[0].id, t.id);
  assert.equal(json(['why', 'login.js'])[0].id, t.id); // suffix match
  assert.equal(json(['why', 'old/untouched.js']).length, 0);
  run(['link', String(t.id), '--pr', 'https://example.test/pr/1', '--commit', 'abc123']);
  assert.match(run(['show', String(t.id)]), /LINKS:[\s\S]*commit: abc123[\s\S]*pr: https/);
  as('sess-link', ['done', String(t.id), '--note', 'auth tests pass']);
});

test('playbooks save a recipe and replay it as ordered steps', () => {
  const src = json(['add', 'Release', '--instructions', 'follow the checklist', '--accept', 'tag pushed']);
  for (const s of ['Bump version', 'Run tests', 'Tag and push']) run(['add', s, '--parent', String(src.id)]);
  assert.match(run(['playbook', 'save', 'release', '--from', String(src.id)]), /saved playbook release/);
  assert.match(run(['playbook', 'list']), /release — Release \(3 steps\)/);
  const res = json(['playbook', 'run', 'release', 'v2.0']);
  assert.equal(res.task.title, 'Release: v2.0');
  assert.equal(res.task.accept, 'tag pushed');
  assert.deepEqual(res.steps.map((s) => s.title), ['Bump version', 'Run tests', 'Tag and push']);
  assert.equal(res.steps[0].waiting_on, null);
  assert.equal(res.steps[2].waiting_on, String(res.steps[1].id));
  run(['playbook', 'save', 'triage', '--title', 'Bug triage', '--steps', 'Reproduce; Find cause; Fix']);
  assert.equal(json(['playbook', 'show', 'triage']).steps.length, 3);
  const ctx = JSON.parse(run(['hook', 'session-start'], JSON.stringify({ session_id: 'sess-pb', cwd: dir }))).hookSpecificOutput.additionalContext;
  assert.match(ctx, /PLAYBOOKS: release, triage/);
  run(['playbook', 'rm', 'triage']);
  fails(['playbook', 'run', 'triage'], /not found/);
  fails(['playbook', 'save', 'Bad Name!', '--steps', 'a'], /name must be/);
});

test('review lists what needs attention', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const stalled = json(['add', 'Stalled work', '--start']);
  const waiting = json(['add', 'Needs a key']);
  run(['wait', String(waiting.id), '--note', 'need API key']);
  const db = new DatabaseSync(env.CTASK_DB);
  db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(new Date(Date.now() - 5 * 86400e3).toISOString(), stalled.id);
  db.close();
  const r = json(['review']);
  assert.ok(r.stale.some((t) => t.id === stalled.id));
  assert.ok(r.waiting.some((t) => t.id === waiting.id));
  assert.match(run(['review']), /WAITING ON YOU[\s\S]*STALLED/);
});
