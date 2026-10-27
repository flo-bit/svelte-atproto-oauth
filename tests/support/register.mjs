import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Source-level integration tests with SvelteKit request context stubs. OAuth node
// tests use the real installed SDK; only transport and identity discovery are replaced.
const mocks = new Map([
	['$app/server', new URL('./svelte-context.mjs', import.meta.url).href],
	['$app/environment', new URL('./svelte-environment.mjs', import.meta.url).href],
	['@atcute/oauth-node-client', new URL('./node-sdk.mjs', import.meta.url).href],
	['@atcute/oauth-browser-client', new URL('./browser-sdk.mjs', import.meta.url).href]
]);
registerHooks({
	resolve(specifier, context, next) {
		if (mocks.has(specifier)) return { url: mocks.get(specifier), shortCircuit: true };
		if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
			const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
			if (existsSync(url)) return { url: url.href, shortCircuit: true };
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url.endsWith('.ts') && url.includes('/src/')) {
			const source = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.ESNext,
					verbatimModuleSyntax: true
				}
			}).outputText;
			return { format: 'module', source, shortCircuit: true };
		}
		return next(url, context);
	}
});
