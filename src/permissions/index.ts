import { isDid, isNsid } from '@atcute/lexicons/syntax';

export { needsPermissions } from './failure.js';

export type Scope = string | readonly string[];
export type Capability =
	| { type: 'repo'; collection: string; action: 'create' | 'update' | 'delete' }
	| { type: 'blob'; mimeType: string }
	| { type: 'rpc'; lxm: string; aud: string }
	| { type: 'account'; attr: 'email' | 'repo' | 'status'; action?: 'read' | 'manage' }
	| { type: 'identity'; attr: 'handle' | '*' };

export interface PermissionSnapshot {
	did: string | null;
	/** Original request tokens, including include: references; null for unknown legacy history. */
	requestedScope: string[] | null;
	/** Current token's grant. Never inferred from configuration or a permission-set document. */
	grantedScope: string[];
}

export class PermissionHistoryUnavailableError extends Error {
	constructor() {
		super(
			'Previous requested scopes are unknown. Supply previousScope explicitly, or startLogin with the complete desired scope.'
		);
		this.name = 'PermissionHistoryUnavailableError';
	}
}

/** Normalize without rewriting tokens: client metadata matching can be exact. */
export function normalizeScope(scope: Scope): string[] {
	if (
		typeof scope !== 'string' &&
		(!Array.isArray(scope) || scope.some((s) => typeof s !== 'string'))
	) {
		throw new TypeError('scope must be a string or an array of strings');
	}
	return [
		...new Set(
			(typeof scope === 'string' ? [scope] : scope).flatMap((s) => s.split(/\s+/).filter(Boolean))
		)
	];
}

export function validateScope(scope: Scope, declared: Scope): string[] {
	const tokens = normalizeScope(scope);
	const allowed = new Set(normalizeScope(declared));
	if (!tokens.includes('atproto')) throw new TypeError('scope must include atproto');
	for (const token of tokens) {
		if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(token))
			throw new TypeError('Invalid OAuth scope token');
		if (!allowed.has(token))
			throw new TypeError(`Requested scope is not declared in client metadata: ${token}`);
	}
	return tokens;
}

const repoActions = ['create', 'update', 'delete'];
const mime = /^(?:[a-zA-Z0-9!#$&^_.+-]+|\*)\/(?:[a-zA-Z0-9!#$&^_.+-]+|\*)$/;
const validMime = (s: string) => mime.test(s) && (!s.startsWith('*/') || s === '*/*');
const audience = (s: string) => {
	const parts = s.split('#');
	return parts.length === 2 && isDid(parts[0]) && /^[a-zA-Z][a-zA-Z0-9._:-]*$/.test(parts[1]);
};

type Parsed = { resource: string; params: Map<string, string[]> };
const definitions: Record<string, { positional: string; keys: string[] }> = {
	repo: { positional: 'collection', keys: ['collection', 'action'] },
	rpc: { positional: 'lxm', keys: ['lxm', 'aud'] },
	blob: { positional: 'accept', keys: ['accept'] },
	account: { positional: 'attr', keys: ['attr', 'action'] },
	identity: { positional: 'attr', keys: ['attr'] }
};

/** Unknown parameters may attenuate access: ignore the entire token, not just those parameters. */
function parse(token: string): Parsed | null {
	try {
		if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(token) || /%(?![\da-f]{2})/i.test(token)) return null;
		const match = /^([a-z]+)(?::([^?]*))?(?:\?(.*))?$/.exec(token);
		if (!match) return null;
		const [, resource, positional, query] = match;
		const definition = definitions[resource];
		if (!definition) return null;
		const params = new Map<string, string[]>();
		if (positional !== undefined)
			params.set(definition.positional, [decodeURIComponent(positional)]);
		if (query) {
			for (const pair of query.split('&')) {
				const split = pair.indexOf('=');
				if (split < 1) return null;
				// Scope percent decoding is not HTML form decoding: '+' stays '+'.
				const key = decodeURIComponent(pair.slice(0, split));
				const value = decodeURIComponent(pair.slice(split + 1));
				if (
					!definition.keys.includes(key) ||
					!value ||
					(positional !== undefined && key === definition.positional)
				)
					return null;
				params.set(key, [...(params.get(key) ?? []), value]);
			}
		}
		const primary = params.get(definition.positional);
		if (!primary?.length || primary.some((s) => !s)) return null;
		const one = (key: string) => !params.has(key) || params.get(key)!.length === 1;
		if (resource === 'repo' || resource === 'rpc') {
			if (primary.some((s) => s !== '*' && !isNsid(s))) return null;
		}
		if (resource === 'repo' && params.get('action')?.some((s) => !repoActions.includes(s)))
			return null;
		if (resource === 'rpc') {
			const aud = params.get('aud');
			if (
				!aud ||
				!one('aud') ||
				(aud[0] !== '*' && !audience(aud[0])) ||
				(aud[0] === '*' && primary.includes('*'))
			)
				return null;
		}
		if (resource === 'blob' && primary.some((s) => !validMime(s))) return null;
		if (
			resource === 'account' &&
			(!one('attr') ||
				!one('action') ||
				!['email', 'repo', 'status'].includes(primary[0]) ||
				params.get('action')?.some((s) => !['read', 'manage'].includes(s)))
		)
			return null;
		if (resource === 'identity' && (!one('attr') || !['handle', '*'].includes(primary[0])))
			return null;
		return { resource, params };
	} catch {
		return null;
	}
}

function mimeCovers(granted: string, needed: string): boolean {
	if (!validMime(needed)) return false;
	return (
		granted === '*/*' ||
		granted === needed ||
		(granted.endsWith('/*') && granted.split('/')[0] === needed.split('/')[0])
	);
}

function matches(parsed: Parsed, capability: Capability): boolean {
	const { resource, params } = parsed;
	if (resource !== capability.type) return false;
	const contains = (key: string, needed: string) =>
		params.get(key)?.some((s) => s === '*' || s === needed) ?? false;
	switch (capability.type) {
		case 'repo':
			return (
				isNsid(capability.collection) &&
				repoActions.includes(capability.action) &&
				contains('collection', capability.collection) &&
				(params.get('action') ?? repoActions).includes(capability.action)
			);
		case 'rpc':
			return (
				isNsid(capability.lxm) &&
				audience(capability.aud) &&
				contains('lxm', capability.lxm) &&
				contains('aud', capability.aud)
			);
		case 'blob':
			return params.get('accept')!.some((s) => mimeCovers(s, capability.mimeType));
		case 'identity':
			return ['handle', '*'].includes(capability.attr) && contains('attr', capability.attr);
		case 'account': {
			const action = capability.action ?? 'read';
			return (
				['email', 'repo', 'status'].includes(capability.attr) &&
				['read', 'manage'].includes(action) &&
				contains('attr', capability.attr) &&
				((params.get('action')?.[0] ?? 'read') === 'manage' || action === 'read')
			);
		}
	}
}

/** Conservative, advisory check. include: and transitional scopes are deliberately not expanded. */
export function hasCapability(granted: Scope, capability: Capability): boolean {
	return normalizeScope(granted).some((token) => {
		const parsed = parse(token);
		return parsed !== null && matches(parsed, capability);
	});
}

function coversParsed(granted: Parsed[], needed: Parsed): boolean {
	const { resource, params } = needed;
	const compatible = granted.filter((p) => p.resource === resource);
	const includes = (p: Parsed, key: string, value: string) =>
		p.params.get(key)?.some((s) => s === '*' || s === value) ?? false;
	if (resource === 'repo') {
		return params
			.get('collection')!
			.every((collection) =>
				(params.get('action') ?? repoActions).every((action) =>
					compatible.some(
						(p) =>
							includes(p, 'collection', collection) &&
							(p.params.get('action') ?? repoActions).includes(action)
					)
				)
			);
	}
	if (resource === 'rpc')
		return params
			.get('lxm')!
			.every((lxm) =>
				compatible.some((p) => includes(p, 'lxm', lxm) && includes(p, 'aud', params.get('aud')![0]))
			);
	if (resource === 'blob')
		return params
			.get('accept')!
			.every((accept) =>
				compatible.some((p) => p.params.get('accept')!.some((s) => mimeCovers(s, accept)))
			);
	if (resource === 'identity')
		return compatible.some((p) => includes(p, 'attr', params.get('attr')![0]));
	if (resource === 'account')
		return compatible.some(
			(p) =>
				includes(p, 'attr', params.get('attr')![0]) &&
				((p.params.get('action')?.[0] ?? 'read') === 'manage' ||
					(params.get('action')?.[0] ?? 'read') === 'read')
		);
	return false;
}

/** Check concrete scope requirements. Permission-set references and unknown tokens return false. */
export function hasScopes(granted: Scope, required: Scope): boolean {
	return scopeCovers(granted, required, false);
}

/** Internal conservation check: opaque tokens can only be preserved by exact equality. */
export function preservesScopes(granted: Scope, previous: Scope): boolean {
	return scopeCovers(granted, previous, true);
}

function scopeCovers(granted: Scope, required: Scope, preserveOpaque: boolean): boolean {
	const grant = normalizeScope(granted);
	const parsedGrant = grant.map(parse).filter((p): p is Parsed => p !== null);
	return normalizeScope(required).every((token) => {
		if (token === 'atproto') return grant.includes(token);
		const parsed = parse(token);
		return parsed ? coversParsed(parsedGrant, parsed) : preserveOpaque && grant.includes(token);
	});
}

/** Build an explicit union of request tokens, never the expansion of a permission set. */
export function upgradeScope(input: {
	declared: Scope;
	requested: Scope | null;
	granted: Scope;
	additional: Scope;
	previousScope?: Scope;
}): string[] {
	const allowed = normalizeScope(input.declared);
	let previous =
		input.previousScope !== undefined
			? normalizeScope(input.previousScope)
			: input.requested === null
				? null
				: normalizeScope(input.requested);
	if (previous === null) {
		// A legacy direct grant can be reconstructed only if its exact tokens are still declared.
		previous = normalizeScope(input.granted).filter((s) => allowed.includes(s));
		if (
			!preservesScopes(previous, input.granted) ||
			previous.some((s) => s.startsWith('include:') || s.startsWith('include?'))
		)
			throw new PermissionHistoryUnavailableError();
	}
	return validateScope(['atproto', ...previous, ...normalizeScope(input.additional)], allowed);
}

/** Only local absolute paths; rejects browser URL normalization / backslash redirect tricks. */
export function safeReturnTo(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	try {
		const decoded = decodeURIComponent(value);
		if (
			!value.startsWith('/') ||
			!decoded.startsWith('/') ||
			decoded.startsWith('//') ||
			/[\\\x00-\x1f\x7f]/.test(decoded) ||
			/[\x00-\x20\x7f]/.test(value)
		)
			return undefined;
		if (new URL(value, 'https://return.invalid').origin !== 'https://return.invalid')
			return undefined;
		return value;
	} catch {
		return undefined;
	}
}
