const API = '/dsh-code-audit/api'

const LABELS = {
  taskStatus: { draft: '草稿', scheduled: '已排期', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' },
  findingStatus: { open: '待确认', verified: '已确认', ignored: '已忽略', false_positive: '误报', fixed: '已修复' },
  severity: { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '提示' },
  trigger: { manual: '手动', schedule: '定时', tool: 'Agent 工具' },
  schedule: { manual: '手动触发', once: '定时一次', cron: 'Cron 周期', interval: '固定间隔' },
  runStatus: { running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' },
}

const state = {
  data: null,
  tab: 'tasks',
  filters: { task: '', status: '', severity: '', q: '' },
  modalOpen: false,
  lastRender: 0,
  models: null,
}

const panel = () => document.getElementById('panel')

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function fmtDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toLocalInput(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function runElapsed(run) {
  const start = Date.parse(run?.started_at ?? '')
  if (Number.isNaN(start)) return ''
  const end = run.finished_at ? Date.parse(run.finished_at) : Date.now()
  if (Number.isNaN(end)) return ''
  return fmtDuration(end - start)
}

/** Approximate scan progress for a task's latest run or a run row. */
function progressHtml(run) {
  if (!run) return '<span class="path">—</span>'
  const progress = run.progress ?? {}
  const running = run.status === 'running'
  const percent = Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(100, Number(progress.percent)))
    : null
  const parts = []
  if (progress.stage) parts.push(progress.stage)
  if (progress.total) parts.push(`类型 ${progress.done ?? 0}/${progress.total}`)
  if (progress.steps) parts.push(`${progress.steps} 步`)
  if (progress.toolCalls) parts.push(`${progress.toolCalls} 次工具调用`)
  if (progress.findings) parts.push(`${progress.findings} 个漏洞`)
  if (running) {
    const elapsed = runElapsed(run)
    if (elapsed) parts.push(`已运行 ${elapsed}`)
    if (progress.prompt) parts.push(progress.prompt)
  }
  const indeterminate = percent === null && running
  const width = percent === null ? (running ? 35 : 0) : percent
  return `<div class="progress ${esc(run.status)}">
    <div class="progress-bar${indeterminate ? ' indeterminate' : ''}"><span style="width:${width}%"></span></div>
    <div class="progress-meta">${esc(parts.join(' · ') || '—')}</div>
    ${progress.note ? `<div class="progress-note" title="${esc(progress.note)}">${esc(progress.note)}</div>` : ''}
  </div>`
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  let payload = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`)
  return payload
}

let toastTimer = null
function toast(message, isError = false) {
  const node = document.getElementById('toast')
  node.textContent = message
  node.className = `toast${isError ? ' error' : ''}`
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3200)
}

function download(url) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = ''
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function badge(value, label, kind = value) {
  return `<span class="badge ${esc(kind)}">${esc(label)}</span>`
}

function taskLabel(task) {
  return `<span>${esc(task.name)}</span>`
}

function openModal(title, bodyHtml, footHtml, onMount) {
  const overlay = document.getElementById('overlay')
  const modal = document.getElementById('modal')
  modal.innerHTML = `
    <div class="modal-head">
      <h2>${esc(title)}</h2>
      <button class="x" type="button" data-close="1">×</button>
    </div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot">${footHtml}</div>`
  overlay.classList.remove('hidden')
  state.modalOpen = true
  modal.querySelector('[data-close]')?.addEventListener('click', closeModal)
  if (onMount) onMount(modal)
}

function closeModal() {
  document.getElementById('overlay').classList.add('hidden')
  document.getElementById('modal').innerHTML = ''
  state.modalOpen = false
}

// Directory browser as a nested dialog so the task form stays visible behind it.
function openDirPicker(startPath, onPick) {
  const overlay = document.createElement('div')
  overlay.className = 'overlay overlay-nested'
  overlay.innerHTML = `
    <div class="modal dir-dialog" role="dialog" aria-modal="true" aria-label="选择代码目录">
      <div class="modal-head">
        <h2>选择代码目录</h2>
        <button class="x" type="button" data-dir-close>×</button>
      </div>
      <div class="modal-body">
        <div class="dir-bar">
          <button class="btn small" type="button" data-dir-root>根目录</button>
          <button class="btn small" type="button" data-dir-up>上一级</button>
          <input class="dir-path" data-dir-path placeholder="输入目录路径后回车">
          <button class="btn small" type="button" data-dir-go>前往</button>
        </div>
        <div class="dir-crumbs" data-dir-crumbs></div>
        <div class="dir-list" data-dir-list></div>
      </div>
      <div class="modal-foot">
        <span class="path" data-dir-current></span>
        <span class="btn-group">
          <button class="btn ghost" type="button" data-dir-close>取消</button>
          <button class="btn primary" type="button" data-dir-pick>选择当前目录</button>
        </span>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const list = overlay.querySelector('[data-dir-list]')
  const pathInput = overlay.querySelector('[data-dir-path]')
  const currentLabel = overlay.querySelector('[data-dir-current]')
  const crumbs = overlay.querySelector('[data-dir-crumbs]')
  const current = { path: '', parent: null }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
  }
  const onKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }
  document.addEventListener('keydown', onKey, true)

  const renderCrumbs = path => {
    crumbs.innerHTML = ''
    if (!path) {
      crumbs.textContent = '请选择盘符或根目录'
      return
    }
    const parts = []
    let acc = ''
    const normalized = path.replaceAll('\\', '/')
    for (const segment of normalized.split('/').filter(Boolean)) {
      if (!acc && /^[A-Za-z]:$/.test(segment)) acc = `${segment}/`
      else acc = acc ? acc.replace(/\/?$/, '/') + segment : `/${segment}`
      parts.push({ name: segment, path: acc.replace(/\/$/, '') || '/' })
    }
    if (parts.length === 0) {
      crumbs.textContent = '/'
      return
    }
    parts.forEach((part, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dir-crumb'
      button.textContent = part.name
      button.addEventListener('click', () => loadDirs(part.path))
      crumbs.appendChild(button)
      if (index < parts.length - 1) {
        const separator = document.createElement('span')
        separator.className = 'dir-crumb-sep'
        separator.textContent = '/'
        crumbs.appendChild(separator)
      }
    })
  }

  const loadDirs = async path => {
    list.innerHTML = '<div class="dir-empty">加载中…</div>'
    try {
      const payload = await api(`/fs/dirs?path=${encodeURIComponent(path)}`)
      current.path = payload.path
      current.parent = payload.parent
      pathInput.value = payload.path
      currentLabel.textContent = payload.path || '未选择目录'
      renderCrumbs(payload.path)
      list.innerHTML = payload.dirs.length === 0
        ? '<div class="dir-empty">该目录下没有子目录</div>'
        : payload.dirs.map(dir => `<button class="dir-item" type="button" data-dir="${esc(dir.path)}" title="${esc(dir.path)}"><span class="dir-name">${esc(dir.name)}</span><span class="dir-full">${esc(dir.path)}</span></button>`).join('')
    } catch (error) {
      current.path = ''
      current.parent = null
      currentLabel.textContent = '未选择目录'
      renderCrumbs('')
      list.innerHTML = `<div class="dir-empty">${esc(error.message)}</div>`
      if (path) {
        toast('无法访问该目录，已返回根目录', true)
        loadDirs('')
      }
    }
  }

  overlay.addEventListener('click', event => {
    if (event.target === overlay) close()
  })
  overlay.querySelectorAll('[data-dir-close]').forEach(button => button.addEventListener('click', close))
  overlay.querySelector('[data-dir-root]').addEventListener('click', () => loadDirs(''))
  overlay.querySelector('[data-dir-up]').addEventListener('click', () => {
    if (current.parent) loadDirs(current.parent)
    else toast('已经是根目录', true)
  })
  overlay.querySelector('[data-dir-go]').addEventListener('click', () => loadDirs(pathInput.value.trim()))
  pathInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      loadDirs(pathInput.value.trim())
    }
  })
  list.addEventListener('click', event => {
    const item = event.target.closest('[data-dir]')
    if (item) loadDirs(item.dataset.dir)
  })
  overlay.querySelector('[data-dir-pick]').addEventListener('click', () => {
    const chosen = current.path || pathInput.value.trim()
    if (!chosen) return toast('请先选择目录', true)
    onPick(chosen)
    close()
  })

  loadDirs(startPath)
}

async function load({ silent = false } = {}) {
  try {
    const scroll = window.scrollY
    state.data = await api('/state')
    renderAll()
    if (silent) window.scrollTo(0, scroll)
    state.lastRender = Date.now()
  } catch (error) {
    if (!silent) toast(error.message, true)
  }
}

function renderAll() {
  if (!state.data) return
  renderStats()
  renderCounts()
  renderPanel()
  document.getElementById('data-dir').textContent = `数据目录：${state.data.dataDir}`
}

function renderStats() {
  const stats = state.data.stats
  const cards = [
    { label: '审计任务', value: stats.tasks, hint: `${stats.scheduled} 个已排期` },
    { label: '运行中', value: stats.running, hint: '并发审计会话' },
    { label: '待确认漏洞', value: stats.openFindings, hint: '需要人工复核' },
    { label: '已确认漏洞', value: stats.verifiedFindings, hint: '验证通过的风险' },
    { label: '已忽略/误报', value: stats.ignoredFindings, hint: '不再跟踪' },
  ]
  document.getElementById('stats').innerHTML = cards
    .map(card => `<div class="stat"><div class="label">${card.label}</div><div class="value">${card.value}</div><div class="hint">${card.hint}</div></div>`)
    .join('')
}

function renderCounts() {
  document.getElementById('count-tasks').textContent = state.data.tasks.length
  document.getElementById('count-findings').textContent = state.data.findings.length
  document.getElementById('count-prompts').textContent = state.data.prompts.length
  document.getElementById('count-runs').textContent = state.data.runs.length
}

function renderPanel() {
  if (!state.data) return
  const render = {
    tasks: renderTasks,
    findings: renderFindings,
    prompts: renderPrompts,
    runs: renderRuns,
    settings: renderSettings,
  }[state.tab]
  panel().innerHTML = render()
  bindPanelExtras()
}

function renderTasks() {
  const tasks = state.data.tasks
  const rows = tasks.map(task => {
    const running = task.status === 'running'
    const promptNames = task.prompt_names.length
      ? task.prompt_names.map(name => `<span class="badge info">${esc(name)}</span>`).join(' ')
      : '<span class="path">未选择提示词</span>'
    const schedule = task.schedule_type === 'manual'
      ? `<span class="badge manual">手动</span>`
      : `<span class="badge ${task.schedule_type}">${LABELS.schedule[task.schedule_type] ?? task.schedule_type}</span>${task.next_run_at ? `<small class="path">下次：${esc(fmtDate(task.next_run_at))}</small>` : ''}`
    return `<tr>
      <td class="title-cell">${taskLabel(task)}<small>${esc(task.repo_path)}</small></td>
      <td>${promptNames}</td>
      <td class="nowrap">${schedule}</td>
      <td>${badge(task.status, LABELS.taskStatus[task.status] ?? task.status)}${task.enabled ? '' : ' <span class="path">已暂停</span>'}</td>
      <td>${progressHtml(task.latest_run)}</td>
      <td class="nowrap">${task.finding_stats.total} 个 / 待确认 ${task.finding_stats.open}</td>
      <td class="nowrap">${esc(fmtDate(task.last_run_at))}</td>
      <td class="nowrap"><div class="btn-group">
        ${running
          ? `<button class="btn small danger" data-action="cancel-task" data-id="${task.id}">取消</button>`
          : `<button class="btn small primary" data-action="run-task" data-id="${task.id}">运行</button>`}
        <button class="btn small" data-action="edit-task" data-id="${task.id}">编辑</button>
        <button class="btn small" data-action="report-task" data-id="${task.id}">导出报告</button>
        <button class="btn small" data-action="toggle-task" data-id="${task.id}" data-enabled="${task.enabled ? '1' : '0'}">${task.enabled ? '暂停' : '启用'}</button>
        <button class="btn small danger" data-action="delete-task" data-id="${task.id}">删除</button>
      </div></td>
    </tr>`
  }).join('')

  return `
    <div class="panel-head">
      <div><h2>审计任务</h2><div class="sub">任务会按选中的漏洞提示词创建独立审计会话，未选择的漏洞类型不会被审计。</div></div>
      <div class="panel-actions">
        <button class="btn" data-action="export-task-report">导出报告</button>
        <button class="btn primary" data-action="new-task">新建任务</button>
      </div>
    </div>
    ${tasks.length === 0
      ? `<div class="empty"><strong>还没有审计任务</strong>新建任务，选择代码目录与漏洞提示词后即可开始审计。<br><br><button class="btn primary" data-action="new-task">新建任务</button></div>`
      : `<div class="table-wrap"><table><thead><tr><th>任务</th><th>审计提示词</th><th>调度</th><th>状态</th><th>进度</th><th>漏洞</th><th>最近运行</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`}`
}

function renderFindings() {
  const filters = state.filters
  const tasks = state.data.tasks
  let findings = state.data.findings
  if (filters.task) findings = findings.filter(finding => finding.task_id === filters.task)
  if (filters.status) findings = findings.filter(finding => finding.status === filters.status)
  if (filters.severity) findings = findings.filter(finding => finding.severity === filters.severity)
  if (filters.q) {
    const query = filters.q.toLowerCase()
    findings = findings.filter(finding =>
      `${finding.title} ${finding.file_path} ${finding.category} ${finding.description}`.toLowerCase().includes(query),
    )
  }

  const rows = findings.map(finding => `<tr>
    <td>${badge(finding.severity, LABELS.severity[finding.severity] ?? finding.severity)}</td>
    <td class="title-cell">${esc(finding.title)}<small>${esc(finding.task_name)} · ${esc(finding.category || '未分类')}${finding.prompt_name ? ` · ${esc(finding.prompt_name)}` : ''}</small></td>
    <td class="mono">${esc(finding.file_path || '—')}${finding.line_start ? `:${finding.line_start}${finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ''}` : ''}</td>
    <td>${badge(finding.status, LABELS.findingStatus[finding.status] ?? finding.status)}</td>
    <td class="nowrap">${esc(fmtDate(finding.updated_at))}</td>
    <td class="nowrap"><div class="btn-group">
      <button class="btn small" data-action="finding-detail" data-id="${finding.id}">详情</button>
      ${finding.status === 'open' ? `<button class="btn small primary" data-action="verify-finding" data-id="${finding.id}">验证</button><button class="btn small" data-action="ignore-finding" data-id="${finding.id}">忽略</button>` : ''}
      <button class="btn small danger" data-action="delete-finding" data-id="${finding.id}">删除</button>
    </div></td>
  </tr>`).join('')

  const taskOptions = tasks.map(task => `<option value="${task.id}" ${filters.task === task.id ? 'selected' : ''}>${esc(task.name)}</option>`).join('')
  const statusOptions = Object.entries(LABELS.findingStatus).map(([value, label]) => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${label}</option>`).join('')
  const severityOptions = Object.entries(LABELS.severity).map(([value, label]) => `<option value="${value}" ${filters.severity === value ? 'selected' : ''}>${label}</option>`).join('')

  return `
    <div class="panel-head">
      <div><h2>漏洞管理</h2><div class="sub">验证、忽略或删除审计发现的漏洞。忽略与误报不会计入待确认风险。</div></div>
    </div>
    <div class="filters">
      <select data-filter="task"><option value="">全部任务</option>${taskOptions}</select>
      <select data-filter="status"><option value="">全部状态</option>${statusOptions}</select>
      <select data-filter="severity"><option value="">全部级别</option>${severityOptions}</select>
      <input type="search" data-filter="q" placeholder="搜索标题、文件、分类…" value="${esc(filters.q)}">
      <span class="path">共 ${findings.length} 条</span>
    </div>
    ${findings.length === 0
      ? `<div class="empty"><strong>没有匹配的漏洞</strong>运行审计任务后，Agent 上报的漏洞会出现在这里。</div>`
      : `<div class="table-wrap"><table><thead><tr><th>级别</th><th>漏洞</th><th>位置</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`}`
}

function renderPrompts() {
  const cards = state.data.prompts.map(prompt => `<div class="prompt-card">
    <header>
      <h3>${esc(prompt.name)}</h3>
      <div>${badge('info', prompt.enabled ? '启用' : '禁用', prompt.enabled ? 'verified' : 'ignored')}</div>
    </header>
    <div class="meta">
      ${prompt.builtin ? '<span>内置</span>' : '<span>自定义</span>'}
      <span>分类：${esc(prompt.category || '未分类')}</span>
      <span>默认：${esc(LABELS.severity[prompt.default_severity] ?? prompt.default_severity)}</span>
    </div>
    <div class="preview">${esc(String(prompt.content ?? '').slice(0, 260))}</div>
    <footer>
      <button class="btn small" data-action="edit-prompt" data-id="${prompt.id}">编辑</button>
      <button class="btn small" data-action="toggle-prompt" data-id="${prompt.id}" data-enabled="${prompt.enabled ? '1' : '0'}">${prompt.enabled ? '禁用' : '启用'}</button>
      <button class="btn small danger" data-action="delete-prompt" data-id="${prompt.id}">删除</button>
    </footer>
  </div>`).join('')

  return `
    <div class="panel-head">
      <div><h2>漏洞审计提示词</h2><div class="sub">提示词决定审计范围与判定标准。新建任务时只审计被选中的提示词。</div></div>
      <div class="panel-actions">
        <button class="btn primary" data-action="new-prompt">新建提示词</button>
        <button class="btn" data-action="import-prompts">导入 YAML</button>
        <button class="btn" data-action="export-prompts">导出 YAML</button>
      </div>
    </div>
    <div class="panel-body"><div class="prompt-grid">${cards || '<div class="empty"><strong>暂无提示词</strong>新建或导入提示词后即可创建审计任务。</div>'}</div></div>`
}

function renderRuns() {
  const rows = state.data.runs.map(run => `<tr>
    <td class="mono">${esc(run.id)}<small class="path">${esc(run.task_name)}</small></td>
    <td>${badge(run.status, LABELS.runStatus[run.status] ?? run.status)}</td>
    <td>${progressHtml(run)}</td>
    <td>${esc(LABELS.trigger[run.trigger] ?? run.trigger)}</td>
    <td class="nowrap">${esc(fmtDate(run.started_at))}</td>
    <td class="nowrap">${esc(fmtDate(run.finished_at))}</td>
    <td class="nowrap">${run.findings_count}</td>
    <td class="title-cell"><small>${esc((run.summary || run.error || '—').slice(0, 150))}</small></td>
    <td class="nowrap"><div class="btn-group">
      <button class="btn small" data-action="trajectory-run" data-id="${run.id}">轨迹 JSONL</button>
      ${run.status === 'running'
        ? `<button class="btn small danger" data-action="cancel-run" data-id="${run.id}">取消</button>`
        : `<button class="btn small danger" data-action="delete-run" data-id="${run.id}">删除</button>`}
    </div></td>
  </tr>`).join('')

  return `
    <div class="panel-head">
      <div><h2>运行记录</h2><div class="sub">每次审计都会创建独立会话，并记录原生 trajectory JSONL 运行轨迹。</div></div>
    </div>
    ${state.data.runs.length === 0
      ? '<div class="empty"><strong>暂无运行记录</strong>启动任务后这里会显示每次审计的状态、耗时与发现数量。</div>'
      : `<div class="table-wrap"><table><thead><tr><th>运行</th><th>状态</th><th>进度</th><th>触发</th><th>开始</th><th>结束</th><th>漏洞</th><th>结论</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`}`
}

function renderSettings() {
  const settings = state.data.settings
  return `
    <div class="panel-head"><div><h2>设置</h2><div class="sub">运行并发、超时与默认模型。修改会立即生效。</div></div></div>
    <div class="panel-body">
      <div class="settings-card">
        <h3>运行设置</h3>
        <div class="hint">并发数限制同时运行的审计会话；超时设为 0 表示不限制。</div>
        <form id="settings-form" class="form-grid">
          <div class="field"><label>最大并发审计数</label><input type="number" min="1" step="1" name="maxConcurrentRuns" value="${esc(settings.maxConcurrentRuns ?? 1)}"></div>
          <div class="field"><label>单次审计超时（分钟）</label><input type="number" min="0" step="1" name="runTimeoutMinutes" value="${esc(settings.runTimeoutMinutes ?? 60)}"></div>
          <div class="field"><label>默认模型服务商（可选）</label><input name="defaultProvider" placeholder="例如 deepseek" value="${esc(settings.defaultProvider ?? '')}"><div class="hint">留空使用 DSH 默认模型。</div></div>
          <div class="field"><label>默认模型（可选）</label><input name="defaultModel" placeholder="例如 deepseek-chat" value="${esc(settings.defaultModel ?? '')}"></div>
          <div class="full"><button class="btn primary" type="submit">保存设置</button></div>
        </form>
      </div>
      <div class="settings-card">
        <h3>存储</h3>
        <div class="hint">插件独立 SQLite 为主存储，审计轨迹以 DSH 原生 JSONL 保存。</div>
        <div class="info-row"><span>数据目录</span><code>${esc(state.data.dataDir)}</code></div>
        <div class="info-row"><span>SQLite</span><code>${esc(state.data.dataDir)}/code-audit.db</code></div>
        <div class="info-row"><span>运行轨迹</span><code>${esc(state.data.dataDir)}/trajectories/*.jsonl</code></div>
        <div class="info-row"><span>导出报告</span><code>${esc(state.data.dataDir)}/reports/</code></div>
      </div>
      <div class="settings-card">
        <h3>使用说明</h3>
        <div class="hint">控制台只在本机 DSH 服务内提供，无额外认证，请勿将端口暴露到公网。</div>
        <div class="info-row"><span>控制台地址</span><code>/dsh-code-audit/</code></div>
        <div class="info-row"><span>斜杠命令</span><code>/audit list | run &lt;任务ID&gt; | report &lt;任务ID&gt;</code></div>
        <div class="info-row"><span>Agent 工具</span><code>code_audit_*</code></div>
      </div>
    </div>`
}

function bindPanelExtras() {
  if (state.tab === 'findings') {
    panel().querySelectorAll('[data-filter]').forEach(node => {
      node.addEventListener(node.tagName === 'SELECT' ? 'change' : 'input', event => {
        state.filters[event.target.dataset.filter] = event.target.value
        if (event.target.dataset.filter === 'q') state.keepFocus = 'q'
        renderPanel()
      })
    })
    if (state.keepFocus === 'q') {
      const input = panel().querySelector('[data-filter="q"]')
      if (input) {
        const position = input.value.length
        input.focus()
        input.setSelectionRange(position, position)
      }
      state.keepFocus = ''
    }
  }
  if (state.tab === 'settings') {
    const form = document.getElementById('settings-form')
    form?.addEventListener('submit', async event => {
      event.preventDefault()
      const data = new FormData(form)
      try {
        await api('/settings', {
          method: 'PUT',
          body: {
            maxConcurrentRuns: Number(data.get('maxConcurrentRuns')),
            runTimeoutMinutes: Number(data.get('runTimeoutMinutes')),
            defaultProvider: String(data.get('defaultProvider') ?? ''),
            defaultModel: String(data.get('defaultModel') ?? ''),
          },
        })
        toast('设置已保存')
        await load({ silent: true })
      } catch (error) {
        toast(error.message, true)
      }
    })
  }
}

// ---------------------------------------------------------------- task modal

async function ensureModels() {
  try {
    const payload = await api('/models')
    state.models = Array.isArray(payload.models) ? payload.models : []
  } catch {
    state.models = []
  }
  return state.models
}

function modelFieldHtml(models, task) {
  const usable = models.filter(model => model.id)
  const provider = task?.provider ?? ''
  const selectedModel = task?.model ?? ''
  if (usable.length === 0) {
    return `<div class="field"><label>模型服务商（可选）</label><input name="provider" value="${esc(provider)}" placeholder="留空使用全局默认"><div class="hint">未获取到客户端模型列表，可手动填写。</div></div>
      <div class="field"><label>模型（可选）</label><input name="model" value="${esc(selectedModel)}" placeholder="留空使用全局默认"></div>`
  }
  const providers = new Map()
  for (const model of usable) if (!providers.has(model.provider)) providers.set(model.provider, model.providerName || model.provider)
  const providerOptions = [...providers.entries()]
    .map(([id, name]) => `<option value="${esc(id)}" ${provider === id ? 'selected' : ''}>${esc(name)}</option>`)
    .join('')
  const currentProvider = provider && !providers.has(provider)
    ? `<option value="${esc(provider)}" selected>${esc(provider)}（当前配置）</option>`
    : ''
  return `<div class="field"><label>模型服务商</label><select name="provider" id="task-provider"><option value="">使用全局默认</option>${currentProvider}${providerOptions}</select></div>
    <div class="field"><label>模型</label><select name="model" id="task-model">${modelOptionsHtml(usable, provider, selectedModel)}</select><div class="hint">列表来自客户端已配置的模型，留空使用全局默认。</div></div>`
}

function modelOptionsHtml(models, provider, selected) {
  const list = provider ? models.filter(model => model.provider === provider) : models
  const seen = new Set()
  const options = list
    .filter(model => model.id && !seen.has(`${model.provider}/${model.id}`) && seen.add(`${model.provider}/${model.id}`))
    .map(model => `<option value="${esc(model.id)}" ${model.id === selected ? 'selected' : ''}>${esc(model.name)}${provider ? '' : ` · ${esc(model.providerName)}`}</option>`)
  if (selected && !list.some(model => model.id === selected)) {
    options.unshift(`<option value="${esc(selected)}" selected>${esc(selected)}（当前配置）</option>`)
  }
  return `<option value="">使用全局默认</option>${options.join('')}`
}

async function openTaskModal(task) {
  const prompts = state.data.prompts
  const selected = new Set(task?.prompt_ids ?? [])
  const scheduleType = task?.schedule_type ?? 'manual'
  const promptList = prompts.length === 0
    ? '<div class="path">暂无提示词，请先在「审计提示词」中创建。</div>'
    : prompts.map(prompt => `<label class="prompt-item ${selected.has(prompt.id) ? 'selected' : ''}" data-prompt-id="${prompt.id}">
        <input type="checkbox" value="${prompt.id}" ${selected.has(prompt.id) ? 'checked' : ''}>
        <span><span class="name">${esc(prompt.name)}</span><br><span class="meta">${esc(prompt.category || '未分类')} · ${esc(LABELS.severity[prompt.default_severity] ?? prompt.default_severity)}${prompt.enabled ? '' : ' · 已禁用，不会参与审计'}</span></span>
      </label>`).join('')

  const models = await ensureModels()
  const repoPath = task?.repo_path ?? ''

  const body = `
    <form id="task-form" class="form-grid">
      <div class="field"><label>任务名称 *</label><input name="name" required maxlength="120" value="${esc(task?.name ?? '')}" placeholder="例如：支付模块安全审计"></div>
      <div class="field"><label>代码目录 *</label>
        <div class="input-row">
          <input name="repo_path" required value="${esc(repoPath)}" placeholder="D:\\projects\\your-app">
          <button class="btn" type="button" data-dir-toggle>选择目录</button>
        </div>
        <div class="hint">本地绝对路径，Agent 将以该目录作为工作目录只读审计。</div>
      </div>
      <div class="field full"><label>任务说明</label><textarea name="description" rows="3" placeholder="关注的业务模块、已知风险点、审计边界…">${esc(task?.description ?? '')}</textarea></div>
      <div class="field full"><label>漏洞审计提示词（只审计勾选的类型）</label><div class="prompt-list">${promptList}</div></div>
      <div class="field"><label>调度方式</label><select name="schedule_type">
        ${Object.entries(LABELS.schedule).map(([value, label]) => `<option value="${value}" ${scheduleType === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select></div>
      <div class="field" id="field-once" ${scheduleType === 'once' ? '' : 'hidden'}><label>执行时间</label><input type="datetime-local" name="schedule_at" value="${esc(toLocalInput(task?.schedule_at))}"></div>
      <div class="field" id="field-cron" ${scheduleType === 'cron' ? '' : 'hidden'}><label>Cron 表达式</label><input name="schedule_cron" value="${esc(task?.schedule_cron ?? '')}" placeholder="0 2 * * *"><div class="hint">5 字段：分 时 日 月 周。</div></div>
      <div class="field" id="field-interval" ${scheduleType === 'interval' ? '' : 'hidden'}><label>间隔分钟数</label><input type="number" min="1" step="1" name="interval_minutes" value="${esc(task?.interval_minutes ?? 60)}"></div>
      ${modelFieldHtml(models, task)}
      <div class="field full"><label class="checkbox-line"><input type="checkbox" name="enabled" ${task?.enabled === false ? '' : 'checked'}> 启用任务（暂停后不会按计划执行）</label></div>
    </form>`
  const foot = `<button class="btn ghost" data-cancel="1" type="button">取消</button><button class="btn primary" type="submit" form="task-form">${task ? '保存修改' : '创建任务'}</button>`

  openModal(task ? '编辑审计任务' : '新建审计任务', body, foot, modal => {
    const form = modal.querySelector('#task-form')
    const select = form.querySelector('[name="schedule_type"]')
    const toggle = () => {
      for (const type of ['once', 'cron', 'interval']) {
        modal.querySelector(`#field-${type}`).hidden = select.value !== type
      }
    }
    select.addEventListener('change', toggle)
    modal.querySelectorAll('.prompt-item').forEach(item => {
      item.addEventListener('click', event => {
        if (event.target.tagName !== 'INPUT') event.preventDefault()
        const input = item.querySelector('input')
        if (event.target.tagName !== 'INPUT') input.checked = !input.checked
        item.classList.toggle('selected', input.checked)
      })
    })

    const repoInput = form.querySelector('[name="repo_path"]')
    const providerSelect = form.querySelector('#task-provider')
    const modelSelect = form.querySelector('#task-model')
    providerSelect?.addEventListener('change', () => {
      const previous = modelSelect.value
      const next = modelOptionsHtml(models.filter(model => model.id), providerSelect.value, previous)
      modelSelect.innerHTML = next
      if (![...modelSelect.options].some(option => option.value === previous)) modelSelect.value = ''
    })

    form.querySelector('[data-dir-toggle]').addEventListener('click', () => {
      openDirPicker(repoInput.value.trim(), path => {
        repoInput.value = path
      })
    })

    modal.querySelector('[data-cancel]')?.addEventListener('click', closeModal)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      const data = new FormData(form)
      const scheduleType = data.get('schedule_type')
      const promptIds = [...form.querySelectorAll('.prompt-item input:checked')].map(input => input.value)
      const payload = {
        name: String(data.get('name') ?? '').trim(),
        repo_path: String(data.get('repo_path') ?? '').trim(),
        description: String(data.get('description') ?? ''),
        prompt_ids: promptIds,
        schedule_type: scheduleType,
        enabled: data.get('enabled') === 'on',
        provider: String(data.get('provider') ?? ''),
        model: String(data.get('model') ?? ''),
      }
      if (scheduleType === 'once') {
        const value = String(data.get('schedule_at') ?? '')
        if (!value) return toast('请选择执行时间', true)
        payload.schedule_at = new Date(value).toISOString()
      }
      if (scheduleType === 'cron') payload.schedule_cron = String(data.get('schedule_cron') ?? '').trim()
      if (scheduleType === 'interval') payload.interval_minutes = Number(data.get('interval_minutes'))
      try {
        if (task) await api(`/tasks/${task.id}`, { method: 'PUT', body: payload })
        else await api('/tasks', { method: 'POST', body: payload })
        closeModal()
        toast(task ? '任务已更新' : '任务已创建')
        await load({ silent: true })
      } catch (error) {
        toast(error.message, true)
      }
    })
  })
}

function openReportModal(task) {
  const body = `<p class="prose">选择导出格式。任务审计到一半也可导出：报告包含当前已发现的漏洞，尚未审计的提示词以空章节保留。</p>`
  const foot = `
    <button class="btn" data-format="markdown" type="button">Markdown</button>
    <button class="btn" data-format="html" type="button">HTML</button>
    <button class="btn" data-format="json" type="button">JSON</button>
    <button class="btn ghost" data-cancel="1" type="button">关闭</button>`
  openModal(`导出报告 · ${task.name}`, body, foot, modal => {
    modal.querySelector('[data-cancel]')?.addEventListener('click', closeModal)
    modal.querySelectorAll('[data-format]').forEach(button => {
      button.addEventListener('click', () => {
        download(`${API}/tasks/${task.id}/report?format=${button.dataset.format}`)
        toast(`已开始导出 ${button.dataset.format}`)
      })
    })
  })
}

// ------------------------------------------------------------ finding modal

function openFindingModal(finding) {
  const location = `${finding.file_path || '—'}${finding.line_start ? `:${finding.line_start}${finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ''}` : ''}`
  const body = `
    <div class="detail-grid">
      <dt>严重级别</dt><dd>${badge(finding.severity, LABELS.severity[finding.severity] ?? finding.severity)}</dd>
      <dt>当前状态</dt><dd>${badge(finding.status, LABELS.findingStatus[finding.status] ?? finding.status)}</dd>
      <dt>所属任务</dt><dd>${esc(finding.task_name)}</dd>
      <dt>分类</dt><dd>${esc(finding.category || '未分类')}${finding.prompt_name ? ` · ${esc(finding.prompt_name)}` : ''}</dd>
      <dt>位置</dt><dd class="mono">${esc(location)}</dd>
      <dt>发现时间</dt><dd>${esc(fmtDate(finding.created_at))}</dd>
      <dt>更新时间</dt><dd>${esc(fmtDate(finding.updated_at))}</dd>
    </div>
    ${finding.description ? `<div class="section-title">漏洞描述</div><div class="prose">${esc(finding.description)}</div>` : ''}
    ${finding.evidence ? `<div class="section-title">触发路径 / 数据流</div><div class="prose">${esc(finding.evidence)}</div>` : ''}
    ${finding.code_snippet ? `<div class="section-title">证据代码</div><div class="snippet">${esc(finding.code_snippet)}</div>` : ''}
    ${finding.poc ? `<div class="section-title">PoC 请求包 / 复现示例</div><pre class="poc">${esc(finding.poc)}</pre>` : ''}
    ${finding.recommendation ? `<div class="section-title">修复建议</div><div class="prose">${esc(finding.recommendation)}</div>` : ''}
    <div class="field" style="margin-top:18px"><label>处理备注</label><input id="finding-note" value="${esc(finding.status_note ?? '')}" placeholder="例如：已验证可利用 / 业务已加白名单"></div>`
  const foot = `
    <button class="btn ghost" data-cancel="1" type="button">关闭</button>
    <button class="btn" data-status="open" type="button">重新打开</button>
    <button class="btn" data-status="false_positive" type="button">标记误报</button>
    <button class="btn" data-status="ignored" type="button">忽略</button>
    <button class="btn primary" data-status="verified" type="button">验证通过</button>`
  openModal(finding.title, body, foot, modal => {
    modal.querySelector('[data-cancel]')?.addEventListener('click', closeModal)
    modal.querySelectorAll('[data-status]').forEach(button => {
      button.addEventListener('click', async () => {
        try {
          await api(`/findings/${finding.id}`, {
            method: 'PATCH',
            body: {
              status: button.dataset.status,
              status_note: String(modal.querySelector('#finding-note')?.value ?? ''),
            },
          })
          closeModal()
          toast(`已标记为「${LABELS.findingStatus[button.dataset.status]}」`)
          await load({ silent: true })
        } catch (error) {
          toast(error.message, true)
        }
      })
    })
  })
}

// ------------------------------------------------------------- prompt modal

function openPromptModal(prompt) {
  const body = `
    <form id="prompt-form" class="form-grid">
      <div class="field"><label>名称 *</label><input name="name" required maxlength="120" value="${esc(prompt?.name ?? '')}" placeholder="例如：SQL 注入"></div>
      <div class="field"><label>分类</label><input name="category" value="${esc(prompt?.category ?? '')}" placeholder="例如：注入"></div>
      <div class="field"><label>默认严重级别</label><select name="default_severity">
        ${Object.entries(LABELS.severity).map(([value, label]) => `<option value="${value}" ${(prompt?.default_severity ?? 'medium') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select></div>
      <div class="field"><label class="checkbox-line"><input type="checkbox" name="enabled" ${prompt?.enabled === false ? '' : 'checked'}> 启用</label></div>
      <div class="field full"><label>审计提示词内容</label><textarea name="content" rows="14" placeholder="审计目标、检查清单、判定标准、误报排除、严重级别建议…">${esc(prompt?.content ?? '')}</textarea><div class="hint">这段内容会原样注入审计会话，请明确审计范围与判定标准。</div></div>
    </form>`
  const foot = `
    ${prompt ? '<button class="btn danger" data-delete="1" type="button">删除</button>' : ''}
    <button class="btn ghost" data-cancel="1" type="button">取消</button>
    <button class="btn primary" type="submit" form="prompt-form">${prompt ? '保存' : '创建'}</button>`
  openModal(prompt ? '编辑审计提示词' : '新建审计提示词', body, foot, modal => {
    modal.querySelector('[data-cancel]')?.addEventListener('click', closeModal)
    modal.querySelector('[data-delete]')?.addEventListener('click', async () => {
      const message = prompt.builtin
        ? `确定删除内置提示词「${prompt.name}」？插件重启后内置模板会重新创建。`
        : `确定删除提示词「${prompt.name}」？`
      if (!confirm(message)) return
      try {
        await api(`/prompts/${prompt.id}`, { method: 'DELETE' })
        closeModal()
        toast('提示词已删除')
        await load({ silent: true })
      } catch (error) {
        toast(error.message, true)
      }
    })
    modal.querySelector('#prompt-form').addEventListener('submit', async event => {
      event.preventDefault()
      const data = new FormData(event.target)
      const payload = {
        name: String(data.get('name') ?? '').trim(),
        category: String(data.get('category') ?? ''),
        default_severity: String(data.get('default_severity') ?? 'medium'),
        enabled: data.get('enabled') === 'on',
        content: String(data.get('content') ?? ''),
      }
      try {
        if (prompt) await api(`/prompts/${prompt.id}`, { method: 'PUT', body: payload })
        else await api('/prompts', { method: 'POST', body: payload })
        closeModal()
        toast(prompt ? '提示词已保存' : '提示词已创建')
        await load({ silent: true })
      } catch (error) {
        toast(error.message, true)
      }
    })
  })
}

function openImportModal() {
  const body = `<div class="transfer-grid">
    <div class="field"><label>选择 YAML / JSON 备份文件</label><input type="file" id="import-file" accept=".yml,.yaml,.json,.txt"></div>
    <div class="field"><label>或直接粘贴内容</label><textarea id="import-text" placeholder="version: 1&#10;prompts:&#10;  - name: ..."></textarea></div>
    <div class="hint">导入按名称合并：同名提示词更新内容，新名称则创建。内置提示词也会按名称更新。</div>
  </div>`
  const foot = `<button class="btn ghost" data-cancel="1" type="button">取消</button><button class="btn primary" id="import-submit" type="button">导入</button>`
  openModal('导入审计提示词', body, foot, modal => {
    modal.querySelector('[data-cancel]')?.addEventListener('click', closeModal)
    modal.querySelector('#import-file').addEventListener('change', async event => {
      const file = event.target.files?.[0]
      if (!file) return
      modal.querySelector('#import-text').value = await file.text()
    })
    modal.querySelector('#import-submit').addEventListener('click', async () => {
      const yaml = String(modal.querySelector('#import-text').value ?? '')
      if (!yaml.trim()) return toast('请提供要导入的 YAML 内容', true)
      try {
        const result = await api('/prompts/import', { method: 'POST', body: { yaml } })
        closeModal()
        toast(`导入完成：新增 ${result.created}，更新 ${result.updated}`)
        await load({ silent: true })
      } catch (error) {
        toast(error.message, true)
      }
    })
  })
}

function openExportTaskPicker() {
  const tasks = state.data.tasks
  const body = tasks.length === 0
    ? '<div class="empty">暂无任务可导出。</div>'
    : `<div class="field"><label>选择任务</label><select id="export-task">${tasks.map(task => `<option value="${task.id}">${esc(task.name)}（${esc(LABELS.taskStatus[task.status] ?? task.status)} · ${esc(task.id)}）</option>`).join('')}</select>
        <div class="hint">任务审计到一半也可导出：报告包含已发现的漏洞，尚未审计的提示词以空章节保留。</div></div>
      <div class="field"><label>导出格式</label><select id="export-format">
        <option value="markdown">Markdown</option>
        <option value="html">HTML</option>
        <option value="json">JSON</option>
      </select></div>`
  const foot = `<button class="btn ghost" data-cancel="1" type="button">取消</button><button class="btn primary" id="export-go" type="button" ${tasks.length === 0 ? 'disabled' : ''}>导出</button>`
  openModal('导出审计报告', body, foot, modal => {
    modal.querySelector('[data-cancel]')?.addEventListener('click', closeModal)
    modal.querySelector('#export-go')?.addEventListener('click', () => {
      const id = modal.querySelector('#export-task').value
      const format = modal.querySelector('#export-format').value
      download(`${API}/tasks/${id}/report?format=${format}`)
      closeModal()
      toast(`已开始导出 ${format} 报告`)
    })
  })
}

// ------------------------------------------------------------------ actions

async function handleAction(action, target) {
  const id = target.dataset.id
  const task = state.data.tasks.find(item => item.id === id)
  const finding = state.data.findings.find(item => item.id === id)
  const prompt = state.data.prompts.find(item => item.id === id)

  if (action === 'new-task') return openTaskModal(null)
  if (action === 'edit-task' && task) return openTaskModal(task)
  if (action === 'report-task' && task) return openReportModal(task)
  if (action === 'new-prompt') return openPromptModal(null)
  if (action === 'edit-prompt' && prompt) return openPromptModal(prompt)
  if (action === 'import-prompts') return openImportModal()
  if (action === 'export-task-report') return openExportTaskPicker()
  if (action === 'export-prompts') {
    download(`${API}/prompts/export`)
    return toast('已开始导出提示词 YAML')
  }
  if (action === 'finding-detail' && finding) return openFindingModal(finding)

  if (action === 'run-task' && task) {
    target.disabled = true
    try {
      await api(`/tasks/${task.id}/run`, { method: 'POST' })
      toast('审计已启动')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
      target.disabled = false
    }
    return
  }
  if (action === 'cancel-task' && task) {
    try {
      await api(`/tasks/${task.id}/cancel`, { method: 'POST' })
      toast('已请求取消审计')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
  if (action === 'toggle-task' && task) {
    try {
      await api(`/tasks/${task.id}/toggle`, { method: 'POST', body: { enabled: target.dataset.enabled !== '1' } })
      toast(target.dataset.enabled === '1' ? '任务已暂停' : '任务已启用')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
  if (action === 'delete-task' && task) {
    if (!confirm(`确定删除任务「${task.name}」？关联的漏洞与运行记录会一并删除。`)) return
    try {
      await api(`/tasks/${task.id}`, { method: 'DELETE' })
      toast('任务已删除')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
  if (action === 'verify-finding' && finding) return setFindingStatus(finding, 'verified')
  if (action === 'ignore-finding' && finding) return setFindingStatus(finding, 'ignored')
  if (action === 'delete-finding' && finding) {
    if (!confirm(`确定删除漏洞「${finding.title}」？`)) return
    try {
      await api(`/findings/${finding.id}`, { method: 'DELETE' })
      toast('漏洞记录已删除')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
  if (action === 'toggle-prompt' && prompt) {
    try {
      await api(`/prompts/${prompt.id}`, {
        method: 'PUT',
        body: { enabled: target.dataset.enabled !== '1' },
      })
      toast(target.dataset.enabled === '1' ? '提示词已禁用' : '提示词已启用')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
  if (action === 'delete-prompt' && prompt) {
    const message = prompt.builtin
      ? `确定删除内置提示词「${prompt.name}」？插件重启后内置模板会重新创建。`
      : `确定删除提示词「${prompt.name}」？`
    if (!confirm(message)) return
    try {
      await api(`/prompts/${prompt.id}`, { method: 'DELETE' })
      toast('提示词已删除')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
  if (action === 'trajectory-run') {
    download(`${API}/runs/${id}/trajectory`)
    return toast('已开始下载轨迹 JSONL')
  }
  if (action === 'cancel-run') {
    try {
      await api(`/runs/${id}/cancel`, { method: 'POST' })
      toast('已请求取消运行')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
  if (action === 'delete-run') {
    if (!confirm('确定删除该运行记录？对应的轨迹 JSONL 文件会一并删除。')) return
    try {
      await api(`/runs/${id}`, { method: 'DELETE' })
      toast('运行记录已删除')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, true)
    }
    return
  }
}

async function setFindingStatus(finding, status) {
  try {
    await api(`/findings/${finding.id}`, { method: 'PATCH', body: { status } })
    toast(`已标记为「${LABELS.findingStatus[status]}」`)
    await load({ silent: true })
  } catch (error) {
    toast(error.message, true)
  }
}

// --------------------------------------------------------------------- init

function bindEvents() {
  document.getElementById('tabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-tab]')
    if (!tab) return
    state.tab = tab.dataset.tab
    document.querySelectorAll('.tab').forEach(node => node.classList.toggle('active', node === tab))
    renderPanel()
  })

  panel().addEventListener('click', event => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    event.preventDefault()
    handleAction(target.dataset.action, target).catch(error => toast(error.message, true))
  })

  document.getElementById('overlay').addEventListener('click', event => {
    if (event.target.id === 'overlay') closeModal()
  })
  document.addEventListener('keydown', event => {
    // A nested dialog (directory picker) handles Escape itself.
    if (event.key === 'Escape' && state.modalOpen && !document.querySelector('.overlay-nested')) closeModal()
  })
}

async function poll() {
  if (document.hidden || state.modalOpen) return
  const active = document.activeElement
  if (active && active.closest('#panel') && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return
  await load({ silent: true })
}

bindEvents()
load()
setInterval(poll, 4000)
