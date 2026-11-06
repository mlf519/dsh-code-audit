import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildSkillMarkdown, normaliseReferences, parseSkillMarkdown } from './skillpack.js'

const PLUGIN_ID = 'dsh-code-audit'
const MARKER_FILE = '.dsh-code-audit.json'
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Default user-level DSH skill root: $DSH_HOME/skills or ~/.dsh/skills. */
export function defaultDshSkillsRoot() {
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'skills')
}

/**
 * Mirror one audit skill into the DSH skills directory so it becomes a normal
 * `/skill-name` skill (and is advertised through the `skill` tool).
 *
 * Only directories previously written by this plugin (marker file) are
 * overwritten; foreign skills with the same name are never touched.
 */
export function syncSkillToDsh(skill, { root = defaultDshSkillsRoot(), log = () => {} } = {}) {
  if (!skill) return { synced: false, reason: 'missing' }
  if (skill.enabled === false) {
    removeSkillFromDsh(skill, { root, log })
    return { synced: false, reason: 'disabled' }
  }

  const baseName = toSkillName(skill.name)
  if (!baseName) {
    log(`Skill「${skill.name}」名称不是 kebab-case，未同步到 DSH（示例：web-vuln-audit）`)
    return { synced: false, reason: 'invalid-name' }
  }

  let description = String(skill.description ?? '').trim()
  if (!description && String(skill.skill_md ?? '').trim()) {
    try {
      description = parseSkillMarkdown(skill.skill_md).description
    } catch {
      description = ''
    }
  }
  if (!description) {
    log(`Skill「${skill.name}」缺少 description，未同步到 DSH`)
    return { synced: false, reason: 'missing-description' }
  }

  const target = pickTarget(root, baseName, skill.id)
  if (!target) {
    log(`Skill「${skill.name}」在 ${root} 中与已有同名 Skill 冲突，未同步`)
    return { synced: false, reason: 'conflict' }
  }

  const mirror = {
    ...skill,
    name: target.name,
    description,
    manifest: {
      ...(skill.manifest && typeof skill.manifest === 'object' ? skill.manifest : {}),
      name: target.name,
      description,
    },
    // Rebuild frontmatter when the DSH name differs from the stored name.
    skill_md: target.name === skill.name ? String(skill.skill_md ?? '') : '',
  }
  const markdown = (String(mirror.skill_md ?? '').trim() ? String(mirror.skill_md) : buildSkillMarkdown(mirror))
    .replace(/\r\n/g, '\n')
  const files = [
    { path: 'SKILL.md', content: markdown.endsWith('\n') ? markdown : `${markdown}\n` },
    ...normaliseReferences(skill.references ?? []),
  ]

  const dir = target.dir
  try {
    mkdirSync(dir, { recursive: true })
    const previous = readMarker(dir)
    const keep = new Set(files.map(file => file.path))
    if (previous && Array.isArray(previous.files)) {
      for (const file of previous.files) {
        if (keep.has(file)) continue
        const stale = join(dir, file)
        if (existsSync(stale)) unlinkSync(stale)
      }
    }
    for (const file of files) {
      const targetPath = join(dir, file.path)
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, file.content, 'utf8')
    }
    writeFileSync(join(dir, MARKER_FILE), JSON.stringify({
      plugin: PLUGIN_ID,
      skillId: skill.id,
      name: target.name,
      files: files.map(file => file.path),
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
    removeOtherMirrors(root, skill.id, dir, log)
    return { synced: true, name: target.name, dir }
  } catch (error) {
    log(`写入 DSH Skill 目录失败：${error?.message ?? error}`)
    return { synced: false, reason: 'io-error', error: String(error?.message ?? error) }
  }
}

/**
 * Refresh DSH's skill catalog after this plugin changed mirror files. Without
 * it a deleted skill keeps showing up as a dead `/skill-name` entry.
 */
export function invalidateDshSkills(ctx) {
  try {
    ctx?.get?.('skills')?.invalidateCache?.()
  } catch {
    // catalog refresh is best-effort
  }
}

/** Remove every directory mirrored for this skill id by this plugin. */
export function removeSkillFromDsh(skill, { root = defaultDshSkillsRoot(), log = () => {} } = {}) {
  if (!skill?.id) return
  for (const dir of ownedDirs(root, skill.id)) removeMirrorDir(dir, log)
}

/**
 * Resolve the `/name` and directory of a live mirror written by this plugin.
 * Returns null when the skill is disabled, has an invalid name, or was never
 * mirrored (for example a name conflict with a third-party skill).
 */
export function findDshSkillMirror(skill, { root = defaultDshSkillsRoot() } = {}) {
  if (!skill?.id || skill.enabled === false) return null
  const baseName = toSkillName(skill.name)
  if (!baseName) return null
  const shortId = String(skill.id).replace(/[^a-z0-9]/gi, '').slice(-4) || '0000'
  for (const name of [baseName, `${baseName}-${shortId}`]) {
    const dir = join(root, name)
    const marker = readMarker(dir)
    if (marker?.plugin === PLUGIN_ID && marker.skillId === skill.id && existsSync(join(dir, 'SKILL.md'))) {
      return { name, dir }
    }
  }
  return null
}

/**
 * Delete one mirrored skill directory. SKILL.md is unlinked first so DSH's
 * watcher sees a skill-depth change and drops the `/skill-name` entry; a
 * whole-directory removal is not reported at that depth and leaves a stale
 * command behind.
 */
function removeMirrorDir(dir, log) {
  try {
    unlinkSync(join(dir, 'SKILL.md'))
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`删除 DSH 镜像 SKILL.md 失败：${error?.message ?? error}`)
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    log(`删除 DSH 镜像 Skill 失败：${error?.message ?? error}`)
  }
}

function pickTarget(root, baseName, skillId) {
  const shortId = String(skillId ?? '').replace(/[^a-z0-9]/gi, '').slice(-4) || '0000'
  const baseDir = join(root, baseName)
  if (!existsSync(baseDir)) return { dir: baseDir, name: baseName }
  const baseMarker = readMarker(baseDir)
  if (!baseMarker) {
    // A directory with no SKILL.md is an orphan (DSH's skill center moves the
    // file into `.trash/` on uninstall), so it is safe to take over. A live
    // third-party skill always has SKILL.md and must never be shadowed.
    return hasSkillFile(baseDir) ? null : { dir: baseDir, name: baseName }
  }
  if (baseMarker.plugin === PLUGIN_ID && baseMarker.skillId === skillId) return { dir: baseDir, name: baseName }

  // Another plugin-owned skill already uses the same slug: add a stable suffix.
  const name = `${baseName}-${shortId}`
  const dir = join(root, name)
  if (!existsSync(dir)) return { dir, name }
  const marker = readMarker(dir)
  if (marker?.plugin === PLUGIN_ID && marker.skillId === skillId) return { dir, name }
  return hasSkillFile(dir) ? null : { dir, name }
}

function hasSkillFile(dir) {
  return existsSync(join(dir, 'SKILL.md'))
}

function removeOtherMirrors(root, skillId, keepDir, log) {
  for (const dir of ownedDirs(root, skillId)) {
    if (dir === keepDir) continue
    removeMirrorDir(dir, log)
  }
}

function ownedDirs(root, skillId) {
  if (!existsSync(root)) return []
  const result = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const marker = readMarker(dir)
    if (marker?.plugin === PLUGIN_ID && marker.skillId === skillId) result.push(dir)
  }
  return result
}

function readMarker(dir) {
  try {
    const text = readFileSync(join(dir, MARKER_FILE), 'utf8')
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function toSkillName(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return SKILL_NAME.test(slug) ? slug : ''
}
