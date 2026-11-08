import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rescheduleAfterRun } from './schedule.js'
import { findDshSkillMirror, invalidateDshSkills, syncSkillToDsh } from './dshskills.js'
import { resolveReportGuide, skillPromptContent } from './skillpack.js'
import { clip, nowIso } from './util.js'

/** Drives audit runs by creating isolated DSH agent sessions. */
export class AuditRunner {
  constructor({ ctx, store, dataDir, config = {}, resolveDefaultModel }) {
    this.ctx = ctx
    this.store = store
    this.dataDir = dataDir
    this.config = config
    this.resolveDefaultModel = typeof resolveDefaultModel === 'function' ? resolveDefaultModel : () => null
    this.trajectoryDir = join(dataDir, 'trajectories')
    this.reportsDir = join(dataDir, 'reports')
    mkdirSync(this.trajectoryDir, { recursive: true })
    mkdirSync(this.reportsDir, { recursive: true })
    /** runId -> { handle, sessionId, timeout, assistantText, summary, cancelRequested, progress, error } */
    this.active = new Map()
    /** Finished sessions kept alive so their conversation remains in the client sidebar. */
    this.retained = []
    this.maxRetained = Number(config.maxRetainedSessions) || 50
    /** sessionId -> runId */
    this.sessionRuns = new Map()
  }

  /** Live agent sessions visible to the developer; one at a time per run. */
  isRunning(taskId) {
    for (const entry of this.active.values()) {
      if (entry.taskId === taskId) return true
    }
    return false
  }

  limit() {
    const configured = Number(this.store.getSetting('maxConcurrentRuns', this.config.maxConcurrentRuns ?? 1))
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1
  }

  /**
   * Return the live DSH mirror for a skill, re-creating it when missing. A user
   * may uninstall the mirrored skill from the DSH skill center, which would
   * otherwise force every audit to fall back to inlining the whole skill text.
   */
  ensureSkillMirror(skill) {
    const existing = findDshSkillMirror(skill)
    if (existing) return existing
    const result = syncSkillToDsh(skill)
    if (!result.synced) return null
    invalidateDshSkills(this.ctx)
    return findDshSkillMirror(skill) ?? { name: result.name, dir: result.dir }
  }

  /** (Re)arm the overall run timeout for a live agent. */
  armTimeout(runId, handle) {
    const entry = this.active.get(runId)
    if (!entry) return
    if (entry.timeout) {
      clearTimeout(entry.timeout)
      entry.timeout = null
    }
    const timeoutMinutes = Number(
      this.store.getSetting('runTimeoutMinutes', this.config.runTimeoutMinutes ?? 60),
    )
    if (!TimeoutValid(timeoutMinutes)) return
    entry.timeout = setTimeout(() => {
      try {
        handle.agent.cancel({ kind: 'user' })
      } catch {
        // ignore
      }
      this.finish(runId, { cancelled: true, error: `审计超时（${timeoutMinutes} 分钟）` })
    }, timeoutMinutes * 60_000)
    entry.timeout.unref?.()
  }

  /** Wait for the agent to become idle, then either continue or finish. */
  watchIdle(runId) {
    const entry = this.active.get(runId)
    if (!entry) return
    entry.handle.agent.whenIdle().then(
      () => this.handleIdle(runId),
      error => {
        const current = this.active.get(runId)
        if (!current) return
        current.error = String(error?.message ?? error)
        this.handleIdle(runId)
      },
    )
  }

  handleIdle(runId) {
    const entry = this.active.get(runId)
    if (!entry) return
    if (entry.cancelRequested) {
      this.finish(runId, { cancelled: true })
      return
    }
    if (!entry.error) {
      this.finish(runId)
      return
    }
    this.scheduleRetry(runId, entry.error)
  }

  /**
   * A model reply failed (timeout, network error, 5xx...). Keep the run alive
   * and send a "continue" message after the configured delay, up to the
   * configured number of recoveries; only then mark the run as failed.
   */
  scheduleRetry(runId, error) {
    const entry = this.active.get(runId)
    if (!entry) return
    const limit = RetryCount(this.store.getSetting('llmRetryCount', this.config.llmRetryCount ?? 3))
    if (entry.retries >= limit) {
      this.finish(runId, { error })
      return
    }
    const delay = RetryMinutes(
      this.store.getSetting('llmRetryDelayMinutes', this.config.llmRetryDelayMinutes ?? 5),
    )
    const next = entry.retries + 1
    entry.error = null
    entry.progress.stage = '等待续跑'
    entry.progress.note = `${delay > 0 ? `${delay} 分钟后` : '立即'}自动续跑（第 ${next}/${limit} 次）：${clip(error, 160)}`
    entry.progress.percent = Math.max(entry.progress.percent ?? 0, 10)
    this.persistProgress(runId)
    // The overall timeout must not fire while we intentionally wait to resume.
    if (entry.timeout) {
      clearTimeout(entry.timeout)
      entry.timeout = null
    }
    entry.retryTimer = setTimeout(() => {
      const current = this.active.get(runId)
      if (!current) return
      current.retryTimer = null
      if (current.cancelRequested) {
        this.finish(runId, { cancelled: true })
        return
      }
      current.retries = next
      current.error = null
      current.progress.stage = '继续审计'
      current.progress.note = `自动续跑第 ${next}/${limit} 次（上次失败：${clip(error, 120)}）`
      this.persistProgress(runId)
      try {
        current.handle.agent.followup(current.createUserMessage({
          content: [{
            type: 'text',
            text: '继续。上一次模型回复失败或中断，请从中断处继续完成审计任务，不要重复已经完成的工作。',
          }],
          source: { kind: 'user' },
        }))
      } catch (retryError) {
        current.error = String(retryError?.message ?? retryError)
        this.scheduleRetry(runId, current.error)
        return
      }
      this.armTimeout(runId, current.handle)
      this.watchIdle(runId)
    }, delay * 60_000)
    entry.retryTimer.unref?.()
  }

  /**
   * Resolve provider/model for a run: the task selection wins, then the plugin
   * default, then the DSH default model used by normal client sessions.
   */
  resolveSelection(task) {
    let preset = {}
    try {
      preset = this.resolveDefaultModel() ?? {}
    } catch {
      preset = {}
    }
    const configuredProvider = String(
      task.provider || this.store.getSetting('defaultProvider', this.config.defaultProvider ?? '') || '',
    ).trim()
    const configuredModel = String(
      task.model || this.store.getSetting('defaultModel', this.config.defaultModel ?? '') || '',
    ).trim()
    const provider = configuredProvider || String(preset.provider ?? '').trim()
    let model = configuredModel
    // Only borrow the host default model when it belongs to the same provider.
    if (!model && (!configuredProvider || String(preset.provider ?? '') === configuredProvider)) {
      model = String(preset.model ?? '').trim()
    }
    return { provider, model, reasoningEffort: preset.reasoningEffort }
  }

  /** Start a run for a task. Returns the run record. */
  async start(taskId, trigger = 'manual') {
    const task = this.store.getTask(taskId)
    if (!task) throw new Error('审计任务不存在')
    if (!task.repo_path) throw new Error('审计任务缺少代码目录')
    if (this.isRunning(taskId)) throw new Error('该任务已有正在运行的审计')
    if (this.active.size >= this.limit()) throw new Error('已达到最大并发审计数，请稍后再试')

    const auditMode = task.audit_mode === 'skill' ? 'skill' : 'prompts'
    const skill = auditMode === 'skill'
      ? (task.skill_id ? this.store.getSkill(task.skill_id) : undefined)
      : undefined
    const selectedPrompts = auditMode === 'skill'
      ? []
      : task.prompt_ids.map(id => this.store.getPrompt(id)).filter(prompt => prompt && prompt.enabled)
    if (auditMode === 'skill') {
      if (!skill) throw new Error('任务选择的审计 Skill 不存在，请编辑任务重新选择')
      if (!skill.enabled) throw new Error(`审计 Skill 已禁用：${skill.name}`)
    } else if (selectedPrompts.length === 0) {
      throw new Error('请先为任务选择至少一条启用的漏洞审计提示词')
    }
    const auditUnits = auditMode === 'skill' ? 1 : selectedPrompts.length
    const unitNames = auditMode === 'skill' ? [skill.name] : selectedPrompts.map(prompt => prompt.name)

    const selection = this.resolveSelection(task)
    if (!selection.provider || !selection.model) {
      throw new Error('未选择模型：请在 DSH 设置中配置默认模型，或编辑任务选择模型后重试')
    }

    const run = this.store.createRun(taskId, trigger)
    const sessionId = randomUUID()
    const trajectoryPath = join(this.trajectoryDir, `${run.id}.jsonl`)
    writeFileSync(
      trajectoryPath,
      `${JSON.stringify({
        type: 'audit/run-start',
        time: nowIso(),
        data: { runId: run.id, taskId, taskName: task.name, repoPath: task.repo_path, trigger },
      })}\n`,
    )
    this.store.updateRun(run.id, { session_id: sessionId, trajectory_path: trajectoryPath })
    this.store.updateTask(taskId, { status: 'running', last_run_at: nowIso() })

    let handle
    try {
      const llm = await import('@deepseek-ai/dsh-llm')
      const createUserMessage = llm.createUserMessage
      if (typeof createUserMessage !== 'function') throw new Error('当前 DSH 版本缺少 createUserMessage')
      const agents = this.ctx.get('agents') ?? this.ctx.agents
      if (!agents) throw new Error('当前 DSH 运行环境未启用 Agent 服务')

      const presets = this.ctx.get?.('agentPresets')
      const agentOptions = {
        provider: selection.provider,
        model: selection.model,
      }
      if (selection.reasoningEffort) agentOptions.reasoningEffort = selection.reasoningEffort

      handle = await agents.create({
        sessionId,
        meta: { cwd: task.repo_path, ...(presets ? { agentPreset: presets.defaultId } : {}) },
        agentOptions: Object.keys(agentOptions).length ? agentOptions : undefined,
        setup: presets
          ? async agentCtx => {
              await presets.mount(agentCtx)
            }
          : undefined,
      })
      this.active.set(run.id, {
        handle,
        taskId,
        sessionId,
        assistantText: '',
        summary: '',
        cancelRequested: false,
        timeout: null,
        retryTimer: null,
        retries: 0,
        createUserMessage,
        error: null,
        progressTimer: null,
        promptNames: unitNames,
        donePrompts: [],
        auditMode,
        progress: {
          percent: 5,
          stage: '初始化',
          note: '已创建审计会话，等待 Agent 开始',
          prompt: '',
          done: 0,
          total: auditUnits,
          steps: 0,
          toolCalls: 0,
          findings: 0,
          updatedAt: nowIso(),
        },
      })
      this.sessionRuns.set(sessionId, run.id)
      this.persistProgress(run.id)

      // Skill mode prefers a native `/skill-name` invocation. Re-mirror first
      // when the mirror is missing (e.g. uninstalled via the DSH skill center),
      // otherwise the prompt has to carry the whole skill text inline.
      const skillMirror = auditMode === 'skill' ? this.ensureSkillMirror(skill) : null
      const message = createUserMessage({
        content: [{
          type: 'text',
          text: auditMode === 'skill' ? buildSkillAuditPrompt(task, skill, skillMirror) : buildAuditPrompt(task, selectedPrompts),
        }],
        source: { kind: 'user' },
      })
      handle.agent.followup(message)

      this.armTimeout(run.id, handle)
      this.watchIdle(run.id)
    } catch (error) {
      // Drop any half-initialized entry so later runs are not blocked.
      const partial = this.active.get(run.id)
      if (partial) {
        if (partial.timeout) clearTimeout(partial.timeout)
        if (partial.retryTimer) clearTimeout(partial.retryTimer)
        if (partial.progressTimer) clearTimeout(partial.progressTimer)
        this.active.delete(run.id)
        this.sessionRuns.delete(sessionId)
      }
      if (handle) {
        try {
          await handle.dispose()
        } catch {
          // ignore
        }
      }
      this.store.updateRun(run.id, {
        status: 'failed',
        finished_at: nowIso(),
        error: String(error?.message ?? error),
        progress: {
          percent: 0,
          stage: '失败',
          note: clip(error?.message ?? error, 300),
          done: 0,
          total: auditUnits,
          steps: 0,
          toolCalls: 0,
          findings: 0,
          updatedAt: nowIso(),
        },
      })
      this.store.updateTask(taskId, { status: 'failed' })
      throw error
    }

    return this.store.getRun(run.id)
  }

  /** Cancel an active run. */
  cancel(runId) {
    const entry = this.active.get(runId)
    if (!entry) throw new Error('该运行已结束')
    entry.cancelRequested = true
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
      this.finish(runId, { cancelled: true })
      return
    }
    try {
      entry.handle.agent.cancel({ kind: 'user' })
    } catch {
      // ignore
    }
  }

  /** Record one session event into the run's trajectory JSONL. */
  onSessionEvent(session, event) {
    const runId = this.sessionRuns.get(session.id)
    if (!runId) return
    const entry = this.active.get(runId)
    if (!entry) return
    const run = this.store.getRun(runId)
    if (!run?.trajectory_path) return
    try {
      appendFileSync(
        run.trajectory_path,
        `${JSON.stringify({ sessionId: session.id, seq: event.seq, time: event.time, type: event.type, data: event.data })}\n`,
      )
    } catch {
      // ignore
    }
    if (event.type === 'assistant/message') {
      const text = extractMessageText(event.data?.message)
      if (text) entry.assistantText = text
    } else if (event.type === 'tool/call') {
      entry.progress.toolCalls += 1
      this.touchProgress(runId)
    } else if (event.type === 'step/end') {
      entry.progress.steps += 1
      if (entry.progress.stage === '初始化') {
        entry.progress.stage = '代码探索'
        entry.progress.note = 'Agent 正在读取代码'
        entry.progress.percent = Math.max(entry.progress.percent ?? 0, 8)
      }
      this.touchProgress(runId)
    } else if (event.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error') {
        const message = String(reason.error?.message ?? 'Agent 运行失败').trim()
        entry.error = message
        entry.progress.stage = '失败'
        entry.progress.note = clip(message, 200)
        this.persistProgress(runId)
        // `whenIdle` resolves for failed turns too; idle handling decides
        // whether to auto-continue or fail the run.
      }
    }
  }

  /** Mark progress as changed and flush it to SQLite at most once per second. */
  touchProgress(runId) {
    const entry = this.active.get(runId)
    if (!entry) return
    entry.progress.updatedAt = nowIso()
    if (entry.progressTimer) return
    entry.progressTimer = setTimeout(() => {
      entry.progressTimer = null
      this.persistProgress(runId)
    }, 900)
    entry.progressTimer.unref?.()
  }

  persistProgress(runId) {
    const entry = this.active.get(runId)
    if (!entry) return
    try {
      this.store.updateRun(runId, { progress: { ...entry.progress } })
    } catch {
      // ignore
    }
  }

  /** Store progress reported by the audit agent during a run. */
  reportProgress(context, input) {
    const entry = this.active.get(context.runId)
    if (!entry) throw new Error('当前没有正在运行的审计')
    const progress = entry.progress
    const rawName = String(input.prompt_name ?? '').trim()
    const matched = entry.promptNames.find(
      name => name === rawName || (rawName && (name.includes(rawName) || rawName.includes(name))),
    )
    const label = matched || rawName

    if (input.status === 'done') {
      if (matched && !entry.donePrompts.includes(matched)) entry.donePrompts.push(matched)
      progress.done = entry.donePrompts.length
      progress.percent = Math.min(95, 10 + Math.round((progress.done / Math.max(progress.total, 1)) * 80))
      progress.stage = progress.done >= progress.total ? '汇总' : '类型审计'
      progress.prompt = progress.done >= progress.total ? '' : label
      progress.note = clip(input.note, 200) ||
        (progress.done >= progress.total ? '全部类型审计完成，正在生成总结' : `已完成：${label}`)
    } else {
      progress.stage = '类型审计'
      progress.prompt = label
      progress.note = clip(input.note, 200) || `正在审计：${label}`
      const base = 10 + Math.round((progress.done / Math.max(progress.total, 1)) * 80)
      progress.percent = Math.max(progress.percent ?? 0, Math.min(90, base))
    }

    this.persistProgress(context.runId)
    return {
      percent: progress.percent,
      done: progress.done,
      total: progress.total,
      stage: progress.stage,
      note: progress.note,
    }
  }

  /** The active run for an agent (used by the submit tools). */
  contextForAgent(agent) {
    const sessionId = agent?.session?.id
    if (!sessionId) return undefined
    const runId = this.sessionRuns.get(sessionId)
    if (!runId) return undefined
    const run = this.store.getRun(runId)
    if (!run || run.status !== 'running') return undefined
    return { runId, taskId: run.task_id }
  }

  /** Store a finding submitted by the audit agent. */
  submitFinding(context, input) {
    const task = this.store.getTask(context.taskId)
    if (!task) throw new Error('任务不存在')
    const title = clip(input.title, 200)
    if (!title) throw new Error('漏洞标题不能为空')
    const filePath = String(input.file_path ?? '').replaceAll('\\', '/')
    const lineStart = Number.isFinite(Number(input.line_start)) ? Number(input.line_start) : null
    const lineEnd = Number.isFinite(Number(input.line_end)) ? Number(input.line_end) : lineStart
    const skill = task.audit_mode === 'skill' && task.skill_id ? this.store.getSkill(task.skill_id) : undefined
    const prompt = skill
      ? undefined
      : input.prompt_name
        ? this.store.getPromptByName(input.prompt_name)
        : undefined
    const promptId = skill ? null : prompt?.id ?? task.prompt_ids[0] ?? null
    const skillId = skill?.id ?? null
    const fingerprint = createHash('sha256')
      .update(`${context.taskId}|${filePath}|${lineStart ?? ''}|${title.toLowerCase()}`)
      .digest('hex')
      .slice(0, 24)
    const result = this.store.addFinding(context.taskId, {
      run_id: context.runId,
      prompt_id: promptId,
      skill_id: skillId,
      title,
      severity: input.severity,
      category: input.category || prompt?.category || skill?.category || '',
      file_path: filePath,
      line_start: lineStart,
      line_end: lineEnd,
      code_snippet: clip(input.code_snippet, 2000),
      description: String(input.description ?? ''),
      evidence: String(input.evidence ?? ''),
      recommendation: String(input.recommendation ?? ''),
      poc: clip(input.poc_request, 4000),
      fingerprint,
    })
    this.store.updateRun(context.runId, { findings_count: this.store.countFindingsForRun(context.runId) })
    const entry = this.active.get(context.runId)
    if (entry) {
      entry.progress.findings = this.store.countFindingsForRun(context.runId)
      this.touchProgress(context.runId)
    }
    return result
  }

  /** Store a report the agent formatted according to the task's Skill. */
  submitSkillReport(context, content) {
    const task = this.store.getTask(context.taskId)
    if (!task || task.audit_mode !== 'skill') throw new Error('只有 Skill 模式的审计任务可以提交 Skill 报告')
    const skill = task.skill_id ? this.store.getSkill(task.skill_id) : undefined
    const reportGuide = String(skill?.report_guide ?? '').trim()
      || resolveReportGuide(skill?.references ?? [])
    if (!skill || !reportGuide) throw new Error('当前审计 Skill 没有规定报告格式')
    const text = String(content ?? '').trim()
    if (!text) throw new Error('Skill 报告内容不能为空')
    this.store.updateRun(context.runId, { skill_report: clip(text, 200000) })
    const entry = this.active.get(context.runId)
    if (entry) {
      entry.progress.stage = '报告'
      entry.progress.percent = Math.max(entry.progress.percent ?? 0, 98)
      entry.progress.note = '已提交 Skill 报告，等待会话结束'
      this.persistProgress(context.runId)
    }
  }

  /** Store the agent's run summary. */
  submitSummary(context, summary) {
    const entry = this.active.get(context.runId)
    if (entry) {
      entry.summary = String(summary ?? '')
      entry.progress.stage = '汇总'
      entry.progress.percent = Math.max(entry.progress.percent ?? 0, 95)
      entry.progress.note = '已提交审计总结，等待会话结束'
      this.persistProgress(context.runId)
    }
    this.store.updateRun(context.runId, { summary: clip(summary, 4000) })
  }

  finish(runId, { error, cancelled = false } = {}) {
    const entry = this.active.get(runId)
    if (!entry) return
    this.active.delete(runId)
    this.sessionRuns.delete(entry.sessionId)
    if (entry.timeout) clearTimeout(entry.timeout)
    if (entry.retryTimer) clearTimeout(entry.retryTimer)
    if (entry.progressTimer) clearTimeout(entry.progressTimer)

    const run = this.store.getRun(runId)
    if (!run) return
    const findingsCount = this.store.countFindingsForRun(runId)
    const failure = error ?? entry.error
    const status = cancelled || entry.cancelRequested ? 'cancelled' : failure ? 'failed' : 'completed'
    const progress = {
      ...entry.progress,
      done: entry.donePrompts.length,
      findings: findingsCount,
      percent: status === 'completed' ? 100 : entry.progress.percent ?? 0,
      stage: status === 'failed' ? '失败' : status === 'cancelled' ? '已取消' : '完成',
      note: clip(failure || (status === 'cancelled' ? '运行已取消' : '审计完成'), 300),
      updatedAt: nowIso(),
    }
    this.store.updateRun(runId, {
      status,
      finished_at: nowIso(),
      findings_count: findingsCount,
      summary: clip(entry.summary || entry.assistantText, 4000),
      error: failure ? clip(failure, 1000) : null,
      progress,
    })

    const task = this.store.getTask(run.task_id)
    if (task) {
      if (task.schedule_type !== 'manual' && task.enabled) {
        const next = rescheduleAfterRun(task)
        this.store.updateTask(task.id, { ...next, status: next.next_run_at ? 'scheduled' : status })
      } else {
        this.store.updateTask(task.id, { status, next_run_at: null })
      }
    }

    try {
      appendFileSync(
        run.trajectory_path ?? '',
        `${JSON.stringify({
          type: 'audit/run-end',
          time: nowIso(),
          data: { runId, status, findingsCount, summary: clip(entry.summary || entry.assistantText, 2000) },
        })}\n`,
      )
    } catch {
      // ignore
    }

    // Keep the conversation in the sidebar instead of disposing the session.
    this.retainSession(entry, task, run)
  }

  /**
   * Keep the finished session alive: the client sidebar lists live sessions,
   * so disposing it removes the conversation from the menu panel. Rename it to
   * "<task name> · <time>" before retaining it.
   */
  retainSession(entry, task, run) {
    const session = entry.handle?.agent?.session ?? entry.handle?.session
    if (session) {
      const title = sessionTitle(task?.name, run?.started_at)
      try {
        const titles = this.ctx.get?.('sessionTitle') ?? this.ctx.sessionTitle
        const result = titles?.rename?.(session, title)
        if (result?.catch) result.catch(() => {})
      } catch {
        // Title is best-effort; keep the conversation even if renaming fails.
      }
    }
    this.retained.push({ sessionId: entry.sessionId, handle: entry.handle })
    while (this.retained.length > this.maxRetained) {
      const oldest = this.retained.shift()
      try {
        oldest.handle.dispose()
      } catch {
        // ignore
      }
    }
  }

  /** Dispose every live agent; called on plugin unload. */
  dispose() {
    for (const [runId, entry] of this.active) {
      if (entry.timeout) clearTimeout(entry.timeout)
      if (entry.retryTimer) clearTimeout(entry.retryTimer)
      if (entry.progressTimer) clearTimeout(entry.progressTimer)
      try {
        entry.handle.agent.cancel({ kind: 'disposed' })
      } catch {
        // ignore
      }
      try {
        entry.handle.dispose()
      } catch {
        // ignore
      }
      this.store.updateRun(runId, {
        status: 'cancelled',
        finished_at: nowIso(),
        error: '插件已卸载，审计运行已终止',
      })
    }
    this.active.clear()
    for (const item of this.retained) {
      try {
        item.handle.dispose()
      } catch {
        // ignore
      }
    }
    this.retained = []
    this.sessionRuns.clear()
  }
}

function TimeoutValid(value) {
  return Number.isFinite(value) && value > 0
}

/** Auto-continue delay in minutes, clamped to the 24h ceiling. */
function RetryMinutes(value) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes <= 0) return 0
  return Math.min(1440, Math.floor(minutes))
}

/** How many times a failed model reply may be auto-continued. */
function RetryCount(value) {
  const count = Number(value)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.min(100, Math.floor(count))
}

/** Session titles are limited to 120 bytes in the client. */
function clipBytes(text, maxBytes) {
  let result = ''
  for (const char of String(text)) {
    if (Buffer.byteLength(result + char, 'utf8') > maxBytes) break
    result += char
  }
  return result
}

function sessionTitle(name, startedAt) {
  const date = new Date(startedAt || Date.now())
  const pad = value => String(value).padStart(2, '0')
  const suffix = Number.isNaN(date.getTime())
    ? ''
    : ` · ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  const base = String(name ?? '').trim() || '代码审计'
  return `${clipBytes(base, Math.max(12, 120 - Buffer.byteLength(suffix))) || '代码审计'}${suffix}`
}

function extractMessageText(message) {
  if (!message) return ''
  const content = message.content
  if (Array.isArray(content)) {
    return content
      .filter(block => block?.type === 'text')
      .map(block => String(block.text ?? ''))
      .join('\n')
      .trim()
  }
  return typeof content === 'string' ? content.trim() : ''
}

/** Compose the single audit instruction sent to the new agent session. */
export function buildAuditPrompt(task, prompts) {
  const sections = prompts.map((prompt, index) => {
    const label = `${index + 1}. ${prompt.name}（分类：${prompt.category || '未分类'}，默认级别：${prompt.default_severity}）`
    return `### ${label}\n${prompt.content.trim()}`
  })

  return `你是一名资深代码安全审计工程师，正在执行一个自动化的代码审计任务。

# 任务信息
- 任务名称：${task.name}
- 审计目录：${task.repo_path}
- 任务说明：${task.description || '（无）'}

# 审计范围约束
- 只审计下面列出的漏洞类型。未列出的漏洞类型一律不审计、不报告。
- 必须使用只读方式查看代码，禁止修改、创建、删除仓库中的任何文件，禁止执行会产生副作用的命令。
- 所有文件路径使用相对审计目录的路径，禁止使用绝对路径。
- 只报告有明确代码证据的问题；不确定、无法定位到具体代码的猜测不要上报。

# 本次启用的漏洞审计提示词
${sections.join('\n\n')}

# 进度上报（必须遵守）
- 按上面的顺序逐个类型审计，不要跳过。
- 开始审计某个类型前，调用工具 \`code_audit_report_progress\`，参数 prompt_name 为该类型名称，status 为 started。
- 完成该类型（无论是否发现问题）后再次调用，status 为 done，note 用一句话说明结果，例如"已检查 12 个文件，未发现符合条件的问题"。
- 全部类型完成后调用 \`code_audit_submit_summary\`。

# 上报方式（必须遵守）
每确认一个漏洞，调用工具 \`code_audit_submit_finding\`，参数含义：
- title：简短明确的漏洞标题
- severity：critical / high / medium / low / info 之一
- category：漏洞分类
- file_path：相对路径
- line_start / line_end：证据代码所在行号（整数）
- code_snippet：关键代码片段（不超过 20 行）
- description：漏洞成因与影响
- evidence：可复现的触发路径或数据流（source → sink）
- recommendation：具体修复建议
- poc_request：可利用漏洞必须提供 PoC 请求包示例。包含（1）原始 HTTP 请求：请求行、Host、必要的 Cookie/Token/Content-Type 等 Header、Body；（2）一条把同一请求写成可直接执行的 curl 命令。仅当漏洞无法通过 HTTP 触发（如本地条件、需依赖内部状态）时留空，并在 evidence 中说明复现步骤。
- prompt_name：命中的审计提示词名称（例如 "${prompts[0]?.name ?? ''}"）

全部审计完成后，调用工具 \`code_audit_submit_summary\` 输出本次审计总结：已覆盖的漏洞类型、发现数量、未发现问题的类型及原因。
如果本次没有任何发现，也必须调用 \`code_audit_submit_summary\` 说明"未发现符合条件的问题"，不要直接结束。`
}

/** Compose the audit instruction for a task driven by a code audit Skill. */
export function buildSkillAuditPrompt(task, skill, mirror = null) {
  const reportGuide = String(skill.report_guide ?? '').trim()
  const native = Boolean(mirror?.name)
  const skillSection = native
    ? `# Skill 调用（必须遵守）
本次任务使用 DSH 原生 Skill：/${mirror.name}
该 Skill 的 SKILL.md 正文由 DSH 加载；其中提到的 references/ 文件请按需读取 ${mirror.dir} 下的对应路径，不要跳过。
如果 DSH 未自动加载该 Skill，请直接读取 ${join(mirror.dir, 'SKILL.md')} 作为审计规定。`
    : `# Skill 规定（必须遵守）
${skillPromptContent(skill) || '（该 Skill 未提供具体审计规定）'}`
  const reportSection = reportGuide
    ? `
# Skill 报告格式（由 Skill 规定，必须遵循）
报告的结构、章节、字段与措辞全部按该 Skill 的规定生成；本插件不改变、不简化报告要求：

${reportGuide}
`
    : ''
  const reportRequirement = reportGuide
    ? '- 按 Skill 规定生成完整报告。若 Skill 要求写入项目目录，照 Skill 执行；同时把同一份报告内容通过 `code_audit_submit_skill_report` 提交一次，供插件归档与导出。'
    : '- 该 Skill 未规定报告格式：若 Skill 要求写文件，照 Skill 执行；如有最终报告，也通过 `code_audit_submit_skill_report` 提交一份，便于插件导出。'
  const callLine = native ? `/${mirror.name}\n\n` : ''

  return `${callLine}你是一名资深代码安全审计工程师，正在按照指定的审计 Skill 执行一个自动化的代码审计任务。

# 任务信息
- 任务名称：${task.name}
- 审计目录：${task.repo_path}
- 任务说明：${task.description || '（无）'}

# 审计 Skill
- 名称：${skill.name}
- 分类：${skill.category || '未分类'}
- 说明：${skill.description || '（无）'}

${skillSection}

# 审计要求的优先级（必须遵守）
- 该 Skill 是本任务的唯一权威：审计范围、检查项、判定标准、执行步骤、工具用法、报告格式与产出位置全部严格按 Skill 执行；Skill 未要求的内容不要审计、不要报告。
- 本插件只提供附加能力（进度上报、漏洞记录、报告归档 / 导出），不得改变、简化、跳过或削弱 Skill 的任何审计要求、步骤与技巧；两者冲突时以 Skill 为准。
- Skill 要求写入文件时（例如把报告写入被审计项目的 \`reports/\`、生成清单或 PoC 文件），按 Skill 要求创建这些文件，这是只读约束的唯一例外，不得因为插件而省略该产出。
- Skill 未要求写入的场景，仍以只读方式查看代码，不要修改仓库中的其他文件，不要执行会产生副作用的命令。
- 所有文件路径使用相对审计目录的路径，禁止使用绝对路径。
- 只报告有明确代码证据的问题；不确定、无法定位到具体代码的猜测不要上报。

# 进度上报（附加能力，不影响 Skill 流程）
- 按 Skill 规定的流程审计；在不打断 Skill 步骤的前提下，开始前调用工具 \`code_audit_report_progress\`，参数 prompt_name 为 "${skill.name}"，status 为 started。
- 审计完成后再次调用，status 为 done，note 用一句话说明结果，例如"已检查 18 个文件，发现 2 个问题"。

# 漏洞记录（附加能力，不改变 Skill 判定）
每确认一个漏洞，调用工具 \`code_audit_submit_finding\`，参数含义：
- title：简短明确的漏洞标题
- severity：critical / high / medium / low / info 之一
- category：漏洞分类
- file_path：相对路径
- line_start / line_end：证据代码所在行号（整数）
- code_snippet：关键代码片段（不超过 20 行）
- description：漏洞成因与影响
- evidence：可复现的触发路径或数据流（source → sink）
- recommendation：具体修复建议
- poc_request：可利用漏洞必须提供 PoC 请求包示例。包含（1）原始 HTTP 请求：请求行、Host、必要的 Cookie/Token/Content-Type 等 Header、Body；（2）一条把同一请求写成可直接执行的 curl 命令。仅当漏洞无法通过 HTTP 触发（如本地条件、需依赖内部状态）时留空，并在 evidence 中说明复现步骤。
- prompt_name：Skill 模式下无需填写。

${reportSection}
# 结束要求
- 先完成 Skill 规定的全部步骤与产出（含 Skill 要求的文件写入 / 报告），再做插件侧归档。
- 调用 \`code_audit_submit_summary\` 输出本次审计总结：Skill 覆盖范围、发现数量、未覆盖或未发现问题的原因。
${reportRequirement}
如果本次没有任何发现，也必须调用 \`code_audit_submit_summary\` 说明"未发现符合条件的问题"，不要直接结束。`
}
