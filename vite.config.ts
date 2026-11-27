import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** After build, write the list of output files into dist/sw.js so the whole app works offline on first visit. */
function precache(): Plugin {
  return {
    name: 'precache-sw',
    apply: 'build',
    closeBundle() {
      const dist = 'dist';
      const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
      const files = walk(dist)
        .map((f) => '/' + relative(dist, f).split('\\').join('/'))
        .filter((f) => f !== '/sw.js' && f !== '/_headers' && !f.endsWith('.map'));
      const sw = join(dist, 'sw.js');
      const version = Date.now().toString(36);
      writeFileSync(sw, readFileSync(sw, 'utf8').replace('__PRECACHE__', JSON.stringify(['/', ...files])).replace('__VERSION__', version));
    },
  };
}

export default defineConfig({
  plugins: [precache()],
  build: { target: 'es2020', chunkSizeWarningLimit: 2000 },
});
