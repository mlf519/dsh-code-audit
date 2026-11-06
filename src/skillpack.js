import { parseYamlDocument } from './yaml.js'

const SKILL_FILE = /(^|\/)SKILL\.md$/i
const TEXT_EXTENSION = /\.(md|markdown|txt|json|yaml|yml|csv|xml|html|htm|js|mjs|cjs|ts|py|go|java|kt|php|rb|rs|sh|ps1|sql|conf|ini|properties)$/i

/** Split a SKILL.md document into YAML frontmatter and Markdown body. */
export function parseSkillMarkdown(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { manifest: {}, body: source.trim(), name: '', description: '', hasFrontmatter: false }
  }
  let manifest
  try {
    manifest = parseYamlDocument(match[1])
  } catch (error) {
    throw inputError(`SKILL.md frontmatter 解析失败：${error?.message ?? error}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) manifest = {}
  const name = String(manifest.name ?? '').trim()
  const description = String(manifest.description ?? '').trim()
  return { manifest, body: match[2].trim(), name, description, hasFrontmatter: true }
}

/** Build a complete SKILL.md document from stored skill fields. */
export function buildSkillMarkdown(skill) {
  const manifest = isPlainObject(skill.manifest) ? { ...skill.manifest } : {}
  if (!manifest.name) manifest.name = skill.name
  if (!manifest.description && skill.description) manifest.description = skill.description
  if (skill.category && manifest.category === undefined) manifest.category = skill.category
  const frontmatter = emitYamlMap(manifest, 0).join('\n')
  const body = String(skill.content ?? '').replace(/\r\n/g, '\n').trim()
  return `---\n${frontmatter}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`
}

/** Normalise untrusted skill input and keep the derived fields in sync. */
export function normaliseSkillInput(input, current = {}) {
  const hasSkillMarkdown = input.skill_md !== undefined
  const providedMarkdown = String(input.skill_md ?? '').trim()
    ? String(input.skill_md).replace(/\r\n/g, '\n')
    : ''

  let parsed = { manifest: {}, body: '', name: '', description: '' }
  if (providedMarkdown) parsed = parseSkillMarkdown(providedMarkdown)

  const name = String(input.name ?? parsed.name ?? current.name ?? '').trim()
  if (!name) throw inputError('SKILL.md frontmatter 缺少 name，或未提供 Skill 名称')

  const description = String(
    input.description ?? parsed.description ?? current.description ?? '',
  ).trim()
  const content = parsed.body || String(input.content ?? current.content ?? '').replace(/\r\n/g, '\n')
  const references = input.references !== undefined
    ? normaliseReferences(input.references)
    : normaliseReferences(current.references ?? [])

  const category = String(input.category ?? current.category ?? '').trim()
  const manifest = {
    ...(isPlainObject(current.manifest) ? current.manifest : {}),
    ...parsed.manifest,
    name,
    description,
  }

  // Rebuild the document when the name changed or frontmatter had no name;
  // otherwise keep the imported SKILL.md formatting as-is.
  const rebuild = !providedMarkdown || !parsed.name || name !== parsed.name
  const skillMd = rebuild
    ? buildSkillMarkdown({ manifest, content, name, description, category })
    : providedMarkdown

  let reportGuide
  if (input.report_guide !== undefined) {
    reportGuide = String(input.report_guide ?? '')
  } else if (hasSkillMarkdown || input.references !== undefined) {
    reportGuide = resolveReportGuide(references)
  } else {
    reportGuide = String(current.report_guide ?? '')
  }

  return {
    name,
    category,
    description,
    content,
    skill_md: skillMd,
    manifest,
    references,
    report_guide: reportGuide,
    enabled: input.enabled === undefined ? (current.enabled ?? true) : Boolean(input.enabled),
  }
}

/** Normalise reference files and reject unsafe paths. */
export function normaliseReferences(references) {
  const list = coerceReferenceList(references)
  const seen = new Map()
  for (const item of list) {
    const path = cleanReferencePath(item?.path ?? item?.name)
    if (!path) continue
    const content = String(item?.content ?? '')
    if (!content.trim()) continue
    seen.set(path, { path, content })
  }
  return [...seen.values()]
}

/** Pick the report template reference when the skill does not declare one. */
export function resolveReportGuide(references) {
  const list = normaliseReferences(references)
  const find = pattern => list.find(item => pattern.test(item.path))
  const match = find(/audit-report-template\.(md|markdown)$/i)
    || find(/(report-template|报告模板)\.(md|markdown)$/i)
  if (match) return match.content
  const fallback = list.find(item => /report.*template\.(md|markdown)$/i.test(item.path)
    && !/poc|false-positive|误报/i.test(item.path))
  return fallback?.content ?? ''
}

/** Compose the audit instruction body from the skill and its references. */
export function skillPromptContent(skill) {
  let body = String(skill.content ?? '').trim()
  if (!body && String(skill.skill_md ?? '').trim()) {
    try {
      body = parseSkillMarkdown(skill.skill_md).body.trim()
    } catch {
      body = String(skill.skill_md ?? '').trim()
    }
  }
  const references = normaliseReferences(skill.references ?? [])
  if (references.length === 0) return body
  const parts = [body, '# Skill 参考文件（已内联，无需读取；下文提到的 references/ 路径即以下内容）']
  for (const reference of references) {
    parts.push(`## ${reference.path}\n\n${reference.content.trim()}`)
  }
  return parts.join('\n\n')
}

/** Files that make up one portable skill package. */
export function buildSkillFiles(skill) {
  let markdown = String(skill.skill_md ?? '').trim()
    ? String(skill.skill_md).replace(/\r\n/g, '\n')
    : buildSkillMarkdown(skill)
  if (!markdown.endsWith('\n')) markdown += '\n'
  const references = normaliseReferences(skill.references ?? [])
  return [
    { path: 'SKILL.md', content: markdown },
    ...references.map(reference => ({ path: reference.path, content: reference.content })),
  ]
}

/** Group a flat file list into one or more skill packages by SKILL.md location. */
export function groupSkillFiles(files) {
  const entries = (Array.isArray(files) ? files : [])
    .map(file => ({
      path: cleanArchivePath(file?.path ?? file?.name),
      content: String(file?.content ?? ''),
    }))
    .filter(file => file.path && file.content.trim() !== '' && isTextPath(file.path))

  const skillEntries = entries.filter(entry => SKILL_FILE.test(entry.path))
  if (skillEntries.length === 0) {
    throw inputError('导入内容中没有找到 SKILL.md')
  }

  const groups = []
  const usedBases = new Set()
  for (const skillEntry of skillEntries) {
    const base = dirname(skillEntry.path)
    if (usedBases.has(base)) continue
    usedBases.add(base)
    const memberEntries = entries.filter(entry => belongsTo(entry.path, base))
    const references = memberEntries
      .filter(entry => entry.path !== skillEntry.path)
      .map(entry => ({
        path: relativeTo(entry.path, base),
        content: entry.content,
      }))
    const parsed = parseSkillMarkdown(skillEntry.content)
    groups.push({
      skill_md: skillEntry.content,
      references,
      fallbackName: parsed.name || basenameOf(base) || '未命名 Skill',
    })
  }
  return groups
}

function coerceReferenceList(value) {
  let list = value
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = []
    }
  }
  if (!Array.isArray(list)) return []
  return list
}

function cleanReferencePath(value) {
  let path = cleanArchivePath(value)
  if (!path || path.includes('..') || path.startsWith('/')) return ''
  if (!path.startsWith('references/') && !path.includes('/')) path = `references/${path}`
  return path.length > 200 ? '' : path
}

function cleanArchivePath(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/')
    .trim()
}

function relativeTo(path, base) {
  if (!base) return path
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

function belongsTo(path, base) {
  return base === '' || path === base || path.startsWith(`${base}/`)
}

function dirname(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function basenameOf(path) {
  if (!path) return ''
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function isTextPath(path) {
  return SKILL_FILE.test(path) || TEXT_EXTENSION.test(path)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function emitYamlMap(map, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const [key, value] of Object.entries(map)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`)
        continue
      }
      lines.push(`${pad}${key}:`)
      for (const item of value) {
        if (isPlainObject(item) || Array.isArray(item)) {
          lines.push(`${pad}  - ${JSON.stringify(item)}`)
        } else {
          lines.push(`${pad}  - ${yamlScalar(item)}`)
        }
      }
      continue
    }
    if (isPlainObject(value)) {
      lines.push(`${pad}${key}:`)
      lines.push(...emitYamlMap(value, indent + 2))
      continue
    }
    lines.push(`${pad}${key}: ${yamlScalar(value)}`)
  }
  return lines
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const text = String(value)
  if (text === '') return '""'
  if (text.includes('\n')) return JSON.stringify(text)
  if (/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(text)) return text
  return JSON.stringify(text)
}

function inputError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}
