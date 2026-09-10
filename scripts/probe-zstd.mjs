// 探针：Node 原生 zstd 对「多帧拼接」的处理能力（决定会话修复驱动脚本怎么读）
// 用法：node scripts/probe-zstd.mjs
import { zstdCompressSync, zstdDecompressSync, zstdDecompress } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const head = JSON.stringify({ type: 'session/header', id: 'session-x' }) + '\n'
const rest = [1, 2, 3].map((i) => JSON.stringify({ type: 'user/message', seq: i })).join('\n')

const f1 = zstdCompressSync(Buffer.from(head, 'utf8'))
const f2 = zstdCompressSync(Buffer.from(rest, 'utf8'))
const blob = Buffer.concat([f1, f2])
console.log('frames:', f1.length, '+', f2.length, '=', blob.length)

console.log('--- zstdDecompressSync(整块) ---')
try {
  const out = zstdDecompressSync(blob).toString('utf8')
  console.log('ok, 解出字节=', out.length, '行数=', out.split('\n').filter(Boolean).length)
  console.log('内容尾部:', JSON.stringify(out.slice(-60)))
} catch (e) {
  console.log('throw:', e.code ?? e.message)
}

console.log('--- zstdDecompress 流（多帧是否连续）---')
try {
  const chunks = []
  await pipeline(Readable.from(blob), zstdDecompress(), async function* (src) {
    for await (const c of src) chunks.push(c)
  })
  const out = Buffer.concat(chunks).toString('utf8')
  console.log('ok, 解出字节=', out.length, '行数=', out.split('\n').filter(Boolean).length)
  console.log('内容尾部:', JSON.stringify(out.slice(-60)))
} catch (e) {
  console.log('throw:', e.code ?? e.message)
}
