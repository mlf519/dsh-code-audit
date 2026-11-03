import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTaskReport } from './report.js'

/** Register the `/audit` slash command. */
export function registerAuditCommand(ctx, { store, runner, dataDir, log = () => {} }) {
  const commands = ctx.get('commands') ?? ctx.commands
  if (!commands) {
    log('当前运行环境没有 commands 服务，跳过 /audit 命令注册')
    return
  }

  ctx.effect(() => commands.register({
    name: 'audit',
    description: '代码审计：列出任务、启动审计、导出报告（/audit list | run <任务ID> | report <任务ID>）',
    input: { hint: 'list | run <任务ID> | report <任务ID> [markdown|html|json]' },
    async handler({ rawInput }) {
      const args = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      const subcommand = args[0] ?? 'help'

      if (subcommand === 'list' || subcommand === 'help' || subcommand === '') {
        const tasks = store.listTasks()
        if (subcommand === 'help' || tasks.length === 0) {
          const lines = ['用法：', '/audit list', '/audit run <任务ID>', '/audit report <任务ID> [markdown|html|json]', '/audit prompts']
          if (tasks.length > 0) {
            lines.push('', '当前任务：')
            for (const task of tasks) lines.push(`- ${task.id} ${task.name} [${task.status}]`)
          }
          return { kind: 'success', text: lines.join('\n') }
        }
        const lines = ['审计任务：']
        for (const task of tasks) {
          lines.push(`- ${task.id} ${task.name} [${task.status}] 目录：${task.repo_path}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      if (subcommand === 'prompts') {
        const prompts = store.listPrompts()
        const lines = ['漏洞审计提示词：']
        for (const prompt of prompts) {
          lines.push(`- ${prompt.enabled ? '启用' : '禁用'} ${prompt.name}（${prompt.category}，${prompt.default_severity}）`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      if (subcommand === 'run') {
        const taskId = args[1]
        if (!taskId) return { kind: 'error', text: '请提供任务 ID：/audit run <任务ID>' }
        const run = await runner.start(taskId, 'manual')
        return { kind: 'success', text: `审计已启动：${run.id}（任务 ${run.task_id}）` }
      }

      if (subcommand === 'report') {
        const taskId = args[1]
        if (!taskId) return { kind: 'error', text: '请提供任务 ID：/audit report <任务ID>' }
        const format = args[2] ?? 'markdown'
        const report = buildTaskReport(store, taskId, format)
        const reportsDir = join(dataDir, 'reports')
        mkdirSync(reportsDir, { recursive: true })
        const filePath = join(reportsDir, report.filename)
        writeFileSync(filePath, report.content)
        return { kind: 'success', text: `报告已生成：${filePath}` }
      }

      return { kind: 'error', text: `未知子命令：${subcommand}` }
    },
  }))
}
