import { nowIso } from './util.js'
import { rescheduleAfterRun } from './schedule.js'

/** Polls the database for due audit tasks and starts their runs. */
export class AuditScheduler {
  constructor({ store, runner, intervalMs = 30_000, log = () => {} }) {
    this.store = store
    this.runner = runner
    this.intervalMs = intervalMs
    this.log = log
    this.timer = null
    this.busy = false
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(error => this.log(`调度检查失败：${error?.message ?? error}`))
    }, this.intervalMs)
    this.timer.unref?.()
    Promise.resolve().then(() => this.tick()).catch(() => {})
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const due = this.store.dueTasks(nowIso())
      for (const task of due) {
        if (this.runner.isRunning(task.id)) continue
        try {
          await this.runner.start(task.id, 'schedule')
        } catch (error) {
          const message = String(error?.message ?? error)
          this.log(`定时任务「${task.name}」启动失败：${message}`)
          if (task.schedule_type === 'once') {
            this.store.updateTask(task.id, { status: 'failed', next_run_at: null })
          } else {
            const next = rescheduleAfterRun(task)
            this.store.updateTask(task.id, { ...next, status: next.next_run_at ? 'scheduled' : 'failed' })
          }
        }
      }
    } finally {
      this.busy = false
    }
  }
}
