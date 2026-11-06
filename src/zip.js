import { deflateRawSync, inflateRawSync } from 'node:zlib'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const UTF8_FLAG = 0x0800
const MAX_ENTRIES = 400
const MAX_UNCOMPRESSED = 32 * 1024 * 1024

/** Build a ZIP archive from text entries ({ path, content }). */
export function createZip(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      path: safePath(entry?.path),
      content: String(entry?.content ?? ''),
    }))
    .filter(entry => entry.path)
  const { time, date } = dosTimestamp(new Date())

  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of list) {
    const nameBuffer = Buffer.from(`${entry.path}`, 'utf8')
    const dataBuffer = Buffer.from(entry.content, 'utf8')
    const compressed = deflateRawSync(dataBuffer)
    const crc = crc32(dataBuffer)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(dataBuffer.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)

    localParts.push(local, nameBuffer, compressed)
    centralParts.push(buildCentral(nameBuffer, dataBuffer, compressed, crc, time, date, offset))
    offset += 30 + nameBuffer.length + compressed.length
  }

  const central = Buffer.concat(centralParts)
  const localData = Buffer.concat(localParts)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(list.length & 0xffff, 8)
  eocd.writeUInt16LE(list.length & 0xffff, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(localData.length, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([localData, central, eocd])
}

/** Read a ZIP archive into text entries ({ path, content }). */
export function readZip(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (data.length < 22) throw inputError('ZIP 文件内容过短')

  const eocdOffset = findEocd(data)
  if (eocdOffset === -1) throw inputError('不是有效的 ZIP 文件')

  const total = data.readUInt16LE(eocdOffset + 10)
  const centralOffset = data.readUInt32LE(eocdOffset + 16)
  const centralSize = data.readUInt32LE(eocdOffset + 12)
  if (total > MAX_ENTRIES) throw inputError(`ZIP 内文件数量过多（${total}），上限 ${MAX_ENTRIES}`)
  if (centralOffset + centralSize > data.length) throw inputError('ZIP 中央目录损坏')

  const entries = []
  let pointer = centralOffset
  let totalSize = 0

  for (let index = 0; index < total; index += 1) {
    if (pointer + 46 > data.length || data.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) {
      throw inputError('ZIP 中央目录已损坏')
    }
    const method = data.readUInt16LE(pointer + 10)
    const crc = data.readUInt32LE(pointer + 16)
    const compressedSize = data.readUInt32LE(pointer + 20)
    const size = data.readUInt32LE(pointer + 24)
    const nameLength = data.readUInt16LE(pointer + 28)
    const extraLength = data.readUInt16LE(pointer + 30)
    const commentLength = data.readUInt16LE(pointer + 32)
    const localOffset = data.readUInt32LE(pointer + 42)
    const nameStart = pointer + 46
    const name = data.toString('utf8', nameStart, nameStart + nameLength)
    pointer = nameStart + nameLength + extraLength + commentLength

    if (size > MAX_UNCOMPRESSED) throw inputError(`ZIP 内文件过大：${name}`)
    totalSize += size
    if (totalSize > MAX_UNCOMPRESSED) throw inputError('ZIP 解压后内容过大')

    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw inputError(`ZIP 本地文件头损坏：${name}`)
    }
    const localNameLength = data.readUInt16LE(localOffset + 26)
    const localExtraLength = data.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > data.length) throw inputError(`ZIP 文件数据被截断：${name}`)

    const raw = data.subarray(dataStart, dataEnd)
    let buffer
    if (method === 0) {
      buffer = raw
    } else if (method === 8) {
      buffer = inflateRawSync(raw)
    } else {
      throw inputError(`ZIP 使用了不支持的压缩方式 ${method}：${name}`)
    }
    if (crc32(buffer) !== crc) {
      throw inputError(`ZIP 文件校验失败：${name}`)
    }
    const content = buffer.toString('utf8')

    const path = safePath(name)
    if (!path) continue
    entries.push({ path, content })
  }

  return entries
}

function buildCentral(nameBuffer, dataBuffer, compressed, crc, time, date, offset) {
  const central = Buffer.alloc(46)
  central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(UTF8_FLAG, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt16LE(time, 12)
  central.writeUInt16LE(date, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(dataBuffer.length, 24)
  central.writeUInt16LE(nameBuffer.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(offset, 42)
  return Buffer.concat([central, nameBuffer])
}

function findEocd(data) {
  const lowest = Math.max(0, data.length - 22 - 0xffff)
  for (let index = data.length - 22; index >= lowest; index -= 1) {
    if (data.readUInt32LE(index) === EOCD_SIGNATURE) return index
  }
  return -1
}

function safePath(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/')
    .trim()
}

function dosTimestamp(date) {
  const year = Math.max(date.getFullYear(), 1980)
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

let crcTable
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[index] = value >>> 0
    }
  }
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = crcTable[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function inputError(message) {
  const error = new Error(message)
  error.status = 400
  return error
}
