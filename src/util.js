import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Severities ordered from most to least severe. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

/** Finding statuses recognised by the console and the agent tool. */
export const FINDING_STATUSES = ['open', 'verified', 'ignored', 'false_positive', 'fixed']

/** Task statuses. */
export const TASK_STATUSES = ['draft', 'scheduled', 'running', 'completed', 'failed', 'cancelled']

/** Create an ISO timestamp for the current instant. */
export function nowIso() {
  return new Date().toISOString()
}

/** Mint a short prefixed identifier that stays readable in the UI. */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/** JSON.parse that never throws. */
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** Trim a string and cap it, appending an ellipsis when truncated. */
export function clip(value, max = 500) {
  const text = String(value ?? '').trim()
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Escape text for direct HTML interpolation. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Normalise a severity value. */
export function normaliseSeverity(value, fallback = 'medium') {
  const severity = String(value ?? '').toLowerCase()
  return SEVERITIES.includes(severity) ? severity : fallback
}

/** Resolve the DeepSeek Harness home using the documented precedence. */
export function resolveDshHome(configured) {
  const explicit = configured?.trim()
  if (explicit) return explicit
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

/** Default plugin data directory under the DSH home. */
export function defaultDataDir() {
  return join(resolveDshHome(), 'storages', 'code-audit')
}

/** Recursively freeze a plain JSON value (used for tool outputs). */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Sort findings by severity then file path. */
export function compareFindings(a, b) {
  const bySeverity = SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
  if (bySeverity !== 0) return bySeverity
  return String(a.file_path ?? '').localeCompare(String(b.file_path ?? ''))
}
