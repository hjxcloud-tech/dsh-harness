// Regenerate the bridge plugin files for ~/.dsh (profile via `--profile <name>`, default web)
// from current src/bridge.ts. Bundles bridge.ts (its imports are node builtins + ./i18n) and
// calls writeBridgeFiles() — the same code path the running plugin uses (independent package
// layout + cordis.patch.yml merge, v2.6.0 profile-aware).
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const argv = process.argv.slice(2)
const pIdx = argv.indexOf('--profile')
const profile = pIdx >= 0 && argv[pIdx + 1] ? argv[pIdx + 1] : 'web'

const result = await build({
  entryPoints: ['src/bridge.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})

const code = result.outputFiles[0].text
// bridge.ts exports writeBridgeFiles etc. Load it as a module.
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const version = JSON.parse(readFileSync('./package.json', 'utf8')).version
const res = mod.writeBridgeFiles(undefined, version, profile)
if (res.error) {
  console.error('writeBridgeFiles ERROR:', res.error)
  process.exit(1)
}
const source = mod.bridgePluginSource()
console.log(
  'WROTE', res.pluginPath,
  '| changed:', res.changed,
  '| rewritten:', res.pluginRewritten,
  '| has pathOf:', source.includes('pathOf'),
)
