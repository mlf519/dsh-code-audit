import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTaskReport } from './report.js'

const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Register the `/audit` slash command. */
export function registerAuditCommand(ctx, { store, runner, dataDir, log = () => {} }) {
  // The commands service may load after this plugin, so wait for it instead of
  // probing once at apply time — otherwise `/audit` is never registered and a
  // stale entry in the client's command menu fails with "unknown command".
  if (typeof ctx.inject !== 'function') {
    log('当前运行环境不支持服务注入，跳过 /audit 命令注册')
    return
  }

  ctx.inject(['commands'], scoped => {
    scoped.effect(() => scoped.commands.register({
      name: 'audit',
      description: '代码审计：列出任务/Skill、启动审计、导出报告（/audit list | skills | run <任务ID> | report <任务ID>）',
      input: { hint: 'list | skills | run <任务ID> | report <任务ID> [markdown|html|json]' },
      async handler({ rawInput }) {
        const args = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const subcommand = args[0] ?? 'help'

        if (subcommand === 'list' || subcommand === 'help' || subcommand === '') {
          const tasks = store.listTasks()
          if (subcommand === 'help' || tasks.length === 0) {
            const lines = ['用法：', '/audit list', '/audit skills', '/audit run <任务ID>', '/audit report <任务ID> [markdown|html|json]', '/audit prompts']
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

        if (subcommand === 'skills') {
          const skills = store.listSkills()
          const lines = ['审计 Skill：']
          if (skills.length === 0) lines.push('（暂无，先在控制台导入 SKILL.md / 目录 / ZIP）')
          for (const skill of skills) {
            const callable = skill.enabled && DSH_SKILL_NAME.test(skill.name)
            const refs = Array.isArray(skill.references) ? skill.references.length : 0
            lines.push(`- ${skill.enabled ? '启用' : '禁用'} ${skill.name}${callable ? `，会话中可用 /${skill.name}` : ''}（${skill.category || '未分类'}，${refs} 个参考文件）`)
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
  })
}
