import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'module';

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  platform: 'browser',
});

if (prod) {
  await context.rebuild();
  context.dispose();
} else {
  await context.watch();
}
