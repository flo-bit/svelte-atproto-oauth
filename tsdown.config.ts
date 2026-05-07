import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/server/index.ts',
		'src/server/stores/memory.ts',
		'src/server/stores/cloudflare.ts',
		'src/server/stores/upstash.ts',
		'src/client/index.ts',
		'src/browser/index.ts',
		'src/helper/index.ts',
		'src/bsky/index.ts',
		'src/bin/cli.ts'
	],
	format: 'esm',
	dts: true,
	deps: {
		neverBundle: [
			'$app/server',
			'$app/environment',
			'$app/state',
			'$app/navigation',
			'@sveltejs/kit',
			'svelte',
			'svelte/store'
		]
	}
});
