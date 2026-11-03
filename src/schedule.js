/** Cron helpers and schedule validation for audit tasks. */

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/** Validate a five-field cron expression. Returns null when valid. */
export function validateCron(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return 'Cron 表达式必须包含 5 个字段（分 时 日 月 周）'
  const ranges = [
    [0, 59, null],
    [0, 23, null],
    [1, 31, null],
    [1, 12, MONTH_NAMES],
    [0, 7, DAY_NAMES],
  ]
  for (let index = 0; index < 5; index += 1) {
    try {
      buildFieldParser(fields[index], ...ranges[index])
    } catch (error) {
      return `Cron 第 ${index + 1} 个字段无效：${error.message}`
    }
  }
  return null
}

/** Compute the next ISO timestamp for a task schedule, or null for manual tasks. */
export function computeNextRun(schedule, from = new Date()) {
  const type = schedule.schedule_type ?? 'manual'
  if (type === 'manual') return null
  if (type === 'once') {
    const date = new Date(schedule.schedule_at)
    if (Number.isNaN(date.getTime())) return null
    return date.toISOString()
  }
  if (type === 'cron') {
    if (validateCron(schedule.schedule_cron)) return null
    return nextCronDate(schedule.schedule_cron, from)?.toISOString() ?? null
  }
  if (type === 'interval') {
    const minutes = Number(schedule.interval_minutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return null
    return new Date(from.getTime() + minutes * 60_000).toISOString()
  }
  return null
}

/** Return the first date strictly after `from` that matches the cron expression. */
export function nextCronDate(expression, from = new Date()) {
  const fields = String(expression ?? '').trim().split(/\s+/)
  if (fields.length !== 5) return null
  let minuteMatcher
  let hourMatcher
  let dayMatcher
  let monthMatcher
  let weekdayMatcher
  try {
    minuteMatcher = buildFieldParser(fields[0], 0, 59, null)
    hourMatcher = buildFieldParser(fields[1], 0, 23, null)
    dayMatcher = buildFieldParser(fields[2], 1, 31, null)
    monthMatcher = buildFieldParser(fields[3], 1, 12, MONTH_NAMES)
    weekdayMatcher = buildFieldParser(fields[4], 0, 7, DAY_NAMES)
  } catch {
    return null
  }

  const start = new Date(from)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  for (let dayOffset = 0; dayOffset < 732; dayOffset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset)
    if (!monthMatcher(day.getMonth() + 1) || !dayMatcher(day.getDate()) || !weekdayMatcher(day.getDay())) continue
    const startHour = dayOffset === 0 ? start.getHours() : 0
    for (let hour = startHour; hour < 24; hour += 1) {
      if (!hourMatcher(hour)) continue
      const startMinute = dayOffset === 0 && hour === start.getHours() ? start.getMinutes() : 0
      for (let minute = startMinute; minute < 60; minute += 1) {
        if (!minuteMatcher(minute)) continue
        return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0)
      }
    }
  }
  return null
}

function buildFieldParser(field, min, max, names) {
  const parts = String(field).split(',')
  const predicates = parts.map(part => buildPart(part.trim(), min, max, names))
  return value => predicates.some(predicate => predicate(value))
}

function buildPart(part, min, max, names) {
  if (part === '' || part === '*') return () => true
  const resolve = raw => {
    const text = String(raw).toLowerCase()
    if (names && names[text] !== undefined) return names[text]
    if (!/^\d+$/.test(text)) throw new Error(`无法识别的值 "${raw}"`)
    return Number(text)
  }

  const stepMatch = part.match(/^(\*|[\d]+(?:-[\d]+)?)\/(\d+)$/)
  if (stepMatch) {
    const step = Number(stepMatch[2])
    if (step <= 0) throw new Error('步长必须大于 0')
    const base = stepMatch[1]
    if (base === '*') {
      return value => (value - min) % step === 0 && value >= min && value <= max
    }
    const [low, high] = base.split('-').map(resolve)
    if (high === undefined) {
      return value => value >= low && value <= max && (value - low) % step === 0
    }
    return value => value >= low && value <= high && (value - low) % step === 0
  }

  const rangeMatch = part.match(/^([\d]+|[\w]+)-([\d]+|[\w]+)$/)
  if (rangeMatch) {
    const low = resolve(rangeMatch[1])
    const high = resolve(rangeMatch[2])
    if (low > high) throw new Error(`范围 ${part} 起点大于终点`)
    return value => value >= low && value <= high
  }

  const single = resolve(part)
  return value => value === single
}

/**
 * Validate and derive the scheduling fields of a task update.
 * Throws an Error with a user-facing message on invalid input.
 */
export function applySchedule(input, previous = {}) {
  const scheduleType = input.schedule_type ?? previous.schedule_type ?? 'manual'
  if (!['manual', 'once', 'cron', 'interval'].includes(scheduleType)) {
    throw new Error('未知的调度类型')
  }
  const schedule = { schedule_type: scheduleType }
  if (scheduleType === 'manual') {
    Object.assign(schedule, {
      schedule_at: null,
      schedule_cron: null,
      interval_minutes: null,
      next_run_at: null,
      status: previous.status === 'running' ? 'running' : 'draft',
    })
    return schedule
  }
  if (scheduleType === 'once') {
    const raw = input.schedule_at ?? previous.schedule_at
    const date = new Date(raw)
    if (Number.isNaN(date.getTime())) throw new Error('请选择有效的执行时间')
    Object.assign(schedule, {
      schedule_at: date.toISOString(),
      schedule_cron: null,
      interval_minutes: null,
      next_run_at: date.toISOString(),
      status: previous.status === 'running' ? 'running' : 'scheduled',
    })
    return schedule
  }
  if (scheduleType === 'cron') {
    const expression = String(input.schedule_cron ?? previous.schedule_cron ?? '').trim()
    const error = validateCron(expression)
    if (error) throw new Error(error)
    Object.assign(schedule, {
      schedule_at: null,
      schedule_cron: expression,
      interval_minutes: null,
      next_run_at: nextCronDate(expression)?.toISOString() ?? null,
      status: previous.status === 'running' ? 'running' : 'scheduled',
    })
    return schedule
  }
  const minutes = Number(input.interval_minutes ?? previous.interval_minutes)
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('间隔时间必须为正数（分钟）')
  Object.assign(schedule, {
    schedule_at: null,
    schedule_cron: null,
    interval_minutes: Math.floor(minutes),
    next_run_at: new Date(Date.now() + Math.floor(minutes) * 60_000).toISOString(),
    status: previous.status === 'running' ? 'running' : 'scheduled',
  })
  return schedule
}

/** Recompute the next run after a scheduled execution has started. */
export function rescheduleAfterRun(task) {
  if (!task.enabled) return { next_run_at: null, status: 'draft' }
  if (task.schedule_type === 'once') return { next_run_at: null, status: 'completed' }
  if (task.schedule_type === 'cron') {
    return {
      next_run_at: nextCronDate(task.schedule_cron)?.toISOString() ?? null,
      status: 'scheduled',
    }
  }
  if (task.schedule_type === 'interval') {
    const minutes = Number(task.interval_minutes) || 60
    return {
      next_run_at: new Date(Date.now() + minutes * 60_000).toISOString(),
      status: 'scheduled',
    }
  }
  return { next_run_at: null, status: 'draft' }
}
