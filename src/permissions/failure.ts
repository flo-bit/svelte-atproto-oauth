/**
 * Recognize an explicit insufficient-scope failure in an atcute result/error or fetch Response.
 * Does not read response bodies, infer scopes, navigate, or retry. Generic 401/403 errors return false.
 */
export function needsPermissions(result: unknown): boolean {
	if (!result || typeof result !== 'object') return false;
	try {
		const response = result as {
			ok?: unknown;
			status?: unknown;
			data?: { error?: unknown } | null;
			error?: unknown;
			headers?: { get?: (name: string) => unknown } | null;
		};
		if (response.ok === true || (response.status !== 401 && response.status !== 403)) return false;
		const code = response.data?.error ?? response.error;
		if (code === 'insufficient_scope' || code === 'InsufficientScope') return true;
		const header = response.headers?.get?.('www-authenticate');
		return typeof header === 'string' && insufficientScopeChallenge(header);
	} catch {
		// Unrecognized/malformed input is not evidence of missing permissions.
		return false;
	}
}

/** Split challenges/parameters without treating commas inside quoted values as separators. */
function fields(header: string): string[] {
	const result: string[] = [];
	let start = 0;
	let quoted = false;
	let escaped = false;
	for (let i = 0; i < header.length; i++) {
		const char = header[i];
		if (escaped) escaped = false;
		else if (quoted && char === '\\') escaped = true;
		else if (char === '"') quoted = !quoted;
		else if (!quoted && char === ',') {
			result.push(header.slice(start, i).trim());
			start = i + 1;
		}
	}
	if (quoted || escaped) return [];
	result.push(header.slice(start).trim());
	return result;
}

function insufficientScopeChallenge(header: string): boolean {
	let supported = false;
	let errors: string[] = [];
	const missing = () => supported && errors.length === 1 && errors[0] === 'insufficient_scope';
	for (let field of fields(header)) {
		if (!/^[\w-]+\s*=/.test(field)) {
			if (missing()) return true;
			const challenge = /^([a-z][a-z0-9-]*)(?:[ \t]+(.*))?$/i.exec(field);
			supported = !!challenge && /^(?:Bearer|DPoP)$/i.test(challenge[1]);
			errors = [];
			field = challenge?.[2] ?? '';
		}
		const parameter = /^error\s*=\s*(?:"((?:\\.|[^"\\])*)"|([\w.-]+))$/i.exec(field);
		if (parameter) errors.push(parameter[1]?.replace(/\\(.)/g, '$1') ?? parameter[2]);
	}
	return missing();
}
