import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTaskReport } from './report.js'
import { createTask } from './service.js'
import { FINDING_STATUSES, SEVERITIES } from './util.js'

const textResult = value => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Register the model-facing audit tools. */
export async function registerAuditTools(ctx, { store, runner, dataDir, log = () => {} }) {
  let defineTool
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    log(`未找到 dsh-tools，跳过 Agent 工具注册：${error?.message ?? error}`)
    return
  }
  const tools = ctx.get('tools') ?? ctx.tools
  if (!tools) {
    log('当前运行环境没有 tools 服务，跳过 Agent 工具注册')
    return
  }

  const register = definition => {
    ctx.effect(() => tools.register(definition))
  }

  register(defineTool({
    name: 'code_audit_list_tasks',
    description: '列出所有代码审计任务及其状态、调度时间和漏洞数量。用户询问审计任务时使用。',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute() {
      const tasks = store.listTasks().map(task => ({
        id: task.id,
        name: task.name,
        repo_path: task.repo_path,
        status: task.status,
        enabled: task.enabled,
        schedule_type: task.schedule_type,
        schedule_at: task.schedule_at,
        schedule_cron: task.schedule_cron,
        next_run_at: task.next_run_at,
        prompt_count: task.prompt_ids.length,
        last_run_at: task.last_run_at,
      }))
      return { tasks }
    },
  }))

  register(defineTool({
    name: 'code_audit_create_task',
    description: '新建一个代码审计任务。可指定审计目录、任务说明、要启用的漏洞审计提示词，以及定时执行计划。',
    parameters: {
      name: { type: 'string', description: '任务名称', required: true },
      repo_path: { type: 'string', description: '要审计的本地代码目录绝对路径', required: true },
      description: { type: 'string', description: '任务说明，例如关注的模块或业务背景' },
      prompt_names: {
        type: 'array',
        items: { type: 'string' },
        description: '要启用的漏洞审计提示词名称列表；省略则审计全部启用的提示词',
      },
      schedule_type: {
        type: 'string',
        enum: ['manual', 'once', 'cron', 'interval'],
        description: '调度类型：manual 手动、once 定时一次、cron Cron 表达式、interval 固定间隔',
      },
      schedule_at: { type: 'string', description: 'once 类型的执行时间（ISO 8601）' },
      schedule_cron: { type: 'string', description: 'cron 类型的 5 字段表达式，例如 "0 2 * * *"' },
      interval_minutes: { type: 'integer', description: 'interval 类型的间隔分钟数' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute(args) {
      const allPrompts = store.listPrompts()
      const promptIds = args.prompt_names?.length
        ? args.prompt_names.map(name => {
            const prompt = allPrompts.find(item => item.name === name)
            if (!prompt) throw new Error(`提示词不存在：${name}`)
            return prompt.id
          })
        : allPrompts.filter(prompt => prompt.enabled).map(prompt => prompt.id)
      const task = createTask(store, {
        name: args.name,
        repo_path: args.repo_path,
        description: args.description ?? '',
        prompt_ids: promptIds,
        schedule_type: args.schedule_type ?? 'manual',
        schedule_at: args.schedule_at,
        schedule_cron: args.schedule_cron,
        interval_minutes: args.interval_minutes,
      })
      return { task }
    },
  }))

  register(defineTool({
    name: 'code_audit_run_task',
    description: '立即启动一个代码审计任务。任务将创建一个独立的审计会话，按选中的漏洞提示词进行审计。',
    parameters: {
      task_id: { type: 'string', description: '任务 ID', required: true },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute(args) {
      const run = await runner.start(args.task_id, 'tool')
      return { run_id: run.id, task_id: run.task_id, status: run.status }
    },
  }))

  register(defineTool({
    name: 'code_audit_list_prompts',
    description: '列出可用的漏洞审计提示词（名称、分类、默认严重级别、是否启用）。',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute() {
      return {
        prompts: store.listPrompts().map(prompt => ({
          id: prompt.id,
          name: prompt.name,
          category: prompt.category,
          default_severity: prompt.default_severity,
          enabled: prompt.enabled,
          builtin: prompt.builtin,
        })),
      }
    },
  }))

  register(defineTool({
    name: 'code_audit_submit_finding',
    description: '在代码审计过程中上报一个已确认的漏洞。必须提供代码证据与触发路径，不要上报猜测。',
    parameters: {
      title: { type: 'string', description: '漏洞标题', required: true },
      severity: {
        type: 'string',
        enum: SEVERITIES,
        description: '严重级别',
        required: true,
      },
      file_path: { type: 'string', description: '相对审计目录的文件路径', required: true },
      line_start: { type: 'integer', description: '证据代码起始行号', required: true },
      line_end: { type: 'integer', description: '证据代码结束行号' },
      category: { type: 'string', description: '漏洞分类' },
      code_snippet: { type: 'string', description: '关键代码片段（不超过 20 行）' },
      description: { type: 'string', description: '漏洞成因与影响', required: true },
      evidence: { type: 'string', description: '触发路径或数据流 source → sink' },
      recommendation: { type: 'string', description: '修复建议' },
      poc_request: {
        type: 'string',
        description: '可利用漏洞的 PoC 请求包示例：原始 HTTP 请求（方法、路径、Host、关键 Header、Body）加一条可直接执行的 curl 命令；不适用时留空',
      },
      prompt_name: { type: 'string', description: '命中的审计提示词名称' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const context = runner.contextForAgent(exec.agent)
      if (!context) throw new Error('当前不在代码审计运行中，无法上报漏洞')
      const result = runner.submitFinding(context, args)
      return {
        finding_id: result.finding.id,
        created: result.created,
        task_id: result.finding.task_id,
        severity: result.finding.severity,
        title: result.finding.title,
      }
    },
  }))

  register(defineTool({
    name: 'code_audit_submit_summary',
    description: '在代码审计结束时提交运行总结：覆盖的漏洞类型、发现数量、未发现问题及原因。',
    parameters: {
      summary: { type: 'string', description: '本次审计总结', required: true },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const context = runner.contextForAgent(exec.agent)
      if (!context) throw new Error('当前不在代码审计运行中，无法提交总结')
      runner.submitSummary(context, args.summary)
      return { ok: true }
    },
  }))

  register(defineTool({
    name: 'code_audit_report_progress',
    description: '在代码审计过程中上报当前进度：开始或完成某个漏洞类型的审计。控制台用这些上报显示扫描进度。',
    parameters: {
      prompt_name: {
        type: 'string',
        description: '正在审计的漏洞提示词名称，与任务提示词标题中的名称一致',
        required: true,
      },
      status: {
        type: 'string',
        enum: ['started', 'done'],
        description: 'started 开始审计该类型，done 已完成该类型',
        required: true,
      },
      note: { type: 'string', description: '一句话进度说明，例如已检查的文件数量与结果' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const context = runner.contextForAgent(exec.agent)
      if (!context) throw new Error('当前不在代码审计运行中，无法上报进度')
      return runner.reportProgress(context, args)
    },
  }))

  register(defineTool({
    name: 'code_audit_update_finding',
    description: '更新漏洞的处理状态：verified 已确认、ignored 已忽略、false_positive 误报、fixed 已修复、open 重新打开。',
    parameters: {
      finding_id: { type: 'string', description: '漏洞记录 ID', required: true },
      status: {
        type: 'string',
        enum: FINDING_STATUSES,
        description: '新的处理状态',
        required: true,
      },
      status_note: { type: 'string', description: '处理备注，例如忽略原因或验证结论' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute(args) {
      const finding = store.updateFinding(args.finding_id, {
        status: args.status,
        status_note: args.status_note,
      })
      if (!finding) throw new Error('漏洞记录不存在')
      return { finding: { id: finding.id, title: finding.title, status: finding.status, status_note: finding.status_note } }
    },
  }))

  register(defineTool({
    name: 'code_audit_export_report',
    description: '导出指定审计任务的报告（markdown、html 或 json），返回报告文件路径。',
    parameters: {
      task_id: { type: 'string', description: '任务 ID', required: true },
      format: {
        type: 'string',
        enum: ['markdown', 'html', 'json'],
        description: '报告格式，默认 markdown',
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => textResult(value) },
    async execute(args) {
      const report = buildTaskReport(store, args.task_id, args.format ?? 'markdown')
      const reportsDir = join(dataDir, 'reports')
      mkdirSync(reportsDir, { recursive: true })
      const filePath = join(reportsDir, report.filename)
      writeFileSync(filePath, report.content)
      return { path: filePath, filename: report.filename, mime: report.mime }
    },
  }))
}
