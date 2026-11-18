// The background side of ctask: shows a macOS notification for anything that comes due, runs due
// automations headlessly with `claude -p`, and manages the launchd agent that does both every minute.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addNote, archiveOld, setStatus } from './core.js';
import { homeDir, open } from './db.js';
import { projectName, taskLine } from './format.js';

const LABEL = 'com.ctask.tick';
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export function dueAutomations() {
  return open()
    .prepare(
      `SELECT * FROM tasks WHERE kind='automation' AND status='todo' AND next_run IS NOT NULL AND next_run<=?
       ORDER BY next_run`,
    )
    .all(new Date().toISOString());
}

function prompt(t) {
  return [
    `[ctask automation #${t.id}] ${t.title}`,
    t.body && `Context:\n${t.body}`,
    t.instructions && `Instructions:\n${t.instructions}`,
    `This is an unattended scheduled run. Do the work, then end with a short result summary. ` +
      `Record anything a later run needs with: ctask note ${t.id} "<text>". Do not mark the task done yourself.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Due reminders/tasks that have not been announced for their current due time. */
export function dueUnnotified() {
  return open()
    .prepare(
      `SELECT * FROM tasks WHERE kind!='automation' AND status IN ('todo','in_progress','blocked','waiting')
         AND next_run IS NOT NULL AND next_run<=? AND (notified_at IS NULL OR notified_at<next_run)
       ORDER BY next_run`,
    )
    .all(new Date().toISOString());
}

function notify(t) {
  if (process.platform !== 'darwin' || process.env.CTASK_NOTIFY === 'off') return false;
  const q = (s) => JSON.stringify(String(s)); // AppleScript string literals use the same escapes
  const script = `display notification ${q(t.title)} with title "ctask reminder" subtitle ${q(projectName(t.project))} sound name "Glass"`;
  return spawnSync('osascript', ['-e', script], { timeout: 5000 }).status === 0;
}

export function notifyDue({ dryRun = false, log = console.log } = {}) {
  for (const t of dueUnnotified()) {
    if (dryRun) {
      log(`would notify ${taskLine(t)}`);
      continue;
    }
    const shown = notify(t);
    // Mark it either way so a machine that cannot show notifications does not retry every minute.
    open().prepare('UPDATE tasks SET notified_at=? WHERE id=?').run(new Date().toISOString(), t.id);
    log(`${shown ? 'notified' : 'due (no notification shown)'} ${taskLine(t)}`);
  }
}

export function tick({ dryRun = false, log = console.log } = {}) {
  notifyDue({ dryRun, log });
  // Housekeeping: old closed tasks drop out of lists and search (they stay in the database).
  const after = process.env.CTASK_ARCHIVE_AFTER || '30d';
  if (after !== 'off') {
    const n = archiveOld({ older: after, all: true, dryRun }).length;
    if (n) log(`${dryRun ? 'would archive' : 'archived'} ${n} closed task(s) older than ${after}`);
  }
  const due = dueAutomations();
  for (const t of due) {
    if (dryRun) {
      log(`would run ${taskLine(t)}`);
      continue;
    }
    // Claim it so an overlapping tick cannot run it twice.
    const claimed = open()
      .prepare(`UPDATE tasks SET status='in_progress', updated_at=? WHERE id=? AND status='todo'`)
      .run(new Date().toISOString(), t.id);
    if (!claimed.changes) continue;

    log(`running ${taskLine(t)}`);
    const args = ['-p', prompt(t)];
    if (t.resume && t.session_id) args.unshift('--resume', t.session_id);
    const cwd = fs.existsSync(t.project) ? t.project : os.homedir();
    const res = spawnSync(process.env.CTASK_CLAUDE_BIN || 'claude', args, {
      cwd,
      encoding: 'utf8',
      timeout: Number(process.env.CTASK_RUN_TIMEOUT_MS) || 30 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CTASK_STOP_GUARD: 'off' },
    });
    const ok = !res.error && res.status === 0;
    const tail = (res.error?.message || (ok ? res.stdout : res.stderr || res.stdout) || '').trim().slice(-1500);
    addNote(t.id, `${ok ? 'run ok' : `run FAILED (exit ${res.status ?? 'n/a'})`}: ${tail || '(no output)'}`, {
      type: 'run',
      session: null,
    });
    // Recurring automations always go back on schedule; a failed one-shot is parked as blocked.
    setStatus(t.id, ok || t.recur ? 'done' : 'blocked', { session: null });
    log(`  ${ok ? 'ok' : 'failed'}`);
  }
}

const target = () => `gui/${process.getuid()}`;
const launchctl = (...a) => spawnSync('launchctl', a, { encoding: 'utf8' });
const loaded = () => launchctl('print', `${target()}/${LABEL}`).status === 0;

function install(cliPath) {
  const file = plistPath();
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const logFile = path.join(homeDir(), 'tick.log');
  // launchd starts with a bare PATH: keep node's own directory first, then whatever we have now.
  const envPath = [...new Set([path.dirname(process.execPath), ...(process.env.PATH || '').split(':'), '/usr/bin', '/bin'])]
    .filter(Boolean)
    .join(':');
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(process.execPath)}</string><string>${esc(cliPath)}</string><string>tick</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${esc(envPath)}</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(logFile)}</string>
  <key>StandardErrorPath</key><string>${esc(logFile)}</string>
</dict></plist>
`,
  );
  launchctl('bootout', `${target()}/${LABEL}`);
  const r = launchctl('bootstrap', target(), file);
  if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  return logFile;
}

/**
 * Called by the SessionStart hook so the plugin looks after its own background checker: installs it
 * if missing, and repairs it if the plugin or node moved. Opt out with CTASK_DAEMON=off.
 */
export function ensureDaemon(cliPath) {
  if (process.platform !== 'darwin' || process.env.CTASK_DAEMON === 'off') return;
  if (fs.existsSync(path.join(homeDir(), 'daemon.off'))) return; // user ran `ctask daemon uninstall`
  let current = '';
  try {
    current = fs.readFileSync(plistPath(), 'utf8');
  } catch {}
  const upToDate = current.includes(`<string>${cliPath}</string>`) && current.includes(`<string>${process.execPath}</string>`);
  if (!upToDate || !loaded()) install(cliPath);
}

export function daemon(action, cliPath, log = console.log) {
  const off = path.join(homeDir(), 'daemon.off');
  if (action === 'status') {
    return log(loaded() ? `installed and loaded (${plistPath()})` : fs.existsSync(plistPath()) ? 'plist exists but is not loaded' : 'not installed');
  }
  if (action === 'uninstall') {
    launchctl('bootout', `${target()}/${LABEL}`);
    fs.rmSync(plistPath(), { force: true });
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(off, 'ctask daemon uninstall was run; `ctask daemon install` re-enables it\n');
    return log('uninstalled (the plugin will not reinstall it until you run `ctask daemon install`)');
  }
  if (action !== 'install') throw new Error('usage: ctask daemon install|uninstall|status');
  if (process.platform !== 'darwin') throw new Error('the background checker supports macOS (launchd) only; run `ctask tick` from cron instead');
  fs.rmSync(off, { force: true });
  log(`installed: checks every 60s for due reminders and automations, log at ${install(cliPath)}`);
}
