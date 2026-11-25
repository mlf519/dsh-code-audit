import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import * as zlib from 'node:zlib'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { nowIso } from './util.js'

/** Durable artifact filenames, newest generation first. */
const ARTIFACT_NAMES = [
  'session.v4.jsonl.zstd',
  'session.v3.jsonl.zstd',
  'session.v2.jsonl.zstd',
  'session.jsonl.zstd',
  'session.jsonl',
]

/** Decode a DSH session directory name back to its raw session id. */
function decodeSessionSegment(encoded) {
  if (encoded === '~002E') return '.'
  if (encoded === '~002E~002E') return '..'
  return String(encoded).replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/** First line of a JSONL artifact, decoding zstd when Node exposes it. */
function readArtifactHeader(filePath) {
  try {
    let text
    if (filePath.endsWith('.zstd')) {
      if (typeof zlib.zstdDecompressSync !== 'function') return null
      text = zlib.zstdDecompressSync(readFileSync(filePath)).toString('utf8')
    } else {
      text = readFileSync(filePath, 'utf8')
    }
    const end = text.indexOf('\n')
    const header = JSON.parse(text.slice(0, end < 0 ? undefined : end))
    return header?.id ? header : null
  } catch {
    return null
  }
}

/**
 * Manage persisted DSH sessions from the plugin console.
 *
 * Active sessions stay where the DSH persistence backend put them; archived
 * sessions are moved out of that backend's root into the plugin data directory
 * so they disappear from the DSH session menu but can be restored later.
 */
export function createSessionManager({
  ctx,
  dataDir,
  log = () => {},
  protectedSessions = () => new Set(),
}) {
  const archiveRoot = join(dataDir, 'session-archive')
  const indexFile = join(archiveRoot, 'index.json')
  mkdirSync(archiveRoot, { recursive: true })

  // Cordis services may be reachable through get() or as context properties;
  // probing can throw, so keep one tolerant accessor.
  const service = name => {
    try {
      if (typeof ctx.get === 'function') {
        const value = ctx.get(name)
        if (value !== undefined) return value
      }
    } catch {
      // fall through to the property accessor
    }
    try {
      return ctx[name]
    } catch {
      return undefined
    }
  }

  const persistence = () => service('sessionPersistence')
  const sessions = () => service('sessions')
  const query = () => service('sessionQuery')
  const agents = () => service('agents')

  const liveIds = () => {
    const set = new Set()
    try {
      for (const session of sessions()?.list?.() ?? []) set.add(String(session.id))
    } catch {
      // Live listing is best-effort; persisted records still work.
    }
    return set
  }

  /**
   * Sessions whose agent is actively running. Sessions stay registered in the
   * live store after the user stops them, so liveness alone is not "running" —
   * only an agent in the `running` status blocks archive/delete.
   */
  const runningIds = () => {
    const registry = agents()
    if (!registry?.list) return liveIds()
    const set = new Set()
    try {
      for (const agent of registry.list() ?? []) {
        if (agent?.status !== 'running') continue
        const id = agent.session?.id ?? agent.id
        if (id) set.add(String(id))
      }
    } catch {
      return liveIds()
    }
    return set
  }

  // Last successfully listed headers and resolved session directories. The
  // persistence index can reject or omit sessions (corrupt artifact, scoped
  // listing), so the disk library under <dshHome>/sessions is the fallback.
  const headerCache = new Map()
  const dirCache = new Map()
  // The persistence index can keep listing sessions after the plugin archived
  // or deleted them (the host refreshes it later). Track local outcomes so the
  // console updates immediately instead of showing stale rows.
  const locallyArchived = new Set()
  const locallyRestored = new Set()
  const removedSessions = new Set()

  const sessionsRoot = () => {
    try {
      const home = service('dshHomePath')
      const root = typeof home === 'function' ? home('sessions') : undefined
      if (root) return root
    } catch {
      // fall through to the env/home default
    }
    const raw = String(process.env.DSH_HOME ?? '').trim()
    let base
    if (!raw) base = join(homedir(), '.dsh')
    else if (raw === '~') base = homedir()
    else if (raw.startsWith('~/') || raw.startsWith('~\\')) base = join(homedir(), raw.slice(2))
    else base = raw
    return join(base, 'sessions')
  }

  /**
   * Walk the session library for directories the persistence index did not
   * return. Headers already listed are skipped, so this only costs one file
   * read per orphan session.
   */
  const scanDisk = async (knownIds, backend) => {
    const root = sessionsRoot()
    const headers = []
    let projects
    try {
      projects = readdirSync(root, { withFileTypes: true })
    } catch {
      return headers
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue
      let dirs
      try {
        dirs = readdirSync(join(root, project.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of dirs) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const id = decodeSessionSegment(entry.name)
        const full = join(root, project.name, entry.name)
        const artifact = ARTIFACT_NAMES
          .map(name => join(full, name))
          .find(path => existsSync(path))
        if (!artifact) continue
        dirCache.set(id, full)
        if (knownIds.has(id)) {
          // Already listed (or cached): keep its header without re-reading.
          const cached = headerCache.get(id)
          if (cached) headers.push(cached)
          continue
        }
        let header = readArtifactHeader(artifact)
        if (!header && typeof backend?.readRaw === 'function') {
          try {
            header = (await backend.readRaw(id))?.meta ?? null
          } catch {
            header = null
          }
        }
        if (header?.id) {
          knownIds.add(id)
          headers.push(header)
        }
      }
    }
    return headers
  }

  const persistedHeaders = async () => {
    const backend = persistence()
    const headers = []
    if (backend?.list) {
      try {
        const rows = (await backend.list()) ?? []
        for (const row of rows) {
          // Snapshot rows carry { header, ... }; raw headers are flat.
          const header = row?.header && typeof row.header === 'object' ? row.header : row
          if (header?.id) headers.push(header)
        }
      } catch (error) {
        log(`读取会话索引失败，回退到磁盘扫描：${error?.message ?? error}`)
      }
    }
    const known = new Set([...headerCache.keys(), ...headers.map(header => String(header.id))])
    for (const header of await scanDisk(known, backend)) headers.push(header)
    for (const header of headers) headerCache.set(String(header.id), header)
    return headers
  }

  /** Headers from live sessions, whose artifact may not be listed yet. */
  const liveHeaders = () => {
    const headers = new Map()
    try {
      for (const session of sessions()?.list?.() ?? []) {
        if (session.header?.id) headers.set(String(session.header.id), session.header)
      }
    } catch {
      // ignore
    }
    return headers
  }

  const currentHeaders = async () => {
    const headers = new Map()
    for (const [id, header] of liveHeaders()) headers.set(id, header)
    for (const header of await persistedHeaders()) {
      if (header?.id) headers.set(String(header.id), header)
    }
    return headers
  }

  /** Direct and nested child session ids of one main session. */
  const familyOf = (id, headers) => {
    const children = new Map()
    for (const [childId, header] of headers) {
      const parent = String(header?.parentSession ?? '')
      if (!parent) continue
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(childId)
    }
    const result = []
    const seen = new Set([id])
    const queue = [id]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const childId of children.get(current) ?? []) {
        if (seen.has(childId)) continue
        seen.add(childId)
        result.push(childId)
        queue.push(childId)
      }
    }
    return result
  }

  /** A session is a child only while its parent is still known. */
  const isChildSession = (header, headers) => {
    const parent = String(header?.parentSession ?? '')
    return Boolean(parent) && headers.has(parent)
  }

  const readIndex = () => {
    try {
      const parsed = JSON.parse(readFileSync(indexFile, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(row => row?.id) : []
    } catch {
      return []
    }
  }

  const writeIndex = rows => {
    writeFileSync(indexFile, JSON.stringify(rows, null, 2), 'utf8')
  }

  const upsertRecord = record => {
    const rows = readIndex().filter(row => row.id !== record.id)
    rows.push(record)
    writeIndex(rows)
  }

  const dropRecord = id => {
    const rows = readIndex()
    const next = rows.filter(row => row.id !== id)
    if (next.length !== rows.length) writeIndex(next)
  }

  const projectKey = cwd => {
    const text = String(cwd ?? '').trim() || 'unknown'
    const name = basename(text.replaceAll('\\', '/')) || 'unknown'
    const safe = name.replace(/[^\w.-]+/g, '_').slice(0, 40)
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 8)
    return `${safe}-${hash}`
  }

  const titleMap = async ids => {
    const result = new Map()
    const engine = query()
    if (!engine?.readTitleSnapshots || ids.length === 0) return result
    try {
      const rows = await engine.readTitleSnapshots(ids)
      for (const row of rows) {
        if (row?.status === 'fulfilled' && row.value?.title?.title) {
          result.set(String(row.sessionId), row.value.title.title)
        }
      }
    } catch {
      // Titles are cosmetic; fall back to the id.
    }
    return result
  }

  /**
   * DSH hides archived sessions from the left sidebar through its workspace
   * registry; the host layer broadcasts the archived-id set to every client.
   */
  const workspaceServices = () => [service('uiWorkspace'), service('workspaceRegistry')].filter(Boolean)

  const archivedIds = () => {
    for (const svc of workspaceServices()) {
      try {
        if (Array.isArray(svc.archivedSessionIds)) {
          const set = new Set([
            ...svc.archivedSessionIds.map(String),
            ...readIndex().map(row => row.id),
            ...locallyArchived,
          ])
          for (const restoredId of locallyRestored) set.delete(restoredId)
          return set
        }
      } catch {
        // try the next service
      }
    }
    const set = new Set([...readIndex().map(row => row.id), ...locallyArchived])
    for (const restoredId of locallyRestored) set.delete(restoredId)
    return set
  }

  const archiveNative = async id => {
    for (const svc of workspaceServices()) {
      if (typeof svc.archiveSession === 'function') {
        // stopActivity:false keeps an idle session's agent attached.
        await svc.archiveSession(id, { stopActivity: false })
        return true
      }
    }
    const registry = service('workspaceRegistry')
    if (registry?.enqueueOperation && registry?.requireState && registry?.setState) {
      await registry.enqueueOperation(async () => {
        const state = registry.requireState()
        const ids = Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds : []
        if (ids.includes(id)) return
        await registry.setState({ ...state, archivedSessionIds: [...ids, id] })
      })
      return true
    }
    return false
  }

  const unarchiveNative = async id => {
    for (const svc of workspaceServices()) {
      if (typeof svc.unarchiveSession === 'function') {
        await svc.unarchiveSession(id)
        return true
      }
    }
    const registry = service('workspaceRegistry')
    if (registry?.enqueueOperation && registry?.requireState && registry?.setState) {
      await registry.enqueueOperation(async () => {
        const state = registry.requireState()
        const ids = Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds : []
        if (!ids.includes(id)) return
        await registry.setState({ ...state, archivedSessionIds: ids.filter(value => value !== id) })
      })
      return true
    }
    return false
  }

  const list = async ({ view = 'active' } = {}) => {
    if (view === 'archived') {
      const records = new Map(readIndex().map(row => [row.id, row]))
      const ids = new Set([...records.keys(), ...archivedIds()])
      const headers = await currentHeaders()
      const titles = await titleMap([...ids])
      const rows = []
      for (const id of ids) {
        const record = records.get(id)
        const header = headers.get(id)
        // A natively archived id whose artifact is already deleted is skipped.
        if (!record && !header) continue
        if (removedSessions.has(id)) continue
        // Only main sessions are listed; children follow their root.
        if (record?.rootId && record.rootId !== id) continue
        if (!record && isChildSession(header, headers)) continue
        rows.push({
          id,
          title: record?.title || titles.get(id) || '',
          createdAt: Number(record?.createdAt ?? header?.createdAt ?? 0),
          cwd: record?.cwd ?? header?.cwd ?? '',
          origin: header?.origin ?? '',
          archived: true,
          live: false,
          supported: record ? record.backend === 'jsonl' : true,
          dir: record?.dir ?? '',
        })
      }
      return rows.sort((a, b) => b.createdAt - a.createdAt)
    }
    const backend = persistence()
    const running = runningIds()
    const headers = await currentHeaders()
    const archived = archivedIds()
    const liveSessions = new Map()
    try {
      for (const session of sessions()?.list?.() ?? []) liveSessions.set(String(session.id), session)
    } catch {
      // ignore
    }
    // Sub-agent sessions belong to their main session; only main sessions are
    // managed here, and archiving/deleting one also handles its children.
    const guarded = protectedSessions()
    const ids = [...headers.keys()].filter(id =>
      !archived.has(id) && !removedSessions.has(id) && !isChildSession(headers.get(id), headers))
    const titles = await titleMap(ids)
    return ids
      .map(id => {
        const header = headers.get(id)
        const liveSession = liveSessions.get(id)
        let title = titles.get(id)
        if (!title && liveSession) {
          try {
            title = (ctx.get?.('sessionTitle') ?? ctx.sessionTitle)?.get?.(liveSession)?.title
          } catch {
            title = undefined
          }
        }
        return {
          id,
          title: title || '',
          createdAt: Number(header?.createdAt ?? 0),
          cwd: header?.cwd ?? '',
          parentSession: header?.parentSession ?? '',
          origin: header?.origin ?? '',
          live: running.has(id),
          paused: guarded.has(id),
          archived: false,
          supported: Boolean(backend?.supportsRawArtifacts),
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Close persistence writers for an idle session; Windows refuses to rename
   * a session directory while its artifact still has an open write handle.
   */
  const closeWriters = async id => {
    const backend = persistence()
    const writers = new Set()
    try {
      const writer = backend?.tracker?.writers?.get?.(id)
      if (writer) writers.add(writer)
    } catch {
      // tracker internals are best-effort
    }
    try {
      for (const handle of backend?.tracker?.openHandles ?? []) {
        if (handle?.id === id && handle?.access === 'write') writers.add(handle)
      }
    } catch {
      // ignore
    }
    for (const writer of writers) {
      if (typeof writer.close !== 'function') continue
      await Promise.race([
        Promise.resolve(writer.close()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('关闭会话写入超时')), 3000)),
      ]).catch(error => log(`关闭会话 ${id} 写入失败：${error?.message ?? error}`))
    }
  }

  /** Move a directory, falling back to copy+delete across volumes. */
  const moveDir = (from, to) => {
    try {
      renameSync(from, to)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      cpSync(from, to, { recursive: true, force: true })
      rmSync(from, { recursive: true, force: true })
    }
  }

  const locateDir = header => {
    const backend = persistence()
    if (!backend?.locate || !backend?.supportsRawArtifacts) return null
    try {
      const location = backend.locate(header)
      return location?.path ? dirname(location.path) : null
    } catch {
      return null
    }
  }

  /** Only <sessions>/<project>/<sessionId> may be moved or deleted. */
  const validSessionDir = (dir, id) => {
    try {
      const rel = relative(resolve(sessionsRoot()), resolve(dir))
      if (!rel || rel.startsWith('..')) return false
      const parts = rel.split(sep)
      return parts.length === 2 && decodeSessionSegment(parts[1]) === id
    } catch {
      return false
    }
  }

  const resolveSessionDir = (header, id) => {
    const located = header ? locateDir(header) : null
    if (located && validSessionDir(located, id)) return located
    const cached = dirCache.get(id)
    if (cached && validSessionDir(cached, id)) return cached
    return null
  }

  const archive = async ids => {
    const headers = await currentHeaders()
    const running = runningIds()
    const guarded = protectedSessions()
    const results = []
    for (const id of ids) {
      try {
        const header = headers.get(id)
        if (!header) throw new Error('未找到该会话')
        const members = [id, ...familyOf(id, headers)]
        for (const memberId of members) {
          if (running.has(memberId)) throw new Error('会话或子 agent 正在运行，无法归档')
          if (guarded.has(memberId)) throw new Error('该会话属于暂停中的审计任务，请先取消或继续该任务')
        }
        let archived = false
        try {
          archived = await archiveNative(id)
        } catch (error) {
          log(`原生归档失败，改为移动会话目录：${error?.message ?? error}`)
        }
        if (!archived) {
          const titles = await titleMap(members)
          for (const memberId of members) {
            const memberHeader = headers.get(memberId)
            if (!memberHeader) continue
            const sourceDir = resolveSessionDir(memberHeader, memberId)
            if (!sourceDir || !existsSync(sourceDir)) {
              if (memberId === id) throw new Error('未找到该会话的磁盘目录')
              continue
            }
            const project = projectKey(memberHeader.cwd ?? header.cwd)
            const record = {
              id: memberId,
              rootId: id,
              parentSession: String(memberHeader.parentSession ?? ''),
              title: titles.get(memberId) ?? '',
              createdAt: Number(memberHeader.createdAt ?? 0),
              cwd: memberHeader.cwd ?? '',
              project,
              originalDir: sourceDir,
              dir: join(archiveRoot, project, memberId),
              backend: 'jsonl',
              archivedAt: nowIso(),
            }
            if (existsSync(record.dir)) rmSync(record.dir, { recursive: true, force: true })
            mkdirSync(dirname(record.dir), { recursive: true })
            await closeWriters(memberId)
            moveDir(sourceDir, record.dir)
            upsertRecord(record)
            headerCache.delete(memberId)
            dirCache.delete(memberId)
          }
        }
        locallyArchived.add(id)
        locallyRestored.delete(id)
        results.push({ id, ok: true })
      } catch (error) {
        results.push({ id, ok: false, error: String(error?.message ?? error) })
      }
    }
    return results
  }

  const restore = async ids => {
    const running = runningIds()
    const headers = await currentHeaders()
    const results = []
    for (const id of ids) {
      try {
        if (running.has(id)) throw new Error('会话正在运行，无法恢复')
        const rows = readIndex()
        const rootRecord = rows.find(row => row.id === id)
        const members = new Set([
          ...familyOf(id, headers),
          ...rows.filter(row => row.rootId === id).map(row => row.id),
          id,
        ])
        const pending = []
        for (const memberId of members) {
          const record = rows.find(row => row.id === memberId)
          if (!record) continue
          if (!existsSync(record.dir)) {
            if (memberId === id) throw new Error('归档目录缺失')
            log(`子会话 ${memberId} 的归档目录缺失，跳过恢复`)
            continue
          }
          if (existsSync(record.originalDir)) {
            throw new Error(memberId === id ? '原会话目录已存在，无法恢复' : '子会话原目录已存在，无法恢复')
          }
          pending.push(record)
        }
        for (const record of pending) {
          mkdirSync(dirname(record.originalDir), { recursive: true })
          moveDir(record.dir, record.originalDir)
          dropRecord(record.id)
          dirCache.set(record.id, record.originalDir)
          headerCache.delete(record.id)
        }
        if (!rootRecord && pending.length === 0 && !headers.get(id)) {
          throw new Error('未找到该会话')
        }
        const restored = await unarchiveNative(id)
        if (!restored && !rootRecord && pending.length === 0) {
          throw new Error('当前 DSH 版本不支持恢复归档会话')
        }
        locallyArchived.delete(id)
        locallyRestored.add(id)
        results.push({ id, ok: true })
      } catch (error) {
        results.push({ id, ok: false, error: String(error?.message ?? error) })
      }
    }
    return results
  }

  const remove = async ids => {
    const running = runningIds()
    const headers = await currentHeaders()
    const results = []
    for (const id of ids) {
      try {
        const members = new Set([id, ...familyOf(id, headers)])
        for (const row of readIndex()) {
          if (row.rootId === id) members.add(row.id)
        }
        const guarded = protectedSessions()
        for (const memberId of members) {
          if (running.has(memberId)) throw new Error('会话或子 agent 正在运行，无法删除')
          if (guarded.has(memberId)) throw new Error('该会话属于暂停中的审计任务，请先取消或继续该任务')
        }
        // Hide the row from the left sidebar before the artifact disappears.
        try {
          await archiveNative(id)
        } catch {
          // Older DSH builds have no registry; the file removal below still applies.
        }
        let removed = 0
        for (const memberId of members) {
          const record = readIndex().find(row => row.id === memberId)
          const dir = record?.dir ?? resolveSessionDir(headers.get(memberId), memberId)
          if (dir && existsSync(dir)) {
            await closeWriters(memberId)
            rmSync(dir, { recursive: true, force: true })
            removed += 1
          }
          dropRecord(memberId)
          headerCache.delete(memberId)
          dirCache.delete(memberId)
          // Cold sessions have no Session instance to dispose, so notify clients
          // directly (newer hosts remove the sidebar row from this event).
          try {
            ctx.emit?.('api-session/removed', memberId)
          } catch {
            // event support varies by DSH version
          }
        }
        if (removed === 0) throw new Error('未找到可删除的会话目录')
        // Keep the deleted id out of both views even when the persistence index
        // still returns it; drop the archived marker as well.
        removedSessions.add(id)
        locallyArchived.delete(id)
        locallyRestored.delete(id)
        try {
          await unarchiveNative(id)
        } catch {
          // Older DSH builds have no registry.
        }
        results.push({ id, ok: true })
      } catch (error) {
        results.push({ id, ok: false, error: String(error?.message ?? error) })
      }
    }
    return results
  }

  return { list, archive, restore, remove }
}
