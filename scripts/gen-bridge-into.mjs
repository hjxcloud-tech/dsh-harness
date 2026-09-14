// 临时：把当前 src/bridge.ts 的桥接文件写进指定的 DSH home（用于沙盒复现，不污染仓库）
import { build } from 'esbuild'

const home = process.argv[2]
if (!home) {
  console.error('usage: node gen-bridge-into.mjs <dshHome>')
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
const res = mod.writeBridgeFiles(home, '0.0.0')
const src = mod.bridgePluginSource()
console.log('writeBridgeFiles:', JSON.stringify(res))
console.log('has watchEdits:', src.includes('function watchEdits(el)'), '| has editKey:', src.includes('function editKey(e)'), '| has dom(merged):', src.includes('dom(merged)'))
