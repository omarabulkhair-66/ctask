// Handoff notes: a compact record of where a session stood, built mechanically from its transcript
// just before the context is compacted or the session ends. No model call is involved, so it always
// happens. The next SessionStart injects it back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from './db.js';

const TAIL_BYTES = 1.5 * 1024 * 1024; // transcripts get large; the recent end is what matters
const clip = (s, n) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function findTranscript(input) {
  if (input.transcript_path && fs.existsSync(input.transcript_path)) return input.transcript_path;
  if (!/^[\w-]+$/.test(input.session_id ?? '')) return null;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  try {
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${input.session_id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {}
  return null;
}

function readTail(file) {
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is probably cut in half
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/** Pull the recent state out of a Claude Code transcript (JSONL). Returns null if there is nothing useful. */
export function summarizeTranscript(file, cwd) {
  const asks = [];
  const files = [];
  const commands = [];
  let lastText = '';
  for (const line of readTail(file)) {
    if (!line) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.isSidechain || j.isMeta) continue;
    const content = j.message?.content;
    if (j.type === 'user' && typeof content === 'string') {
      // Skip harness-generated turns (notifications, reminders, interruptions).
      if (content.trim() && !/^\s*[<[]/.test(content)) asks.push(clip(content, 300));
    } else if (j.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) lastText = c.text;
        if (c.type !== 'tool_use') continue;
        const p = c.input?.file_path ?? c.input?.notebook_path;
        if (p && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) {
          const rel = cwd && p.startsWith(cwd + path.sep) ? p.slice(cwd.length + 1) : p;
          if (files.includes(rel)) files.splice(files.indexOf(rel), 1);
          files.push(rel);
        }
        if (c.name === 'Bash' && (c.input?.description || c.input?.command)) {
          commands.push(clip(c.input.description || c.input.command, 120));
        }
      }
    }
  }
  if (!asks.length && !lastText && !files.length) return null;
  const out = [];
  if (asks.length) out.push('Last requests from the user:', ...asks.slice(-3).map((a) => `  - ${a}`));
  if (lastText) out.push('Where Claude left off:', `  ${clip(lastText, 1200)}`);
  if (files.length) out.push(`Files edited (most recent last): ${files.slice(-15).join(', ')}`);
  if (commands.length) out.push('Last commands:', ...commands.slice(-5).map((c) => `  - ${c}`));
  return out.join('\n');
}

/**
 * Save a handoff for the session and attach it to every task the session has in progress.
 * `reason` says what triggered it (compaction, session end, or written by Claude).
 */
export function saveHandoff(sessionId, text, reason) {
  const db = open();
  const now = new Date().toISOString();
  db.prepare('UPDATE sessions SET handoff=?, handoff_at=? WHERE session_id=?').run(text, now, sessionId);
  const tasks = db.prepare(`SELECT id FROM tasks WHERE session_id=? AND status='in_progress'`).all(sessionId);
  for (const t of tasks) {
    // One automatic handoff per task is enough: replace the previous automatic one.
    db.prepare(`DELETE FROM events WHERE task_id=? AND type='handoff' AND note LIKE '[auto%'`).run(t.id);
    db.prepare('INSERT INTO events(task_id, at, session_id, type, note) VALUES(?,?,?,?,?)').run(
      t.id,
      now,
      sessionId,
      'handoff',
      `[auto, ${reason}]\n${text}`,
    );
  }
  return tasks.length;
}

export function latestTaskHandoff(taskId) {
  return open()
    .prepare(`SELECT at, note FROM events WHERE task_id=? AND type='handoff' ORDER BY id DESC LIMIT 1`)
    .get(taskId);
}

/** The handoff to show a starting session: its own (after compaction/resume), else the project's latest. */
export function handoffFor(sessionId, project, { maxAgeDays = 14 } = {}) {
  const db = open();
  const own = sessionId
    ? db.prepare('SELECT session_id, handoff, handoff_at FROM sessions WHERE session_id=? AND handoff IS NOT NULL').get(sessionId)
    : undefined;
  if (own) return { ...own, own: true };
  const cutoff = new Date(Date.now() - maxAgeDays * 86400e3).toISOString();
  const other = db
    .prepare(
      `SELECT session_id, handoff, handoff_at FROM sessions
       WHERE project=? AND handoff IS NOT NULL AND handoff_at>? AND session_id IS NOT ?
       ORDER BY handoff_at DESC LIMIT 1`,
    )
    .get(project, cutoff, sessionId ?? null);
  return other ? { ...other, own: false } : null;
}

/** Absolute paths of files edited since the user's last message (the current turn). */
export function turnFiles(file) {
  let files = [];
  for (const line of readTail(file)) {
    if (!line) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.isSidechain || j.isMeta) continue;
    const content = j.message?.content;
    if (j.type === 'user' && typeof content === 'string' && content.trim() && !/^\s*[<[]/.test(content)) files = [];
    else if (j.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        const p = c.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && (c.input?.file_path ?? c.input?.notebook_path);
        if (p && !files.includes(p)) files.push(p);
      }
    }
  }
  return files;
}
