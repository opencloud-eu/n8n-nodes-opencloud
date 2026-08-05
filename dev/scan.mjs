// Reproduces the n8n creators gate (@n8n/scan-community-package) locally and
// in CI, so ESLint violations that only that scan enforces fail the build
// BEFORE publish instead of after. The published scan can only run on an
// already-published package (it downloads the npm artifact and fetches the
// provenance-attested GitHub source), so it can't gate a PR — but its ruleset
// can. We import the scanner's own `analyzePackage` + file patterns to stay
// bit-for-bit identical to what n8n runs: the same flat config, the same
// `allowInlineConfig: false`, the same `{nodes,credentials}` + package.json glob.
//
// Two legs, mirroring scanner.mjs:
//   - source: the working tree (what the scan lints on the attested source)
//   - dist:   the packed publishable tarball's compiled .js + package.json
import { analyzePackage, SOURCE_FILE_PATTERNS } from '@n8n/scan-community-package/scanner/scanner.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();

function report(name, res) {
	if (res.passed) {
		console.log(`✅ scan (${name}): no problems`);
		return true;
	}
	console.error(`❌ scan (${name}): ${res.message}`);
	if (res.details) console.error(res.details);
	return false;
}

// Source leg — same rules the scan runs against the attested GitHub source.
const source = await analyzePackage(root, SOURCE_FILE_PATTERNS);

// Dist leg — pack the publishable tarball (respects package.json `files`) and
// lint compiled .js + package.json, exactly as the scan does on the npm artifact.
const staging = mkdtempSync(join(tmpdir(), 'oc-scan-'));
const pack = spawnSync('npm', ['pack', '--pack-destination', staging], {
	cwd: root,
	encoding: 'utf8',
});
if (pack.status !== 0) {
	console.error('npm pack failed:', pack.stderr);
	process.exit(1);
}
const tgz = join(staging, pack.stdout.trim().split('\n').pop());
const untar = spawnSync('tar', ['-xzf', tgz, '-C', staging], { encoding: 'utf8' });
if (untar.status !== 0) {
	console.error('tar extraction failed:', untar.stderr);
	process.exit(1);
}
const dist = await analyzePackage(join(staging, 'package'), ['**/*.js', 'package.json']);

const ok = [report('source', source), report('dist', dist)].every(Boolean);
process.exit(ok ? 0 : 1);
