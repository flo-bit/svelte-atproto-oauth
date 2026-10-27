import type { Did } from '@atcute/lexicons';
import type { StoredSession, Store } from '@atcute/oauth-node-client';
import {
	normalizeScope,
	preservesScopes,
	type Capability,
	type Scope
} from '../permissions/index.js';
import type { RequestLock } from './lock.js';

export interface AuthorizationHistory {
	version: 1;
	requestedScope: string[];
}
export type SessionWithHistory = StoredSession & {
	svelteAtproto?: AuthorizationHistory;
	/** Login generation: survives refreshes/upgrades, but not logout or a new login. */
	svelteAtprotoSessionId?: string;
};

/** Stored inside the OAuth library's single-use state, not a shared browser cookie. */
export interface AuthorizationState {
	kind: 'svelte-atproto/authorization';
	version: 1;
	requestedScope: string[];
	returnTo?: string;
	expectedDid?: Did;
	upgrade: boolean;
	/** Binds an upgrade to the login that initiated it, not just to its DID. */
	sessionId?: string;
	additionalScope?: string[];
	previousGrant?: string[];
	requirements?: readonly Capability[];
}

export function authorizationState(value: unknown): AuthorizationState | null {
	if (!value || typeof value !== 'object') return null;
	const state = value as Partial<AuthorizationState>;
	if (
		state.kind !== 'svelte-atproto/authorization' ||
		state.version !== 1 ||
		typeof state.upgrade !== 'boolean' ||
		!Array.isArray(state.requestedScope) ||
		state.requestedScope.some((s) => typeof s !== 'string')
	)
		return null;
	return state as AuthorizationState;
}

export function requestedScope(value: SessionWithHistory | undefined): string[] | null {
	const history = value?.svelteAtproto;
	return history?.version === 1 &&
		Array.isArray(history.requestedScope) &&
		history.requestedScope.every((s) => typeof s === 'string')
		? normalizeScope(history.requestedScope)
		: null;
}

export class AuthorizationUpgradeError extends Error {
	constructor(
		public readonly reason:
			| 'identity_mismatch'
			| 'stale_upgrade'
			| 'reduced_grant'
			| 'missing_identity'
	) {
		super(`Authorization failed: ${reason}`);
		this.name = 'AuthorizationUpgradeError';
	}
}

/** Decorates the existing adapter; extra metadata survives SDK refreshes without another store. */
export function authorizationSessions(
	store: Store<Did, StoredSession>,
	flow?: AuthorizationState | null,
	lock?: RequestLock
): Store<Did, StoredSession> {
	return {
		get: (did) => store.get(did),
		delete: (did) => store.delete(did),
		clear: () => store.clear(),
		async set(did, session) {
			const commit = async () => {
				let previous: SessionWithHistory | undefined;
				try {
					previous = (await store.get(did)) as SessionWithHistory | undefined;
				} catch (e) {
					// A refresh has already spent the old refresh token, and a failed set makes the SDK
					// revoke the new one. Losing history (recoverable via previousScope) is the lesser harm.
					if (flow !== undefined) throw e;
				}
				if (flow) {
					if (flow.expectedDid && did !== flow.expectedDid)
						throw new AuthorizationUpgradeError('identity_mismatch');
					if (!normalizeScope(session.tokenSet.scope).includes('atproto'))
						throw new AuthorizationUpgradeError('missing_identity');
					if (flow.upgrade) {
						// The incoming cookie may predate logout. Check the stored login generation
						// under the commit lock, including when the same DID has logged in again.
						if (!previous || !flow.sessionId || previous.svelteAtprotoSessionId !== flow.sessionId)
							throw new AuthorizationUpgradeError('stale_upgrade');
						const history = requestedScope(previous);
						// A newer upgrade may have completed since this flow began. Never silently lose its request tokens.
						if (history && history.some((s) => !flow.requestedScope.includes(s)))
							throw new AuthorizationUpgradeError('stale_upgrade');
						if (
							(flow.previousGrant &&
								!preservesScopes(session.tokenSet.scope, flow.previousGrant)) ||
							(previous && !preservesScopes(session.tokenSet.scope, previous.tokenSet.scope))
						)
							throw new AuthorizationUpgradeError('reduced_grant');
					}
					await store.set(did, {
						...session,
						svelteAtproto: { version: 1, requestedScope: flow.requestedScope },
						svelteAtprotoSessionId: flow.upgrade ? flow.sessionId! : crypto.randomUUID()
					} as SessionWithHistory);
				} else if (flow === null) {
					// Legacy in-flight callback: its original request is unknown, unlike a refresh.
					const { svelteAtproto: _history, ...withoutHistory } = session as SessionWithHistory;
					await store.set(did, { ...withoutHistory, svelteAtprotoSessionId: crypto.randomUUID() } as SessionWithHistory);
				} else {
					await store.set(did, {
						...session,
						...(previous?.svelteAtproto ? { svelteAtproto: previous.svelteAtproto } : {}),
						...(previous?.svelteAtprotoSessionId
							? { svelteAtprotoSessionId: previous.svelteAtprotoSessionId } : {})
					} as SessionWithHistory);
				}
			};
			// SDK refresh already holds this lock; callback commits do not.
			if (flow !== undefined && lock) await lock(`oauth-session-${did}`, commit);
			else await commit();
		}
	};
}

/** Migrates only the signed legacy cookie belonging to this restored DID, not today's config. */
export async function migrateRequestedScope(
	store: Store<Did, StoredSession>,
	did: Did,
	legacy: Scope
): Promise<void> {
	const stored = (await store.get(did)) as SessionWithHistory | undefined;
	if (stored && requestedScope(stored) === null) {
		await store.set(did, {
			...stored,
			svelteAtproto: { version: 1, requestedScope: normalizeScope(legacy) }
		} as SessionWithHistory);
	}
}
