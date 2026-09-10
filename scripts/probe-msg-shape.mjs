/**
 * 临时探针：解码真实会话，打印 message 事件的结构（顶层 key + data key），
 * 用于确认 id/role 到底在事件顶层还是在 data 里（决定"缺身份"修复器怎么写）。
 * 用法：node scripts/probe-msg-shape.mjs <session.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/probe-msg-shape.mjs <session.jsonl.zstd>')
  process.exit(2)
}

function splitFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.readUInt32LE(off) !== 0xfd2fb528) throw new Error('bad magic')
    off += 4
    const descriptor = buf[off]
    off += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const didFlag = descriptor & 3
    if (singleSegment === 0) off += 1
    off += [0, 1, 2, 4][didFlag]
    if (fcsFlag === 0) {
      if (singleSegment === 1) off += 1
    } else {
      off += [2, 4, 8][fcsFlag - 1]
    }
    for (;;) {
      const bh = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
      const last = bh & 1
      const type = (bh >> 1) & 3
      const size = bh >>> 3
      off += 3
      off += type === 1 ? 1 : size
      if (last === 1) break
    }
    if (checksum === 1) off += 4
    frames.push(buf.subarray(start, off))
  }
  return frames
}

function decodeAll(p) {
  const frames = splitFrames(readFileSync(p))
  return frames.map((f) => zstdDecompressSync(f).toString('utf8')).join('')
}

const text = decodeAll(path)
const lines = text.split('\n').filter((l) => l.length > 0)
console.log('header keys:', Object.keys(JSON.parse(lines[0])).join(','))
const byType = new Map()
for (let i = 1; i < lines.length; i++) {
  let obj
  try {
    obj = JSON.parse(lines[i])
  } catch {
    continue
  }
  const type = String(obj.type ?? '')
  const d = obj.data
  const keys = d && typeof d === 'object' ? Object.keys(d).join(',') : String(typeof d)
  const hasId = Boolean(d && typeof d === 'object' && typeof d.id === 'string' && d.id !== '')
  const hasRole = Boolean(d && typeof d === 'object' && typeof d.role === 'string' && d.role !== '')
  const prev = byType.get(type)
  if (prev === undefined) byType.set(type, { n: 1, keys, withId: hasId ? 1 : 0, withRole: hasRole ? 1 : 0 })
  else {
    prev.n += 1
    if (hasId) prev.withId += 1
    if (hasRole) prev.withRole += 1
  }
}
for (const [type, v] of byType) {
  console.log(`${type}  n=${String(v.n)}  dataId=${String(v.withId)}  dataRole=${String(v.withRole)}  dataKeys=${v.keys}`)
}

