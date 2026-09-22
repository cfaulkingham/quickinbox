import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const target = 'src/cloudflare-bindings.d.ts';
const result = spawnSync(
	'bunx',
	[
		'wrangler',
		'types',
		target,
		'--env-interface',
		'CloudflareBindings',
		'--include-runtime=false',
		'--strict-vars=false'
	],
	{ stdio: 'inherit' }
);
if (result.status !== 0) process.exit(result.status || 1);
// The deployment entry point is generated at build time. Bind RPC types to
// the source export so a clean checkout does not depend on build artifacts.
const generated = readFileSync(target, 'utf8').replaceAll(
	'../.svelte-kit/cloudflare/_worker',
	'./worker'
);
writeFileSync(target, generated);
