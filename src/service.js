import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { applySchedule } from './schedule.js'
import { SEVERITIES, normaliseSeverity } from './util.js'

/** Validate and create a task from untrusted input. */
export function createTask(store, input) {
  const fields = validateTaskFields(store, input, {})
  const schedule = safeSchedule(input, {})
  return store.createTask({ ...fields, ...schedule })
}

/** Validate and update an existing task. */
export function updateTask(store, id, input) {
  const current = store.getTask(id)
  if (!current) throw inputError('审计任务不存在', 404)
  const fields = validateTaskFields(store, input, current)
  const schedule = safeSchedule({ ...input, schedule_type: input.schedule_type ?? current.schedule_type }, current)
  const updated = store.updateTask(id, { ...fields, ...schedule })
  if (!fields.enabled && updated) {
    return store.updateTask(id, {
      next_run_at: null,
      status: updated.status === 'running' ? 'running' : 'draft',
    })
  }
  return updated
}

function validateTaskFields(store, input, current) {
  const name = String(input.name ?? current.name ?? '').trim()
  if (!name) throw inputError('任务名称不能为空')

  const rawPath = String(input.repo_path ?? current.repo_path ?? '').trim()
  if (!rawPath) throw inputError('请填写要审计的代码目录')
  const repoPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(process.cwd(), rawPath)
  if (!existsSync(repoPath)) throw inputError(`代码目录不存在：${repoPath}`)
  if (!statSync(repoPath).isDirectory()) throw inputError(`代码目录不是文件夹：${repoPath}`)

  const auditMode = String(input.audit_mode ?? current.audit_mode ?? 'prompts') === 'skill' ? 'skill' : 'prompts'
  let promptIds = []
  let skillId = ''

  if (auditMode === 'skill') {
    const selected = String(input.skill_id ?? current.skill_id ?? '').trim()
    if (!selected) throw inputError('请选择要使用的审计 Skill')
    const skill = store.getSkill(selected)
    if (!skill) throw inputError(`选择的审计 Skill 不存在：${selected}`)
    if (!skill.enabled) throw inputError(`审计 Skill 已禁用：${skill.name}`)
    skillId = skill.id
  } else {
    const rawPromptIds = Array.isArray(input.prompt_ids) ? input.prompt_ids : current.prompt_ids ?? []
    promptIds = [...new Set(rawPromptIds.map(String))]
    for (const promptId of promptIds) {
      const prompt = store.getPrompt(promptId)
      if (!prompt) throw inputError(`选择的漏洞提示词不存在：${promptId}`)
    }
  }

  const enabled = input.enabled === undefined ? (current.enabled ?? true) : Boolean(input.enabled)
  const provider = String(input.provider ?? current.provider ?? '').trim()
  const model = String(input.model ?? current.model ?? '').trim()

  return {
    name,
    repo_path: repoPath,
    description: String(input.description ?? current.description ?? ''),
    prompt_ids: promptIds,
    audit_mode: auditMode,
    skill_id: skillId,
    enabled,
    provider,
    model,
  }
}

/** Resolve the selected prompts for a task (enabled only). */
export function selectedPrompts(store, task) {
  return task.prompt_ids.map(id => store.getPrompt(id)).filter(prompt => prompt && prompt.enabled)
}

/** Full dashboard state used by the web console. */
export function buildState(store, { dataDir, maxConcurrentRuns } = {}) {
  const tasks = store.listTasks()
  const prompts = store.listPrompts()
  const skills = store.listSkills()
  const findings = store.listFindings()
  const runs = store.listRuns(undefined, 100)
  const promptMap = new Map(prompts.map(prompt => [prompt.id, prompt]))
  const skillMap = new Map(skills.map(skill => [skill.id, skill]))
  const taskMap = new Map(tasks.map(task => [task.id, task]))
  const runSummary = run => {
    const { skill_report: skillReport, ...rest } = run
    return { ...rest, has_skill_report: Boolean(skillReport) }
  }
  const latestRunMap = new Map()
  const skillReportTasks = new Set()
  for (const run of runs) {
    if (!latestRunMap.has(run.task_id)) latestRunMap.set(run.task_id, run)
    if (String(run.skill_report ?? '').trim()) skillReportTasks.add(run.task_id)
  }

  const taskStats = new Map()
  for (const finding of findings) {
    const stats = taskStats.get(finding.task_id) ?? { total: 0, open: 0 }
    stats.total += 1
    if (finding.status === 'open') stats.open += 1
    taskStats.set(finding.task_id, stats)
  }

  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    maxConcurrentRuns,
    stats: {
      tasks: tasks.length,
      scheduled: tasks.filter(task => task.next_run_at && task.enabled).length,
      running: tasks.filter(task => task.status === 'running').length,
      findings: findings.length,
      openFindings: findings.filter(finding => finding.status === 'open').length,
      verifiedFindings: findings.filter(finding => finding.status === 'verified').length,
      ignoredFindings: findings.filter(finding => finding.status === 'ignored' || finding.status === 'false_positive').length,
      runs: runs.length,
    },
    tasks: tasks.map(task => ({
      ...task,
      prompt_names: task.prompt_ids.map(id => promptMap.get(id)?.name).filter(Boolean),
      skill_name: task.skill_id ? skillMap.get(task.skill_id)?.name ?? '' : '',
      finding_stats: taskStats.get(task.id) ?? { total: 0, open: 0 },
      has_skill_report: skillReportTasks.has(task.id),
      latest_run: latestRunMap.has(task.id) ? runSummary(latestRunMap.get(task.id)) : null,
    })),
    prompts,
    skills: skills.map(skillSummary),
    findings: findings.map(finding => ({
      ...finding,
      task_name: taskMap.get(finding.task_id)?.name ?? '',
      prompt_name: finding.prompt_id ? promptMap.get(finding.prompt_id)?.name ?? '' : '',
      skill_name: finding.skill_id ? skillMap.get(finding.skill_id)?.name ?? '' : '',
    })),
    runs: runs.map(run => ({ ...runSummary(run), task_name: taskMap.get(run.task_id)?.name ?? '' })),
    settings: store.allSettings({
      maxConcurrentRuns,
      runTimeoutMinutes: 60,
      defaultProvider: '',
      defaultModel: '',
    }),
    severities: SEVERITIES,
  }
}

/** Normalise a severity coming from a request. */
export function toSeverity(value, fallback = 'medium') {
  return normaliseSeverity(value, fallback)
}

/** Lightweight skill record for the dashboard; full text is fetched per skill. */
function skillSummary(skill) {
  const references = Array.isArray(skill.references) ? skill.references : []
  return {
    id: skill.id,
    name: skill.name,
    category: skill.category,
    description: skill.description,
    builtin: skill.builtin,
    enabled: skill.enabled,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
    preview: String(skill.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    reference_paths: references.map(reference => reference.path),
    has_skill_md: Boolean(String(skill.skill_md ?? '').trim()),
    has_report_guide: Boolean(String(skill.report_guide ?? '').trim()),
  }
}

function inputError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function safeSchedule(input, previous) {
  try {
    return applySchedule(input, previous)
  } catch (error) {
    throw inputError(error.message)
  }
}
