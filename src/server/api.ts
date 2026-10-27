import { error, isHttpError } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import type { ActorIdentifier, Did } from '@atcute/lexicons';
import type { Client } from '@atcute/client';
import type { OAuthSession } from '@atcute/oauth-node-client';
import { createOAuthClient } from './oauth.js';
import { getSignedCookie } from './cookie.js';
import { clearAuthCookies, COOKIE_DID } from './cookies.js';
import {
	requestedScope,
	type AuthorizationState,
	type SessionWithHistory
} from './authorization.js';
import {
	hasCapability,
	hasScopes,
	normalizeScope,
	safeReturnTo,
	upgradeScope,
	validateScope,
	type Capability,
	type PermissionSnapshot,
	type Scope
} from '../permissions/index.js';
import type { ResolvedConfig } from './config.js';
import { clientRequestLock } from './lock.js';

export interface CurrentSession {
	did: Did | null;
	session: OAuthSession | null;
	client: Client | null;
}

export interface LoginInput {
	handle?: string;
	signup?: boolean;
	/** Exact request; defaults to the configured scope. No implicit merging. */
	scope?: Scope;
	/** Local absolute path. Bound to this individual authorization flow. */
	returnTo?: string;
}

export interface PermissionInput {
	/** Additional request tokens. Permission-set references are kept intact. */
	scope: Scope;
	returnTo?: string;
	/** Concrete feature requirements, especially when requesting an include: scope. */
	requirements?: readonly Capability[];
	/** Explicit recovery for legacy sessions whose original request cannot be reconstructed. */
	previousScope?: Scope;
}

export function createApi(config: ResolvedConfig) {
	async function authorize(
		input: LoginInput,
		upgrade = false,
		details?: Pick<AuthorizationState, 'additionalScope' | 'requirements' | 'previousGrant'>
	): Promise<{ url: string }> {
		const event = getRequestEvent();
		if (input.signup && !config.signupPDS) error(403, 'Signup is not enabled');
		const scope = validateScope(input.scope ?? config.scope, config.scope);
		const currentDid = (await getSignedCookie(
			event.cookies,
			COOKIE_DID,
			config.cookieSecret
		)) as Did | null;
		const identifier = input.handle ?? currentDid;
		if (!input.signup && !identifier) error(400, 'A handle is required when signed out');
		if (upgrade && (!currentDid || identifier !== currentDid))
			error(401, 'Sign in before requesting permissions');
		const sessionId = upgrade
			? await clientRequestLock(config)(`oauth-session-${currentDid}`, async () => {
				const store = config.resolveSessions();
				const stored = await store.get(currentDid!) as SessionWithHistory | undefined;
				if (!stored) error(401, 'Sign in before requesting permissions');
				if (stored.svelteAtprotoSessionId) return stored.svelteAtprotoSessionId;
				// Legacy sessions can gain a generation without claiming known scope history.
				const id = crypto.randomUUID();
				await store.set(currentDid!, { ...stored, svelteAtprotoSessionId: id } as SessionWithHistory);
				return id;
			})
			: undefined;
		const flow: AuthorizationState = {
			kind: 'svelte-atproto/authorization',
			version: 1,
			requestedScope: scope,
			returnTo: safeReturnTo(input.returnTo),
			expectedDid:
				!input.signup && (!input.handle || upgrade) ? (currentDid ?? undefined) : undefined,
			upgrade,
			sessionId,
			...details
		};
		const oauth = createOAuthClient(config);
		const target = input.signup
			? ({ type: 'pds', serviceUrl: config.signupPDS! } as const)
			: ({ type: 'account', identifier: identifier as ActorIdentifier } as const);
		const { url } = await oauth.authorize({
			target,
			scope: scope.join(' '),
			state: flow,
			prompt: input.signup ? 'create' : undefined
		});
		config.identity.network?.assertUrl(url);
		return { url: url.toString() };
	}

	async function startLogin(input: LoginInput = {}): Promise<{ url: string }> {
		try {
			validateScope(input.scope ?? config.scope, config.scope);
		} catch (e) {
			error(400, e instanceof TypeError ? e.message : 'Invalid requested scope');
		}
		try {
			return await authorize(input);
		} catch (e) {
			if (isHttpError(e)) throw e;
			// Never expose an upstream error containing an authorization URL or token.
			error(400, 'Unable to start authorization');
		}
	}

	function getSession(): CurrentSession {
		const locals = getRequestEvent().locals as unknown as CurrentSession;
		return {
			did: locals.did ?? null,
			session: locals.session ?? null,
			client: locals.client ?? null
		};
	}

	async function getPermissions(options: { refresh?: boolean } = {}): Promise<PermissionSnapshot> {
		const { did, session } = getSession();
		if (!did || !session) return { did: null, requestedScope: null, grantedScope: [] };
		const token = await session.getTokenInfo(options.refresh ? true : 'auto');
		const stored = (await config.resolveSessions().get(did)) as SessionWithHistory | undefined;
		return {
			did,
			requestedScope: requestedScope(stored),
			grantedScope: normalizeScope(token.scope)
		};
	}

	async function can(
		capability: Capability,
		options: { refresh?: boolean } = {}
	): Promise<boolean> {
		return hasCapability((await getPermissions(options)).grantedScope, capability);
	}

	async function requestPermissions(input: PermissionInput): Promise<{ url: string | null }> {
		const snapshot = await getPermissions();
		if (!snapshot.did) error(401, 'Sign in before requesting permissions');
		const additional = normalizeScope(input.scope);
		if (!additional.length) error(400, 'At least one scope is required');
		validateScope(['atproto', ...additional], config.scope);
		// An include: reference alone is never considered proof of its current contents.
		const satisfied = input.requirements?.length
			? input.requirements.every((c) => hasCapability(snapshot.grantedScope, c))
			: hasScopes(snapshot.grantedScope, additional);
		if (satisfied) return { url: null };
		const scope = upgradeScope({
			declared: config.scope,
			requested: snapshot.requestedScope,
			granted: snapshot.grantedScope,
			additional,
			previousScope: input.previousScope
		});
		try {
			return await authorize({ scope, returnTo: input.returnTo }, true, {
				additionalScope: additional,
				previousGrant: snapshot.grantedScope,
				requirements: input.requirements
			});
		} catch (e) {
			if (isHttpError(e)) throw e;
			// Same as startLogin: upstream errors may contain an authorization URL or token.
			error(400, 'Unable to start authorization');
		}
	}

	async function logout(): Promise<{ ok: true }> {
		const event = getRequestEvent();
		const did = (await getSignedCookie(
			event.cookies,
			COOKIE_DID,
			config.cookieSecret
		)) as Did | null;
		if (did) {
			try {
				await clientRequestLock(config)(`oauth-session-${did}`, async () => {
					try {
						// Hold the lock through deletion; the SDK's nested read must not reacquire it.
						await createOAuthClient(config, undefined, (_name, operation) => operation()).revoke(did);
					} finally {
						// Even failed remote revocation must invalidate local pending upgrades.
						await config.resolveSessions().delete(did);
					}
				});
			} catch {
				console.warn('atproto-oauth: session revocation failed');
			}
		}
		clearAuthCookies(event.cookies);
		return { ok: true };
	}

	return { startLogin, logout, getSession, getPermissions, can, requestPermissions };
}

export type Api = ReturnType<typeof createApi>;
