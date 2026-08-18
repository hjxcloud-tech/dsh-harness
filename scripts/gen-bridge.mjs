// Regenerate ~/.dsh/profiles/web/dsh-obsidian-bridge.mjs from current src/bridge.ts.
// Bundles bridge.ts (its imports are node builtins + ./i18n) and calls bridgePluginSource().
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const home = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
const dir = join(home, 'profiles', 'web')

const result = await build({
  entryPoints: ['src/bridge.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
})

const code = result.outputFiles[0].text
// bridge.ts exports bridgePluginSource etc. Load it as a module.
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const source = mod.bridgePluginSource()

mkdirSync(dir, { recursive: true })
const target = join(dir, 'dsh-obsidian-bridge.mjs')
writeFileSync(target, source, 'utf8')
console.log('WROTE', target, source.length, 'bytes; has pathOf:', source.includes('pathOf'))
