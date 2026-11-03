/**
 * Small YAML reader/writer for the prompt backup format.
 *
 * The plugin ships without third-party dependencies, so this module implements
 * the subset of YAML that the backup document needs: nested maps, lists of
 * maps, quoted/plain scalars, and literal/folded block scalars. JSON documents
 * are valid YAML and are accepted on import as well.
 */

const BLOCK_INDICATORS = new Set(['|', '|-', '|+', '>', '>-', '>+'])

/** Serialise the prompt backup document as human-editable YAML. */
export function stringifyPromptsDocument(prompts) {
  const lines = []
  lines.push('version: 1')
  lines.push(`exportedAt: ${JSON.stringify(new Date().toISOString())}`)
  lines.push('prompts:')
  if (prompts.length === 0) {
    lines[lines.length - 1] = 'prompts: []'
    return `${lines.join('\n')}\n`
  }
  for (const prompt of prompts) {
    lines.push(`  - name: ${quoteScalar(prompt.name)}`)
    lines.push(`    category: ${quoteScalar(prompt.category ?? '')}`)
    lines.push(`    defaultSeverity: ${quoteScalar(prompt.default_severity ?? prompt.defaultSeverity ?? 'medium')}`)
    lines.push(`    enabled: ${prompt.enabled === false ? 'false' : 'true'}`)
    const content = String(prompt.content ?? '')
    const keepTrailingNewline = content.endsWith('\n')
    lines.push(`    content: ${keepTrailingNewline ? '|' : '|-'}`)
    const bodyLines = content.split('\n')
    if (keepTrailingNewline) bodyLines.pop()
    for (const line of bodyLines) lines.push(line === '' ? '' : `      ${line}`)
  }
  return `${lines.join('\n')}\n`
}

/** Parse a backup document into an array of prompt records. */
export function parsePromptsDocument(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  if (source.trim() === '') throw new Error('YAML 内容为空')
  let document
  const trimmed = source.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    document = JSON.parse(source)
  } else {
    document = parseYamlDocument(source)
  }
  const list = Array.isArray(document) ? document : document?.prompts
  if (!Array.isArray(list)) throw new Error('备份文件缺少 prompts 列表')
  return list
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      name: String(item.name ?? '').trim(),
      category: String(item.category ?? '').trim(),
      default_severity: String(item.defaultSeverity ?? item.default_severity ?? 'medium').trim(),
      enabled: item.enabled === undefined ? true : item.enabled !== false,
      content: String(item.content ?? ''),
    }))
    .filter(item => item.name !== '')
}

/** Parse one YAML document into plain JavaScript values. */
export function parseYamlDocument(source) {
  const lines = source.split(/\r?\n/)
  const parsed = parseBlock(lines, 0)
  return parsed.value
}

function parseBlock(lines, baseIndent) {
  let index = skipIgnorable(lines, 0)
  if (index >= lines.length) return { value: null, next: lines.length }
  const indent = indentOf(lines[index])
  if (indent < baseIndent) return { value: null, next: index }
  if (lines[index].trimStart().startsWith('-')) return parseList(lines, index, indent)
  return parseMap(lines, index, indent)
}

function parseMap(lines, start, indent) {
  const value = {}
  let index = start
  while (index < lines.length) {
    index = skipIgnorable(lines, index)
    if (index >= lines.length) break
    const line = lines[index]
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent > indent) throw yamlError(line, index, '缩进不一致')
    const text = line.trim()
    if (text.startsWith('- ')) break
    const separator = findKeySeparator(text)
    if (separator === -1) throw yamlError(line, index, '缺少冒号')
    const key = String(parseScalar(text.slice(0, separator)))
    const rest = text.slice(separator + 1).trim()
    if (rest === '') {
      const childStart = skipIgnorable(lines, index + 1)
      if (childStart < lines.length && indentOf(lines[childStart]) > indent) {
        const end = findBlockEnd(lines, childStart, indent)
        value[key] = parseBlock(lines.slice(childStart, end), indent + 1).value
        index = end
      } else {
        value[key] = null
        index += 1
      }
      continue
    }
    if (BLOCK_INDICATORS.has(rest)) {
      const block = parseBlockScalar(lines, index, indent, rest)
      value[key] = block.value
      index = block.next
      continue
    }
    value[key] = parseScalar(rest)
    index += 1
  }
  return { value, next: index }
}

function parseList(lines, start, indent) {
  const value = []
  let index = start
  while (index < lines.length) {
    index = skipIgnorable(lines, index)
    if (index >= lines.length) break
    const line = lines[index]
    if (indentOf(line) !== indent) break
    const text = line.trim()
    if (!text.startsWith('-')) break
    const rest = text.slice(1).trimStart()
    if (rest === '') {
      const childStart = skipIgnorable(lines, index + 1)
      if (childStart < lines.length && indentOf(lines[childStart]) > indent) {
        const end = findBlockEnd(lines, childStart, indent)
        value.push(parseBlock(lines.slice(childStart, end), indent + 1).value)
        index = end
      } else {
        value.push(null)
        index += 1
      }
      continue
    }
    const end = findBlockEnd(lines, index + 1, indent)
    const virtualLines = [`${' '.repeat(indent + 2)}${rest}`, ...lines.slice(index + 1, end)]
    if (findKeySeparator(rest) !== -1 && !BLOCK_INDICATORS.has(rest)) {
      value.push(parseBlock(virtualLines, indent + 2).value)
    } else {
      value.push(parseScalar(rest))
    }
    index = end
  }
  return { value, next: index }
}

function parseBlockScalar(lines, keyIndex, parentIndent, indicator) {
  const raw = []
  let index = keyIndex + 1
  let contentIndent = -1
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      raw.push('')
      index += 1
      continue
    }
    const lineIndent = indentOf(line)
    if (lineIndent <= parentIndent) break
    if (contentIndent === -1) contentIndent = lineIndent
    raw.push(line.slice(Math.min(contentIndent, lineIndent)))
    index += 1
  }
  let value
  if (indicator.startsWith('>')) {
    value = raw.join(' ').replaceAll(/\s+/g, ' ').trim()
    if (!indicator.includes('-')) value += '\n'
  } else {
    value = raw.join('\n')
    if (indicator === '|-') value = value.replace(/\n+$/, '')
    else if (indicator !== '|+') value = `${value.replace(/\n+$/, '')}\n`
  }
  return { value, next: index }
}

function findBlockEnd(lines, start, parentIndent) {
  let index = start
  while (index < lines.length) {
    if (lines[index].trim() === '' || indentOf(lines[index]) > parentIndent) {
      index += 1
      continue
    }
    break
  }
  return index
}

function skipIgnorable(lines, index) {
  let cursor = index
  while (cursor < lines.length) {
    const text = lines[cursor].trim()
    if (text === '' || text.startsWith('#')) {
      cursor += 1
      continue
    }
    break
  }
  return cursor
}

function indentOf(line) {
  return line.length - line.trimStart().length
}

function findKeySeparator(text) {
  let quoted = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === quoted) quoted = null
      continue
    }
    if (char === '"' || char === "'") {
      quoted = char
      continue
    }
    if (char === ':') {
      const next = text[index + 1]
      if (next === undefined || next === ' ') return index
    }
  }
  return -1
}

function parseScalar(text) {
  const value = String(text).trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  return value
}

function quoteScalar(value) {
  return JSON.stringify(String(value ?? ''))
}

function yamlError(line, index, message) {
  return new Error(`YAML 第 ${index + 1} 行解析失败（${message}）：${clipLine(line)}`)
}

function clipLine(line) {
  const text = String(line).trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
