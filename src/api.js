import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTaskReport } from './report.js'
import { buildState, createTask, updateTask } from './service.js'
import { buildSkillFiles, groupSkillFiles, normaliseSkillInput } from './skillpack.js'
import { removeSkillFromDsh, syncSkillToDsh } from './dshskills.js'
import { createZip, readZip } from './zip.js'
import {
  parsePromptsDocument,
  parseSkillsDocument,
  stringifyPromptsDocument,
  stringifySkillsDocument,
} from './yaml.js'
import { FINDING_STATUSES, SEVERITIES, normaliseSeverity } from './util.js'

const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url))
const API_PREFIX = '/api/'
const MAX_BODY_BYTES = 16 * 1024 * 1024

const STATIC_FILES = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'favicon.svg': 'image/svg+xml',
}

/** Create the HTTP handler for the console and its REST API. */
export function createApiHandler({ store, runner, scheduler, dataDir, listModels, invalidateSkills = () => {} }) {
  const reportsDir = join(dataDir, 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const context = { store, runner, scheduler, dataDir, reportsDir, listModels, invalidateSkills }

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(url.pathname)
      const base = normalizeBase(pathname)

      if (base === '/' && !pathname.endsWith('/')) {
        res.writeHead(302, { Location: `${pathname}/` })
        res.end()
        return
      }
      if (base.startsWith(API_PREFIX)) {
        await handleApi(req, res, url, base.slice(API_PREFIX.length), context)
        return
      }
      serveStatic(res, base)
    } catch (error) {
      const status = Number(error?.status) || 500
      sendJson(res, status, { error: String(error?.message ?? error) })
    }
  }
}

function normalizeBase(pathname) {
  const marker = '/dsh-code-audit'
  if (pathname === marker) return '/'
  if (pathname.startsWith(`${marker}/`)) return pathname.slice(marker.length)
  return pathname
}

async function handleApi(req, res, url, route, context) {
  const { store, runner, dataDir } = context
  const method = req.method ?? 'GET'
  const segments = route.split('/').filter(Boolean)
  const resource = segments[0]

  if (resource === 'state' && method === 'GET') {
    sendJson(res, 200, buildState(store, { dataDir, maxConcurrentRuns: runner.limit() }))
    return
  }

  if (resource === 'models' && method === 'GET') {
    const models = typeof context.listModels === 'function' ? await context.listModels() : []
    sendJson(res, 200, { models })
    return
  }

  if (resource === 'fs' && segments[1] === 'dirs' && method === 'GET') {
    handleDirectoryList(res, url)
    return
  }

  if (resource === 'tasks') {
    await handleTasks(req, res, url, segments, context)
    return
  }

  if (resource === 'prompts') {
    await handlePrompts(req, res, segments, context)
    return
  }

  if (resource === 'skills') {
    await handleSkills(req, res, segments, context)
    return
  }

  if (resource === 'findings') {
    await handleFindings(req, res, segments, context)
    return
  }

  if (resource === 'runs') {
    await handleRuns(req, res, segments, context)
    return
  }

  if (resource === 'settings') {
    if (method === 'PUT') {
      const body = await readJsonBody(req)
      if (body.maxConcurrentRuns !== undefined) {
        const value = Number(body.maxConcurrentRuns)
        if (!Number.isFinite(value) || value <= 0) throw httpError(400, '最大并发数必须为正整数')
        store.setSetting('maxConcurrentRuns', Math.floor(value))
      }
      if (body.runTimeoutMinutes !== undefined) {
        const value = Number(body.runTimeoutMinutes)
        if (!Number.isFinite(value) || value < 0) throw httpError(400, '超时时间必须为非负数字')
        store.setSetting('runTimeoutMinutes', Math.floor(value))
      }
      if (body.llmRetryDelayMinutes !== undefined) {
        const value = Number(body.llmRetryDelayMinutes)
        if (!Number.isFinite(value) || value < 0 || value > 1440) throw httpError(400, '自动续跑间隔必须为 0–1440 分钟')
        store.setSetting('llmRetryDelayMinutes', Math.floor(value))
      }
      if (body.llmRetryCount !== undefined) {
        const value = Number(body.llmRetryCount)
        if (!Number.isFinite(value) || value < 0 || value > 100) throw httpError(400, '自动续跑次数必须为 0–100')
        store.setSetting('llmRetryCount', Math.floor(value))
      }
      if (body.defaultProvider !== undefined) store.setSetting('defaultProvider', String(body.defaultProvider).trim())
      if (body.defaultModel !== undefined) store.setSetting('defaultModel', String(body.defaultModel).trim())
      sendJson(res, 200, { settings: store.allSettings() })
      return
    }
    if (method === 'GET') {
      sendJson(res, 200, { settings: store.allSettings() })
      return
    }
  }

  throw httpError(404, '接口不存在')
}

async function handleTasks(req, res, url, segments, context) {
  const { store, runner, reportsDir } = context
  const method = req.method ?? 'GET'
  const id = segments[1]
  const action = segments[2]

  if (method === 'GET' && segments.length === 1) {
    sendJson(res, 200, { tasks: store.listTasks() })
    return
  }
  if (method === 'POST' && segments.length === 1) {
    const body = await readJsonBody(req)
    const task = createTask(store, body)
    sendJson(res, 201, { task })
    return
  }
  if (method === 'PUT' && segments.length === 2) {
    const body = await readJsonBody(req)
    const task = updateTask(store, id, body)
    sendJson(res, 200, { task })
    return
  }
  if (method === 'DELETE' && segments.length === 2) {
    if (!store.getTask(id)) throw httpError(404, '审计任务不存在')
    store.deleteTask(id)
    sendJson(res, 200, { deleted: true })
    return
  }
  if (method === 'POST' && action === 'run') {
    const run = await runner.start(id, 'manual')
    sendJson(res, 200, { run })
    return
  }
  if (method === 'POST' && action === 'cancel') {
    const running = store.activeRuns().find(run => run.task_id === id)
    if (!running) throw httpError(400, '该任务没有正在进行的运行')
    runner.cancel(running.id)
    sendJson(res, 200, { cancelled: true })
    return
  }
  if (method === 'POST' && action === 'toggle') {
    const body = await readJsonBody(req)
    const current = store.getTask(id)
    if (!current) throw httpError(404, '审计任务不存在')
    const task = updateTask(store, id, { enabled: Boolean(body.enabled) })
    sendJson(res, 200, { task })
    return
  }
  if (method === 'GET' && action === 'report') {
    const format = (url.searchParams.get('format') ?? 'markdown').toLowerCase()
    const reportType = (url.searchParams.get('type') ?? 'standard').toLowerCase()
    const report = buildTaskReport(store, id, format, {
      type: reportType === 'skill' ? 'skill' : 'standard',
    })
    try {
      writeFileSync(join(reportsDir, report.filename), report.content)
    } catch {
      // archival copy is best-effort
    }
    res.writeHead(200, {
      'Content-Type': report.mime,
      'Content-Disposition': `attachment; filename="${report.filename}"`,
      'Cache-Control': 'no-store',
    })
    res.end(report.content)
    return
  }
  if (method === 'GET' && action === 'findings') {
    sendJson(res, 200, { findings: store.listFindings({ taskId: id }) })
    return
  }
  if (method === 'GET' && action === 'runs') {
    sendJson(res, 200, { runs: store.listRuns(id, 100) })
    return
  }
  throw httpError(404, '接口不存在')
}

async function handlePrompts(req, res, segments, context) {
  const { store } = context
  const method = req.method ?? 'GET'
  const id = segments[1]

  if (method === 'GET' && segments.length === 1) {
    sendJson(res, 200, { prompts: store.listPrompts() })
    return
  }
  if (method === 'GET' && id === 'export') {
    const prompts = store.listPrompts()
    const stamp = new Date().toISOString().slice(0, 10)
    res.writeHead(200, {
      'Content-Type': 'application/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-prompts-${stamp}.yml"`,
      'Cache-Control': 'no-store',
    })
    res.end(stringifyPromptsDocument(prompts))
    return
  }
  if (method === 'POST' && id === 'import') {
    const body = await readJsonBody(req)
    const records = parsePromptsDocument(body.yaml ?? '')
    if (records.length === 0) throw httpError(400, '备份文件中没有有效的提示词')
    let created = 0
    let updated = 0
    for (const record of records) {
      const result = store.upsertPromptByName(record)
      if (result.created) created += 1
      else updated += 1
    }
    sendJson(res, 200, { created, updated, total: records.length })
    return
  }
  if (method === 'POST' && segments.length === 1) {
    const body = await readJsonBody(req)
    const name = String(body.name ?? '').trim()
    if (!name) throw httpError(400, '提示词名称不能为空')
    if (store.getPromptByName(name)) throw httpError(400, '同名提示词已存在')
    const prompt = store.createPrompt({
      name,
      category: String(body.category ?? '').trim(),
      default_severity: normaliseSeverity(body.default_severity),
      content: String(body.content ?? ''),
      enabled: body.enabled !== false,
    })
    sendJson(res, 201, { prompt })
    return
  }
  if (method === 'PUT' && segments.length === 2) {
    const body = await readJsonBody(req)
    const current = store.getPrompt(id)
    if (!current) throw httpError(404, '提示词不存在')
    const name = String(body.name ?? current.name).trim()
    if (!name) throw httpError(400, '提示词名称不能为空')
    const duplicate = store.getPromptByName(name)
    if (duplicate && duplicate.id !== id) throw httpError(400, '同名提示词已存在')
    const prompt = store.updatePrompt(id, {
      name,
      category: body.category === undefined ? current.category : String(body.category).trim(),
      default_severity: body.default_severity === undefined ? current.default_severity : normaliseSeverity(body.default_severity),
      content: body.content === undefined ? current.content : String(body.content),
      enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
    })
    sendJson(res, 200, { prompt })
    return
  }
  if (method === 'DELETE' && segments.length === 2) {
    const prompt = store.getPrompt(id)
    if (!prompt) throw httpError(404, '提示词不存在')
    store.deletePrompt(id)
    sendJson(res, 200, { deleted: true })
    return
  }
  throw httpError(404, '接口不存在')
}

async function handleSkills(req, res, segments, context) {
  const { store, invalidateSkills } = context
  const method = req.method ?? 'GET'
  const id = segments[1]
  const action = segments[2]

  if (method === 'GET' && segments.length === 1) {
    sendJson(res, 200, { skills: store.listSkills() })
    return
  }
  if (method === 'GET' && id === 'export' && action === 'zip') {
    sendZip(res, buildAllSkillsArchive(store), `audit-skills-${stampNow()}.zip`)
    return
  }
  if (method === 'GET' && id === 'export') {
    const skills = store.listSkills()
    res.writeHead(200, {
      'Content-Type': 'application/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-skills-${stampNow()}.yml"`,
      'Cache-Control': 'no-store',
    })
    res.end(stringifySkillsDocument(skills))
    return
  }
  if (method === 'GET' && action === 'export') {
    const skill = store.getSkill(id)
    if (!skill) throw httpError(404, 'Skill 不存在')
    sendZip(res, createZip(buildSkillFiles(skill)), `${slugify(skill.name)}-${stampNow()}.zip`)
    return
  }
  if (method === 'GET' && segments.length === 2) {
    const skill = store.getSkill(id)
    if (!skill) throw httpError(404, 'Skill 不存在')
    sendJson(res, 200, { skill })
    return
  }
  if (method === 'POST' && id === 'import') {
    const body = await readJsonBody(req)
    const records = parseSkillsDocument(body.yaml ?? '')
    if (records.length === 0) throw httpError(400, '备份文件中没有有效的 Skill')
    let created = 0
    let updated = 0
    let dshSynced = 0
    for (const record of records) {
      const result = store.upsertSkillByName(record)
      if (result.created) created += 1
      else updated += 1
      if (syncSkillMirror(result.skill, invalidateSkills).synced) dshSynced += 1
    }
    sendJson(res, 200, { created, updated, total: records.length, dsh_synced: dshSynced })
    return
  }
  if (method === 'POST' && id === 'import-files') {
    const body = await readJsonBody(req)
    const files = Array.isArray(body.files) ? body.files : []
    if (files.length === 0) throw httpError(400, '没有收到要导入的文件')
    const groups = groupSkillFiles(files)
    const result = importSkillGroups(store, groups, invalidateSkills)
    sendJson(res, 200, result)
    return
  }
  if (method === 'POST' && id === 'import-zip') {
    const body = await readJsonBody(req)
    const base64 = String(body.zip ?? body.data ?? '').replace(/^data:[^,]*,/, '')
    if (!base64) throw httpError(400, '没有收到 ZIP 文件内容')
    let buffer
    try {
      buffer = Buffer.from(base64, 'base64')
    } catch {
      throw httpError(400, 'ZIP 文件内容不是合法的 Base64')
    }
    const files = readZip(buffer)
    if (files.length === 0) throw httpError(400, 'ZIP 中没有可读取的文本文件')
    const groups = groupSkillFiles(files)
    const result = importSkillGroups(store, groups, invalidateSkills)
    sendJson(res, 200, result)
    return
  }
  if (method === 'POST' && segments.length === 1) {
    const body = await readJsonBody(req)
    const fields = normaliseSkillInput(body)
    if (store.getSkillByName(fields.name)) throw httpError(400, '同名 Skill 已存在')
    const skill = store.createSkill({ ...fields, builtin: false })
    sendJson(res, 201, { skill, dsh: syncSkillMirror(skill, invalidateSkills) })
    return
  }
  if (method === 'PUT' && segments.length === 2) {
    const body = await readJsonBody(req)
    const current = store.getSkill(id)
    if (!current) throw httpError(404, 'Skill 不存在')
    const fields = normaliseSkillInput(body, current)
    if (!fields.name) throw httpError(400, 'Skill 名称不能为空')
    const duplicate = store.getSkillByName(fields.name)
    if (duplicate && duplicate.id !== id) throw httpError(400, '同名 Skill 已存在')
    const skill = store.updateSkill(id, fields)
    sendJson(res, 200, { skill, dsh: syncSkillMirror(skill, invalidateSkills) })
    return
  }
  if (method === 'DELETE' && segments.length === 2) {
    const skill = store.getSkill(id)
    if (!skill) throw httpError(404, 'Skill 不存在')
    removeSkillFromDsh(skill)
    // Drop the mirrored `/skill-name` from DSH's catalog right away instead of
    // waiting for the file watcher (a directory removal is not seen by it).
    invalidateSkills()
    store.deleteSkill(id)
    sendJson(res, 200, { deleted: true })
    return
  }
  throw httpError(404, '接口不存在')
}

/** Import parsed SKILL.md packages by name, updating existing skills in place. */
function importSkillGroups(store, groups, invalidate = () => {}) {
  if (!Array.isArray(groups) || groups.length === 0) throw httpError(400, '没有找到可导入的 SKILL.md')
  let created = 0
  let updated = 0
  let dshSynced = 0
  const imported = []
  for (const group of groups) {
    let fields
    try {
      fields = normaliseSkillInput({
        skill_md: group.skill_md,
        references: group.references,
      })
    } catch (error) {
      throw httpError(Number(error?.status) || 400, String(error?.message ?? error))
    }
    const result = store.upsertSkillByName({ ...fields, builtin: false })
    if (result.created) created += 1
    else updated += 1
    if (syncSkillMirror(result.skill, invalidate).synced) dshSynced += 1
    imported.push({ id: result.skill.id, name: result.skill.name })
  }
  return { created, updated, total: groups.length, skills: imported, dsh_synced: dshSynced }
}

/** Mirror a skill into DSH; failures must never break the import/save request. */
function syncSkillMirror(skill, invalidate = () => {}) {
  try {
    const result = syncSkillToDsh(skill)
    // Disabling a skill removes its mirror inside sync, so refresh either way.
    invalidate()
    return result
  } catch (error) {
    return { synced: false, reason: 'io-error', error: String(error?.message ?? error) }
  }
}

function buildAllSkillsArchive(store) {
  const skills = store.listSkills()
  if (skills.length === 0) throw httpError(400, '没有可导出的 Skill')
  const entries = []
  const usedNames = new Set()
  for (const skill of skills) {
    let slug = slugify(skill.name)
    if (usedNames.has(slug)) slug = `${slug}-${skill.id.slice(-4)}`
    usedNames.add(slug)
    for (const file of buildSkillFiles(skill)) {
      entries.push({ path: `${slug}/${file.path}`, content: file.content })
    }
  }
  return createZip(entries)
}

function sendZip(res, buffer, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
  })
  res.end(buffer)
}

function slugify(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'skill'
}

function stampNow() {
  return new Date().toISOString().slice(0, 10)
}

async function handleFindings(req, res, segments, context) {
  const { store } = context
  const method = req.method ?? 'GET'
  const id = segments[1]

  if (method === 'GET' && segments.length === 1) {
    sendJson(res, 200, { findings: store.listFindings() })
    return
  }
  if (method === 'PATCH' && segments.length === 2) {
    const body = await readJsonBody(req)
    if (body.status !== undefined && !FINDING_STATUSES.includes(body.status)) {
      throw httpError(400, '无效的漏洞状态')
    }
    const updated = store.updateFinding(id, {
      status: body.status,
      status_note: body.status_note,
    })
    if (!updated) throw httpError(404, '漏洞记录不存在')
    sendJson(res, 200, { finding: updated })
    return
  }
  if (method === 'DELETE' && segments.length === 2) {
    if (!store.deleteFinding(id)) throw httpError(404, '漏洞记录不存在')
    sendJson(res, 200, { deleted: true })
    return
  }
  throw httpError(404, '接口不存在')
}

async function handleRuns(req, res, segments, context) {
  const { store, runner, dataDir } = context
  const method = req.method ?? 'GET'
  const id = segments[1]
  const action = segments[2]

  if (method === 'GET' && segments.length === 1) {
    sendJson(res, 200, { runs: store.listRuns(undefined, 100) })
    return
  }
  if (method === 'GET' && action === 'trajectory') {
    const run = store.getRun(id)
    if (!run) throw httpError(404, '运行记录不存在')
    const trajectory = run.trajectory_path
    if (!trajectory || !existsSync(trajectory)) throw httpError(404, '该运行没有轨迹文件')
    const root = resolve(dataDir)
    if (!resolve(trajectory).startsWith(root + sep)) throw httpError(403, '轨迹文件不在插件数据目录内')
    const content = readFileSync(trajectory)
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${run.id}.jsonl"`,
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
    })
    res.end(content)
    return
  }
  if (method === 'DELETE' && segments.length === 2) {
    const run = store.getRun(id)
    if (!run) throw httpError(404, '运行记录不存在')
    if (run.status === 'running') throw httpError(409, '运行中的记录不能删除，请先取消运行')
    store.deleteRun(id)
    const trajectory = run.trajectory_path
    if (trajectory && resolve(trajectory).startsWith(resolve(dataDir) + sep)) {
      try {
        unlinkSync(trajectory)
      } catch {
        // Trajectory already missing; the record is still removed.
      }
    }
    sendJson(res, 200, { deleted: true })
    return
  }
  if (method === 'POST' && action === 'cancel') {
    runner.cancel(id)
    sendJson(res, 200, { cancelled: true })
    return
  }
  throw httpError(404, '接口不存在')
}

/** List child directories for the task form's directory picker. */
function handleDirectoryList(res, url) {
  const raw = String(url.searchParams.get('path') ?? '').trim()
  if (!raw) {
    const roots = process.platform === 'win32'
      ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`).filter(path => existsSync(path))
      : ['/']
    sendJson(res, 200, {
      path: '',
      parent: null,
      dirs: roots.map(path => ({ name: path, path })),
    })
    return
  }
  const target = resolve(raw)
  let info
  try {
    info = statSync(target)
  } catch {
    throw httpError(404, '目录不存在或无法访问')
  }
  if (!info.isDirectory()) throw httpError(400, '所选路径不是目录')
  const parent = dirname(target)
  const dirs = readdirSync(target, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  sendJson(res, 200, { path: target, parent: parent === target ? null : parent, dirs })
}

function serveStatic(res, base) {
  const name = base === '/' ? 'index.html' : base.replace(/^\//, '')
  const mime = STATIC_FILES[name]
  if (!mime) {
    sendJson(res, 404, { error: 'Not found' })
    return
  }
  try {
    const content = readFileSync(join(WEB_ROOT, name))
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' })
    res.end(content)
  } catch {
    sendJson(res, 500, { error: 'UI 资源缺失，请重新安装插件' })
  }
}

async function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}
