// Project memory: durable knowledge (rules, preferences, decisions, gotchas, facts).
//
// It is built to stay useful in long conversations and over months:
//   - entries are edited, replaced and merged, not only appended (with history kept);
//   - writing something that already exists is refused in favour of updating it;
//   - only the standing rules are shown at session start; everything else is recalled when a
//     message is actually about it, once per context, and again after the context is compacted;
//   - every recall is counted, so unused and duplicated entries can be found and cleaned up.
//
// Relevance is computed here from word overlap (no model call, no network, no dependencies).
import { open } from './db.js';

export const MEMORY_KINDS = ['rule', 'preference', 'decision', 'gotcha', 'fact'];
const ALWAYS = ['rule', 'preference']; // shown at every session start
const RANK = `CASE kind WHEN 'rule' THEN 0 WHEN 'preference' THEN 1 WHEN 'gotcha' THEN 2 WHEN 'decision' THEN 3 ELSE 4 END`;
const SIMILAR = 0.6; // token overlap above which two entries are "the same thing"

const nowIso = () => new Date().toISOString();

// ---------- text ----------

const STOP = new Set(
  `a an and are as at be been but by can do does for from had has have how i if in into is it its me my no not of on or our
   so than that the their them then there these they this to up use used using was we were what when where which who why will
   with you your should must also just only any all each more most very via per about over under out off
   في من على الى إلى عن مع هذا هذه ذلك التي الذي هو هي انا أنا انت إنت احنا هم كان كانت يكون ان أن إن لا ما لم لن قد كل او أو ثم بس
   ده دي دا اللي عشان علشان مش لو لما يعني كده كدا بقى بقا عاوز عايز ممكن برضو برضه ايه إيه ازاي إزاي فين ليه هل يا و ف ب ل`
    .split(/\s+/)
    .filter(Boolean),
);

/** Normalised word list: lowercased, Arabic letter forms unified, light English stemming, no stop words. */
export function tokens(text) {
  const norm = String(text ?? '')
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, '') // Arabic diacritics and tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
  const out = [];
  for (let w of norm.split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOP.has(w)) continue;
    if (/^[a-z]/.test(w)) {
      if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
      else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
      else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
      else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    } else if (w.length > 4 && w.startsWith('ال')) {
      w = w.slice(2);
    }
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

/**
 * How much two texts say the same thing, 0..1: the overlap of their word sets, or, when one is
 * (nearly) contained in the other, how much of the shorter one the longer one covers. The second
 * case catches a short restatement of a longer entry.
 */
export function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  const jaccard = both / (A.size + B.size - both);
  const small = Math.min(A.size, B.size);
  const contained = small >= 3 ? both / small : 0;
  return Math.max(jaccard, contained >= 0.8 ? contained : 0);
}

// ---------- storage ----------

function parseId(id) {
  const n = Number(String(id).replace(/^m/i, ''));
  return Number.isInteger(n) ? n : NaN;
}

export function getMemory(id) {
  const row = open().prepare('SELECT * FROM memory WHERE id=?').get(parseId(id) || -1);
  if (!row) throw new Error(`memory ${id} not found`);
  return row;
}

function scoped({ project, all = false, status = 'active', kind } = {}) {
  const where = [];
  const args = [];
  if (!all) {
    where.push('(project=? OR project IS NULL)');
    args.push(project);
  }
  if (status !== 'any') {
    where.push('status=?');
    args.push(status);
  }
  if (kind) {
    where.push('kind=?');
    args.push(kind);
  }
  return open()
    .prepare(`SELECT * FROM memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${RANK}, importance, id DESC`)
    .all(...args);
}

const checkKind = (kind) => {
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`bad kind "${kind}" (one of: ${MEMORY_KINDS.join(', ')})`);
  return kind;
};
const checkImportance = (v) => {
  const n = Number(v);
  if (![1, 2, 3].includes(n)) throw new Error(`bad importance "${v}" (1 high, 2 normal, 3 low)`);
  return n;
};

function noteWrite(session) {
  // A memory write counts as a checkpoint: restart the "anything worth saving?" counter.
  if (session) open().prepare('UPDATE sessions SET mem_nudged_at=prompts WHERE session_id=?').run(session);
}

/** The active entry most like `text` in this scope, if it is close enough to be the same knowledge. */
export function findSimilar(text, { project, global = false, except = [] } = {}) {
  let best = null;
  for (const m of scoped({ project, all: false })) {
    if (except.includes(m.id) || (global && m.project)) continue;
    const s = similarity(text, m.text);
    if (s >= SIMILAR && (!best || s > best.score)) best = { memory: m, score: s };
  }
  return best;
}

/**
 * Store a new entry. Refuses near-duplicates (update the existing one instead) unless `force`.
 * `replaces`: id(s) this entry supersedes — they are kept as history but no longer shown.
 * `when`: comma-separated trigger phrases that always recall it ("deploy, release").
 */
export function remember({ text, kind = 'fact', project, global = false, session = null, when, importance, replaces, force = false }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('usage: ctask remember <text> [--kind rule|preference|decision|gotcha|fact] [--when "words"] [--global]');
  checkKind(kind);
  const old = (replaces == null ? [] : Array.isArray(replaces) ? replaces : String(replaces).split(',')).map((r) => getMemory(String(r).trim()));
  if (!force) {
    const dup = findSimilar(body, { project, global, except: old.map((o) => o.id) });
    if (dup) {
      throw new Error(
        `this is already remembered as m${dup.memory.id} (${Math.round(dup.score * 100)}% the same): "${dup.memory.text}"\n` +
          `Update it: ctask memory update m${dup.memory.id} "<corrected text>"  ·  or replace it: add --replaces m${dup.memory.id}  ·  or keep both: --force`,
      );
    }
  }
  const db = open();
  const now = nowIso();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO memory(project, kind, text, session_id, created_at, updated_at, status, importance, triggers)
       VALUES(?,?,?,?,?,?, 'active', ?, ?)`,
    )
    .run(global ? null : project, kind, body, session, now, now, importance != null ? checkImportance(importance) : 2, when ? String(when).trim() : null);
  const id = Number(lastInsertRowid);
  for (const o of old) db.prepare(`UPDATE memory SET status='superseded', superseded_by=?, updated_at=? WHERE id=?`).run(id, now, o.id);
  noteWrite(session);
  return getMemory(id);
}

/** Edit an entry in place. The previous version is kept in its history. */
export function updateMemory(id, { text, kind, when, importance, global } = {}, { session = null, project } = {}) {
  const m = getMemory(id);
  const set = {};
  if (text != null && String(text).trim()) set.text = String(text).trim();
  if (kind != null) set.kind = checkKind(kind);
  if (when != null) set.triggers = when === 'none' ? null : String(when).trim();
  if (importance != null) set.importance = checkImportance(importance);
  if (global != null) set.project = global ? null : project ?? m.project;
  const keys = Object.keys(set);
  if (!keys.length) throw new Error('nothing to change: give new text, or --kind, --when, --importance');
  const db = open();
  const now = nowIso();
  if (set.text && set.text !== m.text) {
    db.prepare('INSERT INTO memory_history(memory_id, at, session_id, kind, text) VALUES(?,?,?,?,?)').run(m.id, m.updated_at ?? m.created_at, m.session_id, m.kind, m.text);
  }
  db.prepare(`UPDATE memory SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=?, status='active', superseded_by=NULL, session_id=COALESCE(?, session_id) WHERE id=?`).run(
    ...keys.map((k) => set[k]),
    now,
    session,
    m.id,
  );
  noteWrite(session);
  return getMemory(m.id);
}

/** Fold several entries into one new entry; the originals become history. */
export function mergeMemory(ids, text, opts = {}) {
  if (ids.length < 2) throw new Error('usage: ctask memory merge <mID> <mID> [...] <combined text>');
  const first = getMemory(ids[0]);
  return remember({ kind: first.kind, importance: first.importance, when: first.triggers, global: !first.project, ...opts, text, replaces: ids, force: true, project: opts.project ?? first.project });
}

export function forget(id) {
  const row = getMemory(id);
  open().prepare('DELETE FROM memory WHERE id=?').run(row.id);
  return row;
}

export function memoryDetail(id) {
  const m = getMemory(id);
  const db = open();
  return {
    memory: m,
    history: db.prepare('SELECT at, kind, text FROM memory_history WHERE memory_id=? ORDER BY id').all(m.id),
    replaced: db.prepare('SELECT id, text FROM memory WHERE superseded_by=? ORDER BY id').all(m.id),
    recalls: db.prepare('SELECT how, COUNT(*) AS n, MAX(at) AS last FROM recalls WHERE memory_id=? GROUP BY how').all(m.id),
  };
}

export function countMemory(project) {
  return open().prepare(`SELECT COUNT(*) AS n FROM memory WHERE status='active' AND (project=? OR project IS NULL)`).get(project).n;
}

// ---------- relevance ----------

/**
 * Score every candidate against a piece of text. A memory matches when a trigger phrase appears in
 * the text, or when at least `minMatches` distinct meaningful words are shared; rarer words count more.
 */
export function rank(text, candidates, { minMatches = 2 } = {}) {
  const q = new Set(tokens(text));
  if (!q.size || !candidates.length) return [];
  const docs = candidates.map((m) => ({ m, set: new Set(tokens(m.text)) }));
  const df = new Map();
  for (const d of docs) for (const t of d.set) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t) => Math.log(1 + docs.length / (df.get(t) ?? 1));
  const out = [];
  for (const { m, set } of docs) {
    let score = 0;
    const matched = [];
    for (const t of q) {
      if (!set.has(t)) continue;
      score += idf(t);
      matched.push(t);
    }
    let triggered = false;
    for (const phrase of String(m.triggers ?? '').split(',')) {
      const pt = tokens(phrase);
      if (pt.length && pt.every((t) => q.has(t))) triggered = true;
    }
    if (!triggered && matched.length < minMatches) continue;
    if (triggered) score += 5;
    score *= 1.3 - 0.15 * (m.importance ?? 2); // importance 1 → ×1.15, 3 → ×0.85
    out.push({ ...m, score: Math.round(score * 100) / 100, matched, triggered });
  }
  return out.sort((a, b) => b.score - a.score || b.id - a.id);
}

/** List, or search when `q` is given (ranked; any shared word counts). */
export function listMemory({ project, all = false, q, kind, status = 'active', limit = 100 } = {}) {
  const rows = scoped({ project, all, status, kind });
  const words = String(q ?? '').trim();
  return (words ? rank(words, rows, { minMatches: 1 }) : rows).slice(0, limit);
}

// ---------- recall ----------

function record(memories, { session, epoch = 0, how }) {
  if (!memories.length) return;
  const db = open();
  const now = nowIso();
  for (const m of memories) {
    db.prepare('INSERT INTO recalls(memory_id, session_id, epoch, at, how, score) VALUES(?,?,?,?,?,?)').run(m.id, session ?? null, epoch, now, how, m.score ?? null);
    db.prepare('UPDATE memory SET uses=uses+1, last_used_at=? WHERE id=?').run(now, m.id);
  }
}

const shownIds = (session, epoch) =>
  session ? new Set(open().prepare('SELECT DISTINCT memory_id FROM recalls WHERE session_id=? AND epoch=?').all(session, epoch).map((r) => r.memory_id)) : new Set();

/**
 * What a starting context is given: every rule and preference, plus the few most valuable other
 * entries. The rest is recalled on demand. Returns { shown, total }.
 */
export function startMemory({ project, session, epoch = 0, alwaysMax = 12, extraMax = 4, record: rec = false } = {}) {
  const rows = scoped({ project });
  const always = rows.filter((m) => ALWAYS.includes(m.kind)).slice(0, alwaysMax);
  const extra = rows
    .filter((m) => !ALWAYS.includes(m.kind))
    .sort((a, b) => a.importance - b.importance || b.uses - a.uses || b.id - a.id)
    .slice(0, extraMax);
  const shown = [...always, ...extra];
  if (rec) record(shown, { session, epoch, how: 'start' });
  return { shown, total: rows.length };
}

/**
 * Memories relevant to a message that this context has not been shown yet.
 * `how` is 'prompt' (automatic, on each user message) or 'manual' (ctask recall).
 */
export function recall({ project, text, session, epoch = 0, limit = 4, how = 'prompt', record: rec = true } = {}) {
  const seen = how === 'manual' ? new Set() : shownIds(session, epoch);
  const hits = rank(text, scoped({ project }).filter((m) => !seen.has(m.id)), { minMatches: how === 'manual' ? 1 : 2 }).slice(0, limit);
  if (rec) record(hits, { session, epoch, how });
  return hits;
}

// ---------- session bookkeeping (used by the hooks) ----------

/** A new context begins (start, resume or compaction): what was shown before no longer counts. */
export function startEpoch(sessionId) {
  if (!sessionId) return 0;
  const db = open();
  db.prepare('UPDATE sessions SET epoch=epoch+1 WHERE session_id=?').run(sessionId);
  return db.prepare('SELECT epoch FROM sessions WHERE session_id=?').get(sessionId)?.epoch ?? 0;
}

const STANDING =
  /\b(from now on|going forward|always|never|don'?t ever|remember (that|this|to)|next time|stop doing|i prefer|we (always|never)|make sure (you|to) always|as a rule)\b|من هنا ورايح|من النهارده|من النهاردة|دايما|دايماً|دائما|أبدا|ابدا|افتكر|خليك فاكر|متعملش|ما تعملش|بلاش|المره الجايه|المرة الجاية|كل مره|كل مرة|بفضّل|بفضل|قاعده|قاعدة/i;

/**
 * Count the prompt and decide whether to remind Claude to save what the conversation has taught it:
 *  - 'standing'   the message reads like a lasting instruction, preference or correction;
 *  - 'checkpoint' several prompts have passed without any memory being written.
 */
export function promptTick(sessionId, prompt, { every = Number(process.env.CTASK_MEMORY_EVERY) || 8 } = {}) {
  if (!sessionId) return { epoch: 0, nudge: null };
  const db = open();
  db.prepare('UPDATE sessions SET prompts=prompts+1 WHERE session_id=?').run(sessionId);
  const s = db.prepare('SELECT epoch, prompts, mem_nudged_at FROM sessions WHERE session_id=?').get(sessionId);
  if (!s) return { epoch: 0, nudge: null };
  let nudge = null;
  if (STANDING.test(String(prompt ?? ''))) nudge = 'standing';
  else if (s.prompts - s.mem_nudged_at >= every) nudge = 'checkpoint';
  // Either reminder restarts the count, so the two never stack up on consecutive messages.
  if (nudge) db.prepare('UPDATE sessions SET mem_nudged_at=prompts WHERE session_id=?').run(sessionId);
  return { epoch: s.epoch, prompts: s.prompts, nudge };
}

// ---------- upkeep ----------

/** What deserves a look: near-duplicates, and entries nothing has recalled for a long time. */
export function reviewMemory({ project, all = false, unusedDays = 30 } = {}) {
  const rows = scoped({ project, all });
  const duplicates = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if ((rows[i].project ?? null) !== (rows[j].project ?? null)) continue;
      const s = similarity(rows[i].text, rows[j].text);
      if (s >= 0.45) duplicates.push({ a: rows[i], b: rows[j], score: Math.round(s * 100) });
    }
  }
  const cutoff = new Date(Date.now() - unusedDays * 86400e3).toISOString();
  return {
    total: rows.length,
    duplicates: duplicates.sort((x, y) => y.score - x.score).slice(0, 20),
    unused: rows.filter((m) => !ALWAYS.includes(m.kind) && m.created_at < cutoff && (m.last_used_at ?? '') < cutoff),
    superseded: scoped({ project, all, status: 'superseded' }).length,
    unusedDays,
  };
}

export const memoryLine = (m) => `m${m.id} [${m.kind}]${m.project ? '' : ' (global)'} ${m.text}`;
