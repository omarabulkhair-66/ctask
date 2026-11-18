// Playbooks: named recipes for work that repeats. Running one creates a task with its steps,
// instructions and acceptance criteria already filled in, each step waiting on the one before it.
import { addTask, getTask, setStatus, taskDetail } from './core.js';
import { open } from './db.js';

const cleanName = (name) => {
  const n = String(name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(n)) throw new Error('playbook name must be letters, digits, - or _ (e.g. release, bug-triage)');
  return n;
};

export function getPlaybook(name) {
  const row = open().prepare('SELECT * FROM playbooks WHERE name=?').get(cleanName(name));
  if (!row) throw new Error(`playbook "${name}" not found — see: ctask playbook list`);
  return { name: row.name, updated_at: row.updated_at, ...JSON.parse(row.spec) };
}

export function listPlaybooks() {
  return open().prepare('SELECT * FROM playbooks ORDER BY name').all().map((r) => ({ name: r.name, updated_at: r.updated_at, ...JSON.parse(r.spec) }));
}

/**
 * Save from an existing task (`from`: its id — title, body, instructions, acceptance and steps are copied)
 * or from fields (`steps` is "a; b; c" or an array of {title, instructions}).
 */
export function savePlaybook(name, { from, title, body, instructions, accept, steps } = {}) {
  const key = cleanName(name);
  let spec;
  if (from != null) {
    const { task, children } = taskDetail(from);
    spec = {
      title: title ?? task.title,
      body: body ?? task.body,
      instructions: instructions ?? task.instructions,
      accept: accept ?? task.accept,
      steps: children.map((s) => ({ title: s.title, instructions: s.instructions, accept: s.accept })),
    };
  } else {
    const list = Array.isArray(steps) ? steps : String(steps ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((t) => ({ title: t }));
    spec = { title: title ?? key, body, instructions, accept, steps: list };
  }
  if (!spec.steps.length && !spec.instructions) throw new Error('a playbook needs steps or instructions (--steps "a; b; c", --instructions, or --from <task id>)');
  const now = new Date().toISOString();
  open()
    .prepare(
      `INSERT INTO playbooks(name, spec, created_at, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET spec=excluded.spec, updated_at=excluded.updated_at`,
    )
    .run(key, JSON.stringify(spec), now, now);
  return getPlaybook(key);
}

export function removePlaybook(name) {
  const pb = getPlaybook(name);
  open().prepare('DELETE FROM playbooks WHERE name=?').run(pb.name);
  return pb;
}

/** Create the task and its steps. `subject` is appended to the title ("Release" + "v2.3"). */
export function runPlaybook(name, { subject, project, start = false, priority, parallel = false } = {}) {
  const pb = getPlaybook(name);
  const parent = addTask({
    title: subject ? `${pb.title}: ${subject}` : pb.title,
    body: pb.body,
    instructions: pb.instructions,
    accept: pb.accept,
    tags: `playbook:${pb.name}`,
    priority,
    project,
  });
  let prev = null;
  const steps = [];
  for (const s of pb.steps) {
    const step = addTask({ title: s.title, instructions: s.instructions, accept: s.accept, parent: parent.id, after: prev && !parallel ? [prev] : undefined });
    steps.push(step);
    prev = step.id;
  }
  if (start) setStatus(parent.id, 'in_progress');
  return { task: getTask(parent.id), steps: steps.map((s) => getTask(s.id)) };
}
