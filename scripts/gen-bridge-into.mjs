// 临时：把当前 src/bridge.ts 的桥接文件写进指定的 DSH home（用于沙盒复现，不污染仓库）
// v2.6.0：第 3 个参数指定 profile（默认 web）
import { build } from 'esbuild'

const home = process.argv[2]
const profile = process.argv[3] ?? 'web'
if (!home) {
  console.error('usage: node gen-bridge-into.mjs <dshHome> [profile]')
  process.exit(2)
}
const result = await build({
  entryPoints: ['src/bridge.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})
const code = result.outputFiles[0].text
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const res = mod.writeBridgeFiles(home, '0.0.0', profile)
const src = mod.bridgeScriptSource()
console.log('writeBridgeFiles:', JSON.stringify(res))
console.log('has pathOf:', src.includes('pathOf'), '| has upload fix:', src.includes('__DSH_FILE_UPLOAD__') && src.includes('dsh-file-upload'))
