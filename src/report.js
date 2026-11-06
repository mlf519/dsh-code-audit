import { escapeHtml, SEVERITIES } from './util.js'

const SEVERITY_LABELS = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '提示',
}

const SEVERITY_WEIGHTS = { critical: 5, high: 4, medium: 3, low: 2, info: 1 }

const STATUS_LABELS = {
  open: '待确认',
  verified: '已确认',
  ignored: '已忽略',
  false_positive: '误报',
  fixed: '已修复',
}

const TASK_STATUS_LABELS = {
  draft: '草稿',
  scheduled: '已排期',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const RUN_STATUS_LABELS = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const TRIGGER_LABELS = {
  manual: '手动触发',
  schedule: '定时触发',
  tool: 'Agent 工具触发',
}

const COVERAGE_LABELS = {
  running: '审计中',
  completed: '已完成',
  partial: '部分完成',
  pending: '未审计',
}

/** Build an exportable audit report for one task. */
export function buildTaskReport(store, taskId, format = 'markdown', { type = 'standard' } = {}) {
  const task = store.getTask(taskId)
  if (!task) throw new Error('审计任务不存在')
  const normalized = format === 'md' ? 'markdown' : format
  const stamp = new Date().toISOString().slice(0, 10)
  if (type === 'skill') return buildSkillReport(store, task, normalized, stamp)
  const runs = store.listRuns(taskId, 200)
  const findings = store.listFindings({ taskId })
  const coverage = buildCoverage(store, task, findings)
  const meta = buildReportMeta(store, task, runs, findings)
  const baseName = `code-audit-report-${task.id.slice(-6)}-${stamp}`

  if (normalized === 'json') {
    return {
      filename: `${baseName}.json`,
      mime: 'application/json; charset=utf-8',
      content: JSON.stringify(
        { report: meta, task, runs, findings, coverage, generatedAt: meta.generatedAt },
        null,
        2,
      ),
    }
  }
  if (normalized === 'html') {
    return {
      filename: `${baseName}.html`,
      mime: 'text/html; charset=utf-8',
      content: renderHtmlReport(task, runs, findings, coverage, meta),
    }
  }
  return {
    filename: `${baseName}.md`,
    mime: 'text/markdown; charset=utf-8',
    content: renderMarkdownReport(task, runs, findings, coverage, meta),
  }
}

/** Per-type audit coverage so partial runs still export clear empty sections. */
function buildCoverage(store, task, findings) {
  const taskState = task.status === 'running'
    ? 'running'
    : task.status === 'completed'
      ? 'completed'
      : task.status === 'failed' || task.status === 'cancelled'
        ? 'partial'
        : 'pending'
  if (task.audit_mode === 'skill') {
    const skill = task.skill_id ? store.getSkill(task.skill_id) : undefined
    if (!skill) {
      return [{
        id: task.skill_id,
        name: '（审计 Skill 已删除）',
        category: '',
        severity: '',
        findings: 0,
        state: 'pending',
        stateLabel: COVERAGE_LABELS.pending,
        note: '任务引用的审计 Skill 已删除，请编辑任务重新选择',
      }]
    }
    const count = findings.filter(finding => finding.skill_id === skill.id).length
    const state = taskState === 'running' && count > 0 ? 'partial' : taskState
    return [{
      id: skill.id,
      name: skill.name,
      category: skill.category || '',
      severity: '',
      findings: count,
      state,
      stateLabel: COVERAGE_LABELS[state],
      note: state === 'pending'
        ? '该 Skill 尚未审计'
        : count > 0
          ? `已记录 ${count} 个漏洞`
          : taskState === 'completed'
            ? '已完成，未发现问题'
            : '尚在审计或未完成，暂无发现',
    }]
  }
  const prompts = task.prompt_ids.map(id => store.getPrompt(id)).filter(Boolean)
  return prompts.map(prompt => {
    const count = findings.filter(finding => finding.prompt_id === prompt.id).length
    let state = taskState
    if (taskState === 'running' && count > 0) state = 'partial'
    return {
      id: prompt.id,
      name: prompt.name,
      category: prompt.category || '',
      severity: prompt.default_severity,
      findings: count,
      state,
      stateLabel: COVERAGE_LABELS[state],
      note: state === 'pending'
        ? '该类型尚未审计'
        : count > 0
          ? `已记录 ${count} 个漏洞`
          : taskState === 'completed'
            ? '已完成，未发现问题'
            : '尚在审计或未完成，暂无发现',
    }
  })
}

function buildReportMeta(store, task, runs, findings) {
  const generated = new Date()
  const latestRun = runs[0]
  const auditMode = task.audit_mode === 'skill' ? 'skill' : 'prompts'
  const skill = auditMode === 'skill' && task.skill_id ? store.getSkill(task.skill_id) : undefined
  const severityCounts = Object.fromEntries(
    SEVERITIES.map(severity => [severity, findings.filter(finding => finding.severity === severity).length]),
  )
  const statusCounts = Object.fromEntries(
    Object.keys(STATUS_LABELS).map(status => [status, findings.filter(finding => finding.status === status).length]),
  )
  const reportNo = `CA-${generated.getFullYear()}${pad(generated.getMonth() + 1)}${pad(generated.getDate())}-${String(task.id).slice(-6).toUpperCase()}`
  return {
    reportNo,
    generatedAt: fmtDate(generated),
    generatedIso: generated.toISOString(),
    taskName: task.name,
    repoPath: task.repo_path,
    description: task.description || '',
    status: task.status,
    statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
    auditMode,
    skillName: skill?.name ?? '',
    promptCount: auditMode === 'skill' ? 1 : task.prompt_ids.length,
    total: findings.length,
    severityCounts,
    statusCounts,
    latestRun: latestRun
      ? {
          id: latestRun.id,
          statusLabel: RUN_STATUS_LABELS[latestRun.status] ?? latestRun.status,
          triggerLabel: TRIGGER_LABELS[latestRun.trigger] ?? latestRun.trigger,
          startedAt: fmtDate(latestRun.started_at),
          finishedAt: latestRun.finished_at ? fmtDate(latestRun.finished_at) : '—',
          duration: fmtDuration(latestRun.started_at, latestRun.finished_at),
          summary: latestRun.summary || '',
        }
      : null,
    topSeverity: [...SEVERITIES].sort((a, b) => SEVERITY_WEIGHTS[b] - SEVERITY_WEIGHTS[a])
      .find(severity => severityCounts[severity] > 0),
  }
}

function orderedFindings(findings) {
  return [...findings].sort((left, right) => {
    const bySeverity = SEVERITIES.indexOf(left.severity) - SEVERITIES.indexOf(right.severity)
    if (bySeverity !== 0) return bySeverity
    return String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''))
  })
}

function findingNumber(index) {
  return `VULN-${String(index + 1).padStart(3, '0')}`
}

function findingLocation(finding) {
  const start = finding.line_start ?? '-'
  const end = finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ''
  return `${finding.file_path || '未知文件'}:${start}${end}`
}

function severitySummary(meta) {
  return SEVERITIES
    .filter(severity => meta.severityCounts[severity] > 0)
    .map(severity => `${SEVERITY_LABELS[severity]} ${meta.severityCounts[severity]} 个`)
    .join('、')
}

function executiveSummary(meta) {
  const scope = meta.auditMode === 'skill'
    ? `本次审计按 Skill「${meta.skillName || '已删除的 Skill'}」执行`
    : `本次审计覆盖 ${meta.promptCount} 个漏洞类型`
  if (meta.total === 0) {
    return `${scope}，未发现符合条件的安全问题。`
  }
  const parts = [
    `${scope}，共发现 ${meta.total} 个问题`,
    severitySummary(meta),
    `待确认 ${meta.statusCounts.open ?? 0} 个，已确认 ${meta.statusCounts.verified ?? 0} 个`,
  ]
  return `${parts.join('，')}。建议优先处理${meta.topSeverity ? SEVERITY_LABELS[meta.topSeverity] : '高危'}及以上风险。`
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function fmtDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function fmtDuration(start, end) {
  const from = Date.parse(start ?? '')
  const to = end ? Date.parse(end) : Date.now()
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return '—'
  const seconds = Math.round((to - from) / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${pad(seconds % 60)} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function coverageSeverityLabel(item) {
  return item.severity ? SEVERITY_LABELS[item.severity] ?? item.severity : '—'
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function mdBlock(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\n+$/g, '')
}

function htmlText(value) {
  return escapeHtml(value).replaceAll('\n', '<br>')
}

function renderMarkdownReport(task, runs, findings, coverage, meta) {
  const sorted = orderedFindings(findings)
  const lines = []
  lines.push(`# ${task.name} 代码审计报告`)
  lines.push('')
  lines.push(`> 报告编号：${meta.reportNo} ｜ 生成时间：${meta.generatedAt}`)
  lines.push('')
  lines.push('## 一、报告信息')
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('| --- | --- |')
  lines.push(`| 任务名称 | ${escapeCell(task.name)} |`)
  lines.push(`| 审计目录 | \`${escapeCell(task.repo_path)}\` |`)
  lines.push(`| 任务说明 | ${escapeCell(task.description || '—')} |`)
  lines.push(`| 任务状态 | ${escapeCell(meta.statusLabel)} |`)
  lines.push(`| 审计类型 | ${meta.auditMode === 'skill' ? `审计 Skill：${escapeCell(meta.skillName || '已删除')}` : `${meta.promptCount} 个`} |`)
  lines.push(`| 漏洞总数 | ${meta.total} 个 |`)
  lines.push(`| 最近运行 | ${meta.latestRun ? `${escapeCell(meta.latestRun.startedAt)}（${escapeCell(meta.latestRun.statusLabel)}，${escapeCell(meta.latestRun.duration)}）` : '暂无运行记录'} |`)
  if (task.next_run_at) lines.push(`| 下次执行 | ${escapeCell(fmtDate(task.next_run_at))} |`)
  lines.push('')

  lines.push('## 二、执行摘要')
  lines.push('')
  lines.push(executiveSummary(meta))
  lines.push('')
  lines.push('### 风险分布')
  lines.push('')
  lines.push('| 严重级别 | 数量 | 占比 |')
  lines.push('| --- | --- | --- |')
  for (const severity of SEVERITIES) {
    const count = meta.severityCounts[severity]
    const ratio = meta.total ? `${Math.round((count / meta.total) * 100)}%` : '0%'
    lines.push(`| ${SEVERITY_LABELS[severity]} | ${count} | ${ratio} |`)
  }
  lines.push(`| **合计** | **${meta.total}** | **100%** |`)
  lines.push('')
  if (meta.total > 0) {
    lines.push('### 重点漏洞')
    lines.push('')
    for (const [index, finding] of sorted.slice(0, 5).entries()) {
      lines.push(`${index + 1}. **${findingNumber(index)}｜${finding.title}** — ${SEVERITY_LABELS[finding.severity] ?? finding.severity}（${STATUS_LABELS[finding.status] ?? finding.status}），\`${findingLocation(finding)}\``)
    }
    lines.push('')
  }

  lines.push('## 三、审计范围与方法')
  lines.push('')
  lines.push(`- 审计对象：\`${task.repo_path}\``)
  lines.push(meta.auditMode === 'skill'
    ? `- 审计方式：按审计 Skill「${meta.skillName || '已删除的 Skill'}」的规定执行，Agent 以只读方式访问代码目录。`
    : `- 审计方式：按任务启用的 ${meta.promptCount} 个漏洞审计提示词逐类执行，Agent 以只读方式访问代码目录。`)
  lines.push('- 证据要求：每个漏洞均需给出代码位置、成因、触发路径与修复建议；可远程利用的漏洞应附 PoC 请求包。')
  if (meta.latestRun) {
    lines.push(`- 最近一次运行：${meta.latestRun.id}（${meta.latestRun.triggerLabel}，${meta.latestRun.startedAt} 至 ${meta.latestRun.finishedAt}，耗时 ${meta.latestRun.duration}）`)
  }
  lines.push('')

  lines.push('## 四、审计覆盖')
  lines.push('')
  lines.push('> 审计进行中或中断时，报告只包含已完成的发现；未审计的提示词以空章节保留。')
  lines.push('')
  lines.push('| 审计类型 | 默认级别 | 状态 | 发现数 | 说明 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const item of coverage) {
    lines.push(`| ${escapeCell(item.name)} | ${escapeCell(coverageSeverityLabel(item))} | ${escapeCell(item.stateLabel)} | ${item.findings} | ${escapeCell(item.note)} |`)
  }
  if (coverage.length === 0) lines.push('| — | — | — | — | 未配置审计提示词 |')
  lines.push('')

  lines.push('## 五、漏洞详情')
  lines.push('')
  if (sorted.length === 0) {
    lines.push('本次审计未发现符合条件的安全问题。')
    lines.push('')
  }
  let number = 0
  for (const severity of SEVERITIES) {
    const group = sorted.filter(finding => finding.severity === severity)
    if (group.length === 0) continue
    lines.push(`### ${SEVERITY_LABELS[severity]}（${group.length}）`)
    lines.push('')
    for (const finding of group) {
      number += 1
      lines.push(`#### ${findingNumber(number - 1)}｜${finding.title}`)
      lines.push('')
      lines.push('| 项目 | 内容 |')
      lines.push('| --- | --- |')
      lines.push(`| 风险等级 | ${SEVERITY_LABELS[finding.severity] ?? finding.severity} |`)
      lines.push(`| 处理状态 | ${STATUS_LABELS[finding.status] ?? finding.status} |`)
      lines.push(`| 分类 | ${escapeCell(finding.category || '未分类')} |`)
      lines.push(`| 位置 | \`${escapeCell(findingLocation(finding))}\` |`)
      lines.push(`| 发现时间 | ${escapeCell(fmtDate(finding.created_at))} |`)
      if (finding.status_note) lines.push(`| 处理备注 | ${escapeCell(finding.status_note)} |`)
      lines.push('')
      if (finding.description) {
        lines.push('**漏洞描述**')
        lines.push('')
        lines.push(mdBlock(finding.description))
        lines.push('')
      }
      if (finding.evidence) {
        lines.push('**触发路径 / 数据流**')
        lines.push('')
        lines.push(mdBlock(finding.evidence))
        lines.push('')
      }
      if (finding.code_snippet) {
        lines.push('**证据代码**')
        lines.push('')
        lines.push('```')
        lines.push(mdBlock(finding.code_snippet))
        lines.push('```')
        lines.push('')
      }
      lines.push('**PoC 请求包 / 复现示例**')
      lines.push('')
      if (finding.poc) {
        lines.push('```http')
        lines.push(mdBlock(finding.poc))
        lines.push('```')
      } else {
        lines.push('该漏洞未附 PoC 请求包，通常属于需本地条件、依赖内部状态或需人工构造请求的场景。请结合「触发路径」与证据代码进行复现验证。')
      }
      lines.push('')
      if (finding.recommendation) {
        lines.push('**修复建议**')
        lines.push('')
        lines.push(mdBlock(finding.recommendation))
        lines.push('')
      }
    }
  }

  const emptyCoverage = coverage.filter(item => item.findings === 0)
  if (emptyCoverage.length > 0) {
    lines.push('## 六、未发现问题或未完成的类型')
    lines.push('')
    lines.push('| 审计类型 | 状态 | 说明 |')
    lines.push('| --- | --- | --- |')
    for (const item of emptyCoverage) {
      lines.push(`| ${escapeCell(item.name)} | ${escapeCell(item.stateLabel)} | ${escapeCell(item.note)} |`)
    }
    lines.push('')
  }

  lines.push('## 七、运行历史')
  lines.push('')
  lines.push('| 运行 ID | 状态 | 触发方式 | 开始时间 | 结束时间 | 耗时 | 漏洞数 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const run of runs) {
    lines.push(`| ${run.id} | ${RUN_STATUS_LABELS[run.status] ?? run.status} | ${TRIGGER_LABELS[run.trigger] ?? run.trigger} | ${fmtDate(run.started_at)} | ${run.finished_at ? fmtDate(run.finished_at) : '—'} | ${fmtDuration(run.started_at, run.finished_at)} | ${run.findings_count} |`)
  }
  if (runs.length === 0) lines.push('| — | — | — | — | — | — | — |')
  lines.push('')

  if (meta.latestRun?.summary) {
    lines.push('## 八、最近一次运行总结')
    lines.push('')
    lines.push(mdBlock(meta.latestRun.summary))
    lines.push('')
  }

  lines.push('## 九、说明与免责声明')
  lines.push('')
  lines.push('- 本报告由 dsh-code-audit 基于静态代码分析与 Agent 审计会话自动生成，结果可能包含误报或遗漏。')
  lines.push('- 报告中的 PoC 请求包仅用于授权范围内的安全验证，请勿用于未授权系统。')
  lines.push('- 建议在修复后重新执行审计，并人工复核风险等级与修复效果。')
  lines.push('')
  return lines.join('\n')
}

function renderHtmlReport(task, runs, findings, coverage, meta) {
  const sorted = orderedFindings(findings)
  const numberMap = new Map(sorted.map((finding, index) => [finding.id, findingNumber(index)]))

  const severityTiles = SEVERITIES
    .map(severity => `<div class="tile sev-tile ${severity}"><span>${SEVERITY_LABELS[severity]}</span><b>${meta.severityCounts[severity]}</b></div>`)
    .join('')

  const coverageRows = coverage.map(item =>
    `<tr><td>${escapeHtml(item.name)}</td><td>${item.severity ? `<span class="sev ${escapeHtml(item.severity)}">${escapeHtml(SEVERITY_LABELS[item.severity] ?? item.severity)}</span>` : '—'}</td><td>${escapeHtml(item.stateLabel)}</td><td>${item.findings}</td><td>${escapeHtml(item.note)}</td></tr>`,
  ).join('') || '<tr><td colspan="5">未配置审计提示词</td></tr>'

  const runRows = runs.map(run =>
    `<tr><td><span class="mono">${escapeHtml(run.id)}</span></td><td>${escapeHtml(RUN_STATUS_LABELS[run.status] ?? run.status)}</td><td>${escapeHtml(TRIGGER_LABELS[run.trigger] ?? run.trigger)}</td><td>${escapeHtml(fmtDate(run.started_at))}</td><td>${run.finished_at ? escapeHtml(fmtDate(run.finished_at)) : '—'}</td><td>${escapeHtml(fmtDuration(run.started_at, run.finished_at))}</td><td>${run.findings_count}</td></tr>`,
  ).join('') || '<tr><td colspan="7">暂无运行记录</td></tr>'

  const findingCards = sorted.map(finding => {
    const sev = SEVERITIES.includes(finding.severity) ? finding.severity : 'info'
    const id = numberMap.get(finding.id)
    const poc = finding.poc
      ? `<pre class="poc"><code>${escapeHtml(mdBlock(finding.poc))}</code></pre>`
      : '<p class="muted">该漏洞未附 PoC 请求包，通常属于需本地条件、依赖内部状态或需人工构造请求的场景。请结合「触发路径」与证据代码进行复现验证。</p>'
    return `<article class="finding" id="vuln-${id}">
  <header class="finding-head">
    <span class="vuln-id">${id}</span>
    <h3>${escapeHtml(finding.title)}</h3>
    <span class="sev ${sev}">${SEVERITY_LABELS[sev] ?? escapeHtml(sev)}</span>
    <span class="status">${escapeHtml(STATUS_LABELS[finding.status] ?? finding.status)}</span>
  </header>
  <div class="finding-meta">
    <div><span>位置</span><code>${escapeHtml(findingLocation(finding))}</code></div>
    <div><span>分类</span>${escapeHtml(finding.category || '未分类')}</div>
    <div><span>发现时间</span>${escapeHtml(fmtDate(finding.created_at))}</div>
    ${finding.status_note ? `<div><span>处理备注</span>${escapeHtml(finding.status_note)}</div>` : ''}
  </div>
  ${finding.description ? `<h4>漏洞描述</h4><p>${htmlText(finding.description)}</p>` : ''}
  ${finding.evidence ? `<h4>触发路径 / 数据流</h4><p>${htmlText(finding.evidence)}</p>` : ''}
  ${finding.code_snippet ? `<h4>证据代码</h4><pre><code class="code">${escapeHtml(mdBlock(finding.code_snippet))}</code></pre>` : ''}
  <h4>PoC 请求包 / 复现示例</h4>
  ${poc}
  ${finding.recommendation ? `<h4>修复建议</h4><p>${htmlText(finding.recommendation)}</p>` : ''}
</article>`
  })

  const groupedFindings = SEVERITIES.map(severity => {
    const group = sorted.filter(finding => finding.severity === severity)
    if (group.length === 0) return ''
    const cards = group.map(finding => findingCards[sorted.indexOf(finding)]).join('\n')
    return `<div class="sev-group ${severity}"><h3 class="group-title"><span class="sev ${severity}">${SEVERITY_LABELS[severity]}</span>${group.length} 个漏洞</h3>${cards}</div>`
  }).join('\n')

  const emptyCoverage = coverage.filter(item => item.findings === 0)
  const emptyRows = emptyCoverage.map(item =>
    `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.stateLabel)}</td><td>${escapeHtml(item.note)}</td></tr>`,
  ).join('')

  const topFindings = sorted.slice(0, 5).map(finding => {
    const sev = SEVERITIES.includes(finding.severity) ? finding.severity : 'info'
    return `<li><a href="#vuln-${numberMap.get(finding.id)}"><span class="mono">${numberMap.get(finding.id)}</span> ${escapeHtml(finding.title)}</a><span class="sev ${sev}">${SEVERITY_LABELS[sev] ?? escapeHtml(sev)}</span><code>${escapeHtml(findingLocation(finding))}</code></li>`
  }).join('')

  const severityRows = SEVERITIES.map(severity => {
    const count = meta.severityCounts[severity]
    const ratio = meta.total ? Math.round((count / meta.total) * 100) : 0
    return `<tr><td><span class="sev ${severity}">${SEVERITY_LABELS[severity]}</span></td><td>${count}</td><td><div class="bar"><span style="width:${ratio}%"></span></div>${ratio}%</td></tr>`
  }).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(task.name)} 代码审计报告 · ${escapeHtml(meta.reportNo)}</title>
<style>
:root {
  --ink: #1f2328;
  --muted: #5b6573;
  --line: #e3e8ef;
  --soft: #f6f8fb;
  --brand: #1a4fba;
  --critical: #b42318;
  --high: #c2410c;
  --medium: #a16207;
  --low: #1d4ed8;
  --info: #57606a;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: #eef2f7;
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
}
main {
  max-width: 1040px;
  margin: 32px auto;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 18px 60px rgba(15, 23, 42, .12);
  overflow: hidden;
}
.cover {
  padding: 44px 52px 36px;
  color: #fff;
  background:
    radial-gradient(1200px 400px at 90% -10%, rgba(56, 189, 248, .28), transparent 60%),
    linear-gradient(135deg, #0b1b3a 0%, #12326b 55%, #1a4fba 100%);
}
.brand { font-size: 12px; letter-spacing: .18em; text-transform: uppercase; color: rgba(255,255,255,.7); }
.cover h1 { margin: 14px 0 8px; font-size: 34px; line-height: 1.25; letter-spacing: .5px; }
.cover .sub { margin: 0; max-width: 720px; color: rgba(255,255,255,.78); font-size: 14px; }
.cover-meta {
  margin-top: 28px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 28px;
  font-size: 13px;
}
.cover-meta div { display: flex; gap: 12px; align-items: baseline; border-bottom: 1px solid rgba(255,255,255,.14); padding-bottom: 8px; }
.cover-meta span { color: rgba(255,255,255,.62); min-width: 64px; }
.cover-meta b { font-weight: 600; overflow-wrap: anywhere; }
.tiles { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-top: 28px; }
.tile { background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.16); border-radius: 10px; padding: 12px 14px; }
.tile span { display: block; font-size: 12px; color: rgba(255,255,255,.7); }
.tile b { font-size: 26px; line-height: 1.2; }
.tile.total { background: rgba(255,255,255,.18); }
.sev-tile.critical b { color: #ffb4ab; }
.sev-tile.high b { color: #ffc79a; }
.sev-tile.medium b { color: #ffe08a; }
.sev-tile.low b { color: #a8c8ff; }
.sev-tile.info b { color: #d0d5dd; }

.toc {
  display: flex; flex-wrap: wrap; gap: 8px;
  padding: 18px 52px;
  background: var(--soft);
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.toc a { color: var(--brand); text-decoration: none; padding: 4px 10px; border-radius: 999px; background: #fff; border: 1px solid var(--line); }
.toc a:hover { border-color: var(--brand); }

section.body-section { padding: 8px 52px 12px; }
main > section, main > .finding-wrap { padding: 0 52px; }
h2 {
  margin: 40px 0 14px;
  font-size: 20px;
  display: flex; align-items: center; gap: 10px;
}
h2 .num {
  font-size: 12px; font-weight: 600; color: #fff; background: var(--brand);
  border-radius: 6px; padding: 1px 8px; letter-spacing: .08em;
}
h3 { font-size: 16px; margin: 22px 0 8px; }
h4 { margin: 18px 0 6px; font-size: 13px; color: var(--muted); letter-spacing: .02em; }
p { margin: 8px 0; }
.lead { font-size: 15px; background: var(--soft); border-left: 3px solid var(--brand); padding: 12px 16px; border-radius: 0 8px 8px 0; }
.muted { color: var(--muted); }
.mono { font-family: "JetBrains Mono", Consolas, "Courier New", monospace; }
table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13.5px; }
th, td { border-bottom: 1px solid var(--line); padding: 9px 12px; text-align: left; vertical-align: top; }
th { background: var(--soft); font-weight: 600; color: #344054; white-space: nowrap; }
tbody tr:hover { background: #fafcff; }
.bar { display: inline-block; width: 110px; height: 6px; border-radius: 999px; background: var(--line); margin-right: 8px; vertical-align: middle; overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--brand); border-radius: inherit; }

.sev { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.sev.critical { background: #ffebe9; color: var(--critical); }
.sev.high { background: #fff1e5; color: var(--high); }
.sev.medium { background: #fff8db; color: var(--medium); }
.sev.low { background: #e8f4ff; color: var(--low); }
.sev.info { background: #eef1f4; color: var(--info); }
.status { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; background: #f0f3f6; color: var(--muted); }

.top-list { list-style: none; padding: 0; margin: 10px 0; }
.top-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px dashed var(--line); }
.top-list a { color: var(--ink); text-decoration: none; font-weight: 600; }
.top-list a:hover { color: var(--brand); }
.top-list code { color: var(--muted); font-size: 12px; }

.sev-group { margin: 18px 0 8px; }
.group-title { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted); border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.finding {
  border: 1px solid var(--line);
  border-left: 4px solid var(--brand);
  border-radius: 10px;
  padding: 18px 20px;
  margin: 16px 0;
  background: #fff;
  break-inside: avoid;
}
.finding-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.finding-head h3 { margin: 0; flex: 1 1 320px; font-size: 16px; }
.vuln-id { font-family: "JetBrains Mono", Consolas, monospace; font-size: 12px; color: #fff; background: #344054; border-radius: 5px; padding: 1px 7px; }
.finding-meta {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px;
  margin: 12px 0 4px; font-size: 12.5px; color: var(--muted);
}
.finding-meta div { display: flex; gap: 8px; min-width: 0; }
.finding-meta span { color: #98a2b3; min-width: 56px; }
.finding-meta code { overflow-wrap: anywhere; }
code { font-family: "JetBrains Mono", Consolas, "Courier New", monospace; font-size: 12.5px; background: var(--soft); padding: 1px 5px; border-radius: 4px; }
pre {
  margin: 8px 0; padding: 14px 16px; border-radius: 9px; overflow: auto;
  background: #f7f9fc; border: 1px solid var(--line);
  font-size: 12.5px; line-height: 1.6;
}
pre code { background: none; padding: 0; font-size: inherit; }
pre.poc { background: #0f172a; border-color: #0f172a; color: #e2e8f0; }
pre.poc code { color: #e2e8f0; }
pre.poc::before { content: "PoC"; display: block; color: #7dd3fc; font-size: 11px; letter-spacing: .16em; margin-bottom: 6px; }
footer {
  margin-top: 44px; padding: 18px 52px 28px; border-top: 1px solid var(--line);
  color: #98a2b3; font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
}
@media print {
  body { background: #fff; }
  main { margin: 0; max-width: none; border-radius: 0; box-shadow: none; }
  .cover { padding: 32px 24px; }
  .toc { display: none; }
  main > section, main > .finding-wrap, footer { padding-left: 8px; padding-right: 8px; }
  .finding, tr, .tile { break-inside: avoid; }
  a { color: inherit; }
}
@media (max-width: 720px) {
  .cover, .toc, main > section, main > .finding-wrap, footer { padding-left: 20px; padding-right: 20px; }
  .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .cover-meta, .finding-meta { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<main>
  <header class="cover">
    <div class="brand">DeepSeek Harness · Code Audit</div>
    <h1>${escapeHtml(task.name)} 代码审计报告</h1>
    <p class="sub">${escapeHtml(task.description || `针对 ${task.repo_path} 的安全审计结果`)}</p>
    <div class="cover-meta">
      <div><span>报告编号</span><b>${escapeHtml(meta.reportNo)}</b></div>
      <div><span>生成时间</span><b>${escapeHtml(meta.generatedAt)}</b></div>
      <div><span>审计目录</span><b class="mono">${escapeHtml(task.repo_path)}</b></div>
      <div><span>任务状态</span><b>${escapeHtml(meta.statusLabel)}</b></div>
    </div>
    <div class="tiles">
      <div class="tile total"><span>漏洞总数</span><b>${meta.total}</b></div>
      ${severityTiles}
    </div>
  </header>

  <nav class="toc">
    <a href="#summary">执行摘要</a>
    <a href="#scope">审计范围与方法</a>
    <a href="#coverage">审计覆盖</a>
    <a href="#findings">漏洞详情</a>
    <a href="#runs">运行历史</a>
    <a href="#notice">说明与免责声明</a>
  </nav>

  <section id="summary">
    <h2><span class="num">01</span>执行摘要</h2>
    <p class="lead">${escapeHtml(executiveSummary(meta))}</p>
    <table>
      <thead><tr><th>严重级别</th><th>数量</th><th>占比</th></tr></thead>
      <tbody>${severityRows}<tr><td><strong>合计</strong></td><td><strong>${meta.total}</strong></td><td>100%</td></tr></tbody>
    </table>
    ${topFindings ? `<h3>重点漏洞</h3><ul class="top-list">${topFindings}</ul>` : '<p class="muted">本次审计未发现符合条件的安全问题。</p>'}
  </section>

  <section id="scope">
    <h2><span class="num">02</span>审计范围与方法</h2>
    <table>
      <tbody>
        <tr><th>审计目录</th><td><code>${escapeHtml(task.repo_path)}</code></td></tr>
        <tr><th>任务说明</th><td>${escapeHtml(task.description || '—')}</td></tr>
        <tr><th>审计类型</th><td>${meta.auditMode === 'skill' ? `审计 Skill：${escapeHtml(meta.skillName || '已删除')}` : `${meta.promptCount} 个漏洞审计提示词`}</td></tr>
        <tr><th>审计方式</th><td>${meta.auditMode === 'skill' ? `按审计 Skill「${escapeHtml(meta.skillName || '已删除')}」的规定执行，Agent 以只读方式访问代码目录并收集证据` : '按启用的提示词逐类执行，Agent 以只读方式访问代码目录并收集证据'}</td></tr>
        <tr><th>最近运行</th><td>${meta.latestRun ? `${escapeHtml(meta.latestRun.id)} · ${escapeHtml(meta.latestRun.triggerLabel)} · ${escapeHtml(meta.latestRun.startedAt)} 至 ${escapeHtml(meta.latestRun.finishedAt)} · 耗时 ${escapeHtml(meta.latestRun.duration)}` : '暂无运行记录'}</td></tr>
        ${task.next_run_at ? `<tr><th>下次执行</th><td>${escapeHtml(fmtDate(task.next_run_at))}</td></tr>` : ''}
      </tbody>
    </table>
  </section>

  <section id="coverage">
    <h2><span class="num">03</span>审计覆盖</h2>
    <p class="muted">审计进行中或中断时，报告只包含已完成的发现；未审计的提示词以空章节保留。</p>
    <table>
      <thead><tr><th>审计类型</th><th>默认级别</th><th>状态</th><th>发现数</th><th>说明</th></tr></thead>
      <tbody>${coverageRows}</tbody>
    </table>
  </section>

  <section id="findings">
    <h2><span class="num">04</span>漏洞详情</h2>
    ${groupedFindings || '<p class="muted">本次审计未发现符合条件的安全问题。</p>'}
  </section>

  ${emptyCoverage.length > 0 ? `<section>
    <h2><span class="num">05</span>未发现问题或未完成的类型</h2>
    <table><thead><tr><th>审计类型</th><th>状态</th><th>说明</th></tr></thead><tbody>${emptyRows}</tbody></table>
  </section>` : ''}

  <section id="runs">
    <h2><span class="num">06</span>运行历史</h2>
    <table>
      <thead><tr><th>运行 ID</th><th>状态</th><th>触发方式</th><th>开始时间</th><th>结束时间</th><th>耗时</th><th>漏洞数</th></tr></thead>
      <tbody>${runRows}</tbody>
    </table>
  </section>

  ${meta.latestRun?.summary ? `<section>
    <h2><span class="num">07</span>最近一次运行总结</h2>
    <p>${htmlText(meta.latestRun.summary)}</p>
  </section>` : ''}

  <section id="notice">
    <h2><span class="num">08</span>说明与免责声明</h2>
    <ul>
      <li>本报告由 dsh-code-audit 基于静态代码分析与 Agent 审计会话自动生成，结果可能包含误报或遗漏。</li>
      <li>报告中的 PoC 请求包仅用于授权范围内的安全验证，请勿用于未授权系统。</li>
      <li>建议在修复后重新执行审计，并人工复核风险等级与修复效果。</li>
    </ul>
  </section>

  <footer>
    <span>${escapeHtml(task.name)} · ${escapeHtml(meta.reportNo)}</span>
    <span>由 dsh-code-audit 生成 · ${escapeHtml(meta.generatedAt)}</span>
  </footer>
</main>
</body>
</html>`
}

function reportError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}

/** Export the report the agent formatted according to the task's Skill. */
function buildSkillReport(store, task, format, stamp) {
  if (task.audit_mode !== 'skill') throw reportError('该任务不是 Skill 模式，无法导出 Skill 报告')
  const skill = task.skill_id ? store.getSkill(task.skill_id) : undefined
  const run = store.listRuns(task.id, 200).find(item => String(item.skill_report ?? '').trim())
  if (!run) throw reportError('该任务还没有提交 Skill 报告，请先完成一次 Skill 模式审计')
  const markdown = String(run.skill_report ?? '').trim()
  const generated = new Date()
  const baseName = `code-audit-skill-report-${task.id.slice(-6)}-${stamp}`

  if (format === 'json') {
    return {
      filename: `${baseName}.json`,
      mime: 'application/json; charset=utf-8',
      content: JSON.stringify({
        report: {
          type: 'skill',
          taskName: task.name,
          skillName: skill?.name ?? '',
          runId: run.id,
          generatedAt: generated.toISOString(),
        },
        markdown,
      }, null, 2),
    }
  }
  if (format === 'html') {
    return {
      filename: `${baseName}.html`,
      mime: 'text/html; charset=utf-8',
      content: renderSkillHtmlReport(task, skill, run, markdown, generated),
    }
  }
  return {
    filename: `${baseName}.md`,
    mime: 'text/markdown; charset=utf-8',
    content: `${markdown}\n`,
  }
}

function renderSkillHtmlReport(task, skill, run, markdown, generated) {
  const skillName = skill?.name ?? task.name
  const body = renderMarkdownToHtml(markdown)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(task.name)} · ${escapeHtml(skillName)} 审计报告</title>
<style>
:root {
  --ink: #1f2328;
  --muted: #5b6573;
  --line: #e3e8ef;
  --soft: #f6f8fb;
  --brand: #1a4fba;
}
* { box-sizing: border-box; }
body { margin: 0; background: #eef2f7; color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.75; -webkit-font-smoothing: antialiased; }
main { max-width: 980px; margin: 32px auto; background: #fff; border-radius: 14px; box-shadow: 0 18px 60px rgba(15, 23, 42, .12); overflow: hidden; }
.cover { padding: 40px 48px 32px; color: #fff; background: radial-gradient(1200px 400px at 90% -10%, rgba(56, 189, 248, .28), transparent 60%), linear-gradient(135deg, #0b1b3a 0%, #12326b 55%, #1a4fba 100%); }
.brand { font-size: 12px; letter-spacing: .18em; text-transform: uppercase; color: rgba(255,255,255,.7); }
.cover h1 { margin: 14px 0 8px; font-size: 30px; line-height: 1.3; }
.cover .sub { margin: 0; color: rgba(255,255,255,.78); font-size: 14px; }
.cover-meta { margin-top: 22px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 28px; font-size: 13px; }
.cover-meta div { display: flex; gap: 12px; border-bottom: 1px solid rgba(255,255,255,.14); padding-bottom: 7px; }
.cover-meta span { color: rgba(255,255,255,.62); min-width: 64px; }
.cover-meta b { font-weight: 600; overflow-wrap: anywhere; }
.md { padding: 10px 48px 40px; }
.md h1 { font-size: 24px; margin: 30px 0 12px; }
.md h2 { font-size: 19px; margin: 30px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.md h3 { font-size: 16px; margin: 22px 0 8px; }
.md h4 { font-size: 14px; margin: 18px 0 6px; color: var(--muted); }
.md p { margin: 9px 0; }
.md ul, .md ol { margin: 8px 0; padding-left: 24px; }
.md li { margin: 4px 0; }
.md blockquote { margin: 12px 0; padding: 10px 16px; background: var(--soft); border-left: 3px solid var(--brand); border-radius: 0 8px 8px 0; color: #344054; }
.md table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13.5px; }
.md th, .md td { border: 1px solid var(--line); padding: 8px 11px; text-align: left; vertical-align: top; }
.md th { background: var(--soft); }
.md pre { margin: 12px 0; padding: 14px 16px; border-radius: 9px; overflow: auto; background: #0f172a; color: #e2e8f0; font-size: 12.5px; line-height: 1.6; }
.md code { font-family: "JetBrains Mono", Consolas, "Courier New", monospace; font-size: 12.5px; }
.md p code, .md li code, .md td code, .md th code { background: var(--soft); color: var(--ink); padding: 1px 5px; border-radius: 4px; }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
footer { margin-top: 40px; padding: 18px 48px 26px; border-top: 1px solid var(--line); color: #98a2b3; font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
@media print {
  body { background: #fff; }
  main { margin: 0; max-width: none; border-radius: 0; box-shadow: none; }
  .md, footer { padding-left: 8px; padding-right: 8px; }
}
@media (max-width: 720px) {
  .cover, .md, footer { padding-left: 20px; padding-right: 20px; }
  .cover-meta { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<main>
  <header class="cover">
    <div class="brand">DeepSeek Harness · Code Audit · Skill Report</div>
    <h1>${escapeHtml(skillName)}</h1>
    <p class="sub">${escapeHtml(task.name)} · ${escapeHtml(task.repo_path)}</p>
    <div class="cover-meta">
      <div><span>审计任务</span><b>${escapeHtml(task.name)}</b></div>
      <div><span>所属 Skill</span><b>${escapeHtml(skillName)}</b></div>
      <div><span>运行 ID</span><b class="mono">${escapeHtml(run.id)}</b></div>
      <div><span>生成时间</span><b>${escapeHtml(fmtDate(generated.toISOString()))}</b></div>
    </div>
  </header>
  <div class="md">${body}</div>
  <footer>
    <span>${escapeHtml(task.name)} · ${escapeHtml(skillName)}</span>
    <span>由 dsh-code-audit 生成 · ${escapeHtml(fmtDate(generated.toISOString()))}</span>
  </footer>
</main>
</body>
</html>`
}

/** Minimal Markdown renderer for Skill-authored reports (no external deps). */
function renderMarkdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const inline = text => escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  const splitRow = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
  const html = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim()
      const code = []
      index += 1
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      index += 1
      html.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      index += 1
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      html.push('<hr>')
      index += 1
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      index += 1
      continue
    }
    if (line.trim().startsWith('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1])) {
      const header = splitRow(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      html.push(`<table><thead><tr>${header.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      html.push(`<blockquote>${quote.map(text => inline(text)).join('<br>')}</blockquote>`)
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''))
        index += 1
      }
      html.push(`<ul>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''))
        index += 1
      }
      html.push(`<ol>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ol>`)
      continue
    }
    const paragraph = []
    while (index < lines.length) {
      const current = lines[index]
      if (!current.trim() || /^\s*```/.test(current) || /^\s*(#{1,6})\s+/.test(current)
        || /^\s*[-*+]\s+/.test(current) || /^\s*\d+[.)]\s+/.test(current)
        || /^\s*>\s?/.test(current) || /^\s*([-*_])\1{2,}\s*$/.test(current)
        || current.trim().startsWith('|')) break
      paragraph.push(current)
      index += 1
    }
    if (paragraph.length === 0) {
      index += 1
      continue
    }
    html.push(`<p>${paragraph.map(text => inline(text)).join('<br>')}</p>`)
  }
  return html.join('\n')
}
