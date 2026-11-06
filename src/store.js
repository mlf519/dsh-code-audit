import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BUILTIN_PROMPTS } from './prompts.js'
import { newId, nowIso, parseJson } from './util.js'

/** SQLite-backed store for tasks, runs, findings, prompts and settings. */
export class AuditStore {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.dbPath = join(dataDir, 'code-audit.db')
    mkdirSync(dirname(this.dbPath), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
    this.seedBuiltinPrompts()
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL DEFAULT '',
        default_severity TEXT NOT NULL DEFAULT 'medium',
        content TEXT NOT NULL DEFAULT '',
        builtin INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        report_guide TEXT NOT NULL DEFAULT '',
        builtin INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        schedule_type TEXT NOT NULL DEFAULT 'manual',
        schedule_at TEXT,
        schedule_cron TEXT,
        interval_minutes INTEGER,
        next_run_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        session_id TEXT,
        trajectory_path TEXT,
        summary TEXT,
        error TEXT,
        findings_count INTEGER NOT NULL DEFAULT 0,
        progress_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        prompt_id TEXT REFERENCES prompts(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        category TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL DEFAULT '',
        line_start INTEGER,
        line_end INTEGER,
        code_snippet TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        recommendation TEXT NOT NULL DEFAULT '',
        poc TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        status_note TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(task_id, fingerprint);
      CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    this.ensureColumn('runs', 'progress_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('runs', 'skill_report', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('findings', 'poc', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('findings', 'skill_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('tasks', 'audit_mode', "TEXT NOT NULL DEFAULT 'prompts'")
    this.ensureColumn('tasks', 'skill_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('skills', 'skill_md', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('skills', 'references_json', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('skills', 'manifest_json', "TEXT NOT NULL DEFAULT '{}'")
  }

  /** Add a column to an existing table when an older database lacks it. */
  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all()
    if (columns.some(entry => entry.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  close() {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  // ---------------------------------------------------------------- prompts

  seedBuiltinPrompts() {
    const existing = new Set(this.db.prepare('SELECT name FROM prompts').all().map(row => row.name))
    const insert = this.db.prepare(
      `INSERT INTO prompts (id, name, category, default_severity, content, builtin, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    )
    const stamp = nowIso()
    for (const prompt of BUILTIN_PROMPTS) {
      if (existing.has(prompt.name)) continue
      insert.run(
        newId('p'),
        prompt.name,
        prompt.category,
        prompt.default_severity,
        prompt.content,
        stamp,
        stamp,
      )
    }
  }

  listPrompts({ enabledOnly = false } = {}) {
    const sql = enabledOnly
      ? 'SELECT * FROM prompts WHERE enabled = 1 ORDER BY builtin DESC, name'
      : 'SELECT * FROM prompts ORDER BY builtin DESC, name'
    return this.db.prepare(sql).all().map(row => this.mapPrompt(row))
  }

  getPrompt(id) {
    const row = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(id)
    return row ? this.mapPrompt(row) : undefined
  }

  getPromptByName(name) {
    const row = this.db.prepare('SELECT * FROM prompts WHERE name = ?').get(name)
    return row ? this.mapPrompt(row) : undefined
  }

  createPrompt(input) {
    const stamp = nowIso()
    const id = newId('p')
    this.db.prepare(
      `INSERT INTO prompts (id, name, category, default_severity, content, builtin, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.category ?? '',
      input.default_severity ?? 'medium',
      input.content ?? '',
      input.builtin ? 1 : 0,
      input.enabled === false ? 0 : 1,
      stamp,
      stamp,
    )
    return this.getPrompt(id)
  }

  updatePrompt(id, patch) {
    const current = this.getPrompt(id)
    if (!current) return undefined
    this.db.prepare(
      `UPDATE prompts SET name = ?, category = ?, default_severity = ?, content = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.name ?? current.name,
      patch.category ?? current.category,
      patch.default_severity ?? current.default_severity,
      patch.content ?? current.content,
      patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      nowIso(),
      id,
    )
    return this.getPrompt(id)
  }

  deletePrompt(id) {
    const result = this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** Insert or update a prompt by name; used by YAML import. */
  upsertPromptByName(input) {
    const existing = this.getPromptByName(input.name)
    if (existing) {
      this.updatePrompt(existing.id, {
        category: input.category ?? existing.category,
        default_severity: input.default_severity ?? existing.default_severity,
        content: input.content ?? existing.content,
        enabled: input.enabled === undefined ? existing.enabled : input.enabled,
      })
      return { prompt: this.getPrompt(existing.id), created: false }
    }
    return { prompt: this.createPrompt({ ...input, builtin: false }), created: true }
  }

  // ----------------------------------------------------------------- skills

  listSkills({ enabledOnly = false } = {}) {
    const sql = enabledOnly
      ? 'SELECT * FROM skills WHERE enabled = 1 ORDER BY builtin DESC, name'
      : 'SELECT * FROM skills ORDER BY builtin DESC, name'
    return this.db.prepare(sql).all().map(row => this.mapSkill(row))
  }

  getSkill(id) {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
    return row ? this.mapSkill(row) : undefined
  }

  getSkillByName(name) {
    const row = this.db.prepare('SELECT * FROM skills WHERE name = ?').get(name)
    return row ? this.mapSkill(row) : undefined
  }

  createSkill(input) {
    const stamp = nowIso()
    const id = newId('s')
    this.db.prepare(
      `INSERT INTO skills (id, name, category, description, content, report_guide, skill_md, references_json,
        manifest_json, builtin, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.category ?? '',
      input.description ?? '',
      input.content ?? '',
      input.report_guide ?? '',
      input.skill_md ?? '',
      JSON.stringify(input.references ?? []),
      JSON.stringify(input.manifest ?? {}),
      input.builtin ? 1 : 0,
      input.enabled === false ? 0 : 1,
      stamp,
      stamp,
    )
    return this.getSkill(id)
  }

  updateSkill(id, patch) {
    const current = this.getSkill(id)
    if (!current) return undefined
    this.db.prepare(
      `UPDATE skills SET name = ?, category = ?, description = ?, content = ?, report_guide = ?,
        skill_md = ?, references_json = ?, manifest_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    ).run(
      patch.name ?? current.name,
      patch.category ?? current.category,
      patch.description ?? current.description,
      patch.content ?? current.content,
      patch.report_guide ?? current.report_guide,
      patch.skill_md ?? current.skill_md,
      JSON.stringify(patch.references ?? current.references ?? []),
      JSON.stringify(patch.manifest ?? current.manifest ?? {}),
      patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      nowIso(),
      id,
    )
    return this.getSkill(id)
  }

  deleteSkill(id) {
    const result = this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** Insert or update a skill by name; used by file and backup imports. */
  upsertSkillByName(input) {
    const existing = this.getSkillByName(input.name)
    if (existing) {
      this.updateSkill(existing.id, {
        category: input.category ?? existing.category,
        description: input.description ?? existing.description,
        content: input.content ?? existing.content,
        report_guide: input.report_guide ?? existing.report_guide,
        skill_md: input.skill_md ?? existing.skill_md,
        references: input.references ?? existing.references,
        manifest: input.manifest ?? existing.manifest,
        enabled: input.enabled === undefined ? existing.enabled : input.enabled,
      })
      return { skill: this.getSkill(existing.id), created: false }
    }
    return { skill: this.createSkill({ ...input, builtin: false }), created: true }
  }

  // ------------------------------------------------------------------ tasks

  listTasks() {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map(row => this.mapTask(row))
  }

  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return row ? this.mapTask(row) : undefined
  }

  createTask(input) {
    const stamp = nowIso()
    const id = newId('t')
    this.db.prepare(
      `INSERT INTO tasks (id, name, repo_path, description, prompt_ids, audit_mode, skill_id, status, schedule_type,
        schedule_at, schedule_cron, interval_minutes, next_run_at, enabled, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.repo_path,
      input.description ?? '',
      JSON.stringify(input.prompt_ids ?? []),
      input.audit_mode === 'skill' ? 'skill' : 'prompts',
      input.skill_id ?? '',
      input.status ?? 'draft',
      input.schedule_type ?? 'manual',
      input.schedule_at ?? null,
      input.schedule_cron ?? null,
      input.interval_minutes ?? null,
      input.next_run_at ?? null,
      input.enabled === false ? 0 : 1,
      input.provider ?? '',
      input.model ?? '',
      stamp,
      stamp,
    )
    return this.getTask(id)
  }

  updateTask(id, patch) {
    const current = this.getTask(id)
    if (!current) return undefined
    const next = { ...current, ...patch }
    this.db.prepare(
      `UPDATE tasks SET name = ?, repo_path = ?, description = ?, prompt_ids = ?, audit_mode = ?, skill_id = ?,
        status = ?, schedule_type = ?, schedule_at = ?, schedule_cron = ?, interval_minutes = ?, next_run_at = ?,
        enabled = ?, provider = ?, model = ?, updated_at = ?, last_run_at = ?
       WHERE id = ?`,
    ).run(
      next.name,
      next.repo_path,
      next.description ?? '',
      JSON.stringify(next.prompt_ids ?? []),
      next.audit_mode === 'skill' ? 'skill' : 'prompts',
      next.skill_id ?? '',
      next.status ?? 'draft',
      next.schedule_type ?? 'manual',
      next.schedule_at ?? null,
      next.schedule_cron ?? null,
      next.interval_minutes ?? null,
      next.next_run_at ?? null,
      next.enabled ? 1 : 0,
      next.provider ?? '',
      next.model ?? '',
      nowIso(),
      next.last_run_at ?? null,
      id,
    )
    return this.getTask(id)
  }

  deleteTask(id) {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** Tasks whose schedule is due, excluding ones already running. */
  dueTasks(now = nowIso()) {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND status NOT IN ('running')
         ORDER BY next_run_at`,
      )
      .all(now)
      .map(row => this.mapTask(row))
  }

  // ------------------------------------------------------------------- runs

  createRun(taskId, trigger) {
    const id = newId('r')
    this.db.prepare(
      `INSERT INTO runs (id, task_id, trigger, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    ).run(id, taskId, trigger, nowIso())
    return this.getRun(id)
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    return row ? this.mapRun(row) : undefined
  }

  listRuns(taskId, limit = 50) {
    const sql = taskId
      ? 'SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
      : 'SELECT * FROM runs ORDER BY started_at DESC LIMIT ?'
    const rows = taskId
      ? this.db.prepare(sql).all(taskId, limit)
      : this.db.prepare(sql).all(limit)
    return rows.map(row => this.mapRun(row))
  }

  activeRuns() {
    return this.db
      .prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at")
      .all()
      .map(row => this.mapRun(row))
  }

  updateRun(id, patch) {
    const current = this.getRun(id)
    if (!current) return undefined
    const next = { ...current, ...patch }
    this.db.prepare(
      `UPDATE runs SET status = ?, finished_at = ?, session_id = ?, trajectory_path = ?, summary = ?,
        error = ?, findings_count = ?, progress_json = ?, skill_report = ?
       WHERE id = ?`,
    ).run(
      next.status,
      next.finished_at ?? null,
      next.session_id ?? null,
      next.trajectory_path ?? null,
      next.summary ?? null,
      next.error ?? null,
      next.findings_count ?? 0,
      JSON.stringify(next.progress ?? {}),
      next.skill_report ?? '',
      id,
    )
    return this.getRun(id)
  }

  deleteRun(id) {
    const run = this.getRun(id)
    if (!run) return undefined
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id)
    return run
  }

  countFindingsForRun(runId) {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM findings WHERE run_id = ?').get(runId)
    return Number(row?.count ?? 0)
  }

  // --------------------------------------------------------------- findings

  addFinding(taskId, input) {
    const stamp = nowIso()
    const fingerprint = input.fingerprint
    const existing = this.db
      .prepare('SELECT id FROM findings WHERE task_id = ? AND fingerprint = ?')
      .get(taskId, fingerprint)
    if (existing) {
      this.db.prepare(
        `UPDATE findings SET description = ?, evidence = ?, recommendation = ?, poc = ?, code_snippet = ?,
          severity = ?, category = ?, file_path = ?, line_start = ?, line_end = ?, prompt_id = ?, skill_id = ?,
          updated_at = ?
         WHERE id = ?`,
      ).run(
        input.description ?? '',
        input.evidence ?? '',
        input.recommendation ?? '',
        input.poc ?? '',
        input.code_snippet ?? '',
        input.severity ?? 'medium',
        input.category ?? '',
        input.file_path ?? '',
        input.line_start ?? null,
        input.line_end ?? null,
        input.prompt_id ?? null,
        input.skill_id ?? '',
        stamp,
        existing.id,
      )
      return { finding: this.getFinding(existing.id), created: false }
    }
    const id = newId('f')
    this.db.prepare(
      `INSERT INTO findings (id, task_id, run_id, prompt_id, skill_id, title, severity, category, file_path,
        line_start, line_end, code_snippet, description, evidence, recommendation, poc, status, status_note,
        fingerprint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '', ?, ?, ?)`,
    ).run(
      id,
      taskId,
      input.run_id ?? null,
      input.prompt_id ?? null,
      input.skill_id ?? '',
      input.title,
      input.severity ?? 'medium',
      input.category ?? '',
      input.file_path ?? '',
      input.line_start ?? null,
      input.line_end ?? null,
      input.code_snippet ?? '',
      input.description ?? '',
      input.evidence ?? '',
      input.recommendation ?? '',
      input.poc ?? '',
      fingerprint,
      stamp,
      stamp,
    )
    return { finding: this.getFinding(id), created: true }
  }

  getFinding(id) {
    const row = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id)
    return row ? this.mapFinding(row) : undefined
  }

  listFindings({ taskId, runId, status, severity } = {}) {
    const clauses = []
    const params = []
    if (taskId) {
      clauses.push('task_id = ?')
      params.push(taskId)
    }
    if (runId) {
      clauses.push('run_id = ?')
      params.push(runId)
    }
    if (status) {
      clauses.push('status = ?')
      params.push(status)
    }
    if (severity) {
      clauses.push('severity = ?')
      params.push(severity)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.db
      .prepare(`SELECT * FROM findings ${where} ORDER BY created_at DESC`)
      .all(...params)
      .map(row => this.mapFinding(row))
  }

  updateFinding(id, patch) {
    const current = this.getFinding(id)
    if (!current) return undefined
    this.db.prepare(
      `UPDATE findings SET status = ?, status_note = ?, updated_at = ? WHERE id = ?`,
    ).run(
      patch.status ?? current.status,
      patch.status_note ?? current.status_note,
      nowIso(),
      id,
    )
    return this.getFinding(id)
  }

  deleteFinding(id) {
    const result = this.db.prepare('DELETE FROM findings WHERE id = ?').run(id)
    return result.changes > 0
  }

  // --------------------------------------------------------------- settings

  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return row ? parseJson(row.value, fallback) : fallback
  }

  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
    return value
  }

  allSettings(defaults = {}) {
    const rows = this.db.prepare('SELECT key, value FROM settings').all()
    const stored = {}
    for (const row of rows) stored[row.key] = parseJson(row.value, null)
    return { ...defaults, ...stored }
  }

  // ----------------------------------------------------------------- mappers

  mapPrompt(row) {
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      default_severity: row.default_severity,
      content: row.content,
      builtin: Boolean(row.builtin),
      enabled: Boolean(row.enabled),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  mapSkill(row) {
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      content: row.content,
      report_guide: row.report_guide ?? '',
      skill_md: row.skill_md ?? '',
      references: parseJson(row.references_json, []),
      manifest: parseJson(row.manifest_json, {}),
      builtin: Boolean(row.builtin),
      enabled: Boolean(row.enabled),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  mapTask(row) {
    return {
      id: row.id,
      name: row.name,
      repo_path: row.repo_path,
      description: row.description,
      prompt_ids: parseJson(row.prompt_ids, []),
      audit_mode: row.audit_mode === 'skill' ? 'skill' : 'prompts',
      skill_id: row.skill_id ?? '',
      status: row.status,
      schedule_type: row.schedule_type,
      schedule_at: row.schedule_at,
      schedule_cron: row.schedule_cron,
      interval_minutes: row.interval_minutes,
      next_run_at: row.next_run_at,
      enabled: Boolean(row.enabled),
      provider: row.provider,
      model: row.model,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_run_at: row.last_run_at,
    }
  }

  mapRun(row) {
    return {
      id: row.id,
      task_id: row.task_id,
      trigger: row.trigger,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      session_id: row.session_id,
      trajectory_path: row.trajectory_path,
      summary: row.summary,
      error: row.error,
      findings_count: Number(row.findings_count ?? 0),
      progress: parseJson(row.progress_json, {}),
      skill_report: row.skill_report ?? '',
    }
  }

  mapFinding(row) {
    return {
      id: row.id,
      task_id: row.task_id,
      run_id: row.run_id,
      prompt_id: row.prompt_id,
      skill_id: row.skill_id ?? '',
      title: row.title,
      severity: row.severity,
      category: row.category,
      file_path: row.file_path,
      line_start: row.line_start,
      line_end: row.line_end,
      code_snippet: row.code_snippet,
      description: row.description,
      evidence: row.evidence,
      recommendation: row.recommendation,
      poc: row.poc ?? '',
      status: row.status,
      status_note: row.status_note,
      fingerprint: row.fingerprint,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}
