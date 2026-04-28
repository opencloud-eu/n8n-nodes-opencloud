// Replacement for `n8n-node build` that:
//   1. Copies static files BEFORE tsc, not after — so when N8N_DEV_RELOAD
//      sees the new .js, SVGs are already on disk (no icon-404 race).
//   2. Empties dist/ in place instead of removing-and-recreating the dir,
//      so docker bind mounts pointing at dist/ stay valid (rimraf-ing the
//      dir itself severs the mount; the container ends up pointing at a
//      now-gone inode and can't see any of the new files).
//
// Step order: empty dist/* → copy statics → tsc → emit dist files.
//
// Same glob pattern as @n8n/node-cli's copyStaticFiles.

import { rimraf } from 'rimraf';
import fg from 'fast-glob';
import { mkdir, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('dist')) {
	// Glob expansion deletes the children, leaving dist/ itself intact.
	await rimraf('dist/*', { glob: true });
} else {
	await mkdir('dist', { recursive: true });
}

const staticFiles = fg.sync(['**/*.{png,svg}', '**/__schema__/**/*.json'], {
	ignore: ['dist/**', 'node_modules/**'],
});
for (const file of staticFiles) {
	const dest = join('dist', file);
	await mkdir(dirname(dest), { recursive: true });
	await cp(file, dest, { recursive: true });
}

const tsc = spawnSync('tsc', [], { stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status);
