import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..', '..', '.obsidian', 'plugins', 'dsh-harness');
mkdirSync(pluginDir, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) {
  copyFileSync(resolve(here, f), resolve(pluginDir, f));
}
console.log('installed to', pluginDir);
