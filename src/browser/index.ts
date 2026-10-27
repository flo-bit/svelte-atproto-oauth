import { get, writable, type Readable } from 'svelte/store';
import {
	configureOAuth,
	createAuthorizationUrl,
	finalizeAuthorization,
	OAuthUserAgent,
	getSession,
	deleteStoredSession,
	TokenRefreshError,
	type Session
} from '@atcute/oauth-browser-client';
import { createActorResolver, type IdentityOptions } from '../network/index.js';
import { Client } from '@atcute/client';
import type { ActorIdentifier, Did } from '@atcute/lexicons';
import { dev } from '$app/environment';
import {
	hasCapability,
	hasScopes,
	normalizeScope,
	preservesScopes,
	safeReturnTo,
	upgradeScope,
	validateScope,
	type Capability,
	type PermissionSnapshot,
	type Scope
} from '../permissions/index.js';

const DEFAULT_STORAGE_KEY = 'atproto-current-login';
export interface BrowserAuthConfig extends IdentityOptions {
	origin: string;
	redirectPath?: string;
	metadataPath?: string;
	/** Declared scopes and default request. Override scope in login()/signup(). */
	scope?: Scope;
	signupPDS?: string;
	doh?: string;
	devPort?: number;
	/** Required for isolated profiles. Assert that CSP/test-harness egress controls are active.
	 * The browser SDK's metadata/token/resource fetches cannot use network.fetch. */
	assertBrowserEgress?: () => void;
}
const AUTHORIZATION_ERRORS = [
	'denied',
	'failed',
	'identity_mismatch',
	'reduced_grant',
	'stale_upgrade',
	'permissions_missing'
] as const;
export type AuthorizationError = (typeof AUTHORIZATION_ERRORS)[number];
export interface UserState {
	agent: OAuthUserAgent | null;
	client: Client | null;
	did: Did | null;
	isInitializing: boolean;
	isLoggedIn: boolean;
	permissions: PermissionSnapshot;
	authorizationError: AuthorizationError | null;
}
export interface ClientMetadata {
	client_id: string;
	redirect_uris: string[];
	scope: string;
	grant_types: string[];
	response_types: string[];
	token_endpoint_auth_method: 'none';
	application_type: 'web';
	dpop_bound_access_tokens: true;
}
export interface BrowserLoginOptions {
	scope?: Scope;
	returnTo?: string;
}
export interface BrowserPermissionOptions {
	returnTo?: string;
	requirements?: readonly Capability[];
	previousScope?: Scope;
}
export interface AtprotoBrowserAuth {
	user: Readable<UserState>;
	metadata: ClientMetadata;
	init(): Promise<void>;
	login(handleOrDid?: string, options?: BrowserLoginOptions): Promise<void>;
	signup(options?: BrowserLoginOptions): Promise<void>;
	logout(): Promise<void>;
	getPermissions(options?: { refresh?: boolean }): Promise<PermissionSnapshot>;
	can(capability: Capability, options?: { refresh?: boolean }): Promise<boolean>;
	requestPermissions(scope: Scope, options?: BrowserPermissionOptions): Promise<void>;
}
interface Flow {
	kind: 'svelte-atproto/browser-authorization';
	version: 1;
	requestedScope: string[];
	expectedDid?: Did;
	returnTo?: string;
	upgrade: boolean;
	/** Binds an upgrade to the login that initiated it, including across tabs. */
	sessionId?: string;
	additionalScope?: string[];
	previousGrant?: string[];
	requirements?: readonly Capability[];
}
const emptyPermissions = (): PermissionSnapshot => ({
	did: null,
	requestedScope: null,
	grantedScope: []
});
function parseFlow(value: unknown): Flow | null {
	if (!value || typeof value !== 'object') return null;
	const flow = value as Partial<Flow>;
	return flow.kind === 'svelte-atproto/browser-authorization' &&
		flow.version === 1 &&
		typeof flow.upgrade === 'boolean' &&
		Array.isArray(flow.requestedScope) &&
		flow.requestedScope.every((s) => typeof s === 'string')
		? (flow as Flow)
		: null;
}
function readJson(storage: Storage, key: string): unknown {
	try {
		return JSON.parse(storage.getItem(key) ?? 'null');
	} catch {
		return null;
	}
}

export function createAtprotoBrowserAuth(config: BrowserAuthConfig): AtprotoBrowserAuth {
	if (config.network?.isolated && typeof config.assertBrowserEgress !== 'function')
		throw new TypeError('Isolated browser OAuth requires assertBrowserEgress and external CSP/test-harness egress controls');
	function assertBrowserEgress() {
		if (config.network?.isolated) config.assertBrowserEgress!();
	}
	const identityResolver = createActorResolver(config);
	const storageKey = (key: string) => config.network?.cacheKey(key) ?? key;
	const STORAGE_KEY = storageKey(DEFAULT_STORAGE_KEY);
	const redirectPath = config.redirectPath ?? '/';
	const scope = normalizeScope(config.scope ?? 'atproto');
	validateScope(scope, scope);
	const metadata: ClientMetadata = {
		client_id: config.origin + (config.metadataPath ?? '/oauth-client-metadata.json'),
		redirect_uris: [config.origin + redirectPath],
		scope: scope.join(' '),
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web',
		dpop_bound_access_tokens: true
	};
	const historyKey = (did: string) => storageKey(`svelte-atproto:requested:${metadata.client_id}:${did}`);
	const sessionKey = (did: string) => storageKey(`svelte-atproto:session:${metadata.client_id}:${did}`);
	const pendingKey = storageKey(`svelte-atproto:pending:${metadata.client_id}`);
	const outcomeKey = storageKey(`svelte-atproto:outcome:${metadata.client_id}`);
	function withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
		const locks = globalThis.navigator?.locks;
		if (!locks) throw new Error('Web Locks API is unavailable; browser OAuth requires a secure context');
		// The SDK commits callbacks before returning. Hold an outer, cross-tab lock through
		// exchange + bookkeeping and through logout, never just around localStorage writes.
		// Match selected-account/SDK storage isolation, not an individual auth instance.
		return locks.request(storageKey('svelte-atproto:lifecycle'), operation);
	}
	const _user = writable<UserState>({
		agent: null,
		client: null,
		did: null,
		isInitializing: true,
		isLoggedIn: false,
		permissions: emptyPermissions(),
		authorizationError: null
	});
	let configured = false;
	let current: Session | null = null;
	let lastError: AuthorizationError | null = null;

	function ensureConfigured() {
		assertBrowserEgress();
		if (configured) return;
		const redirectUri = dev
			? `http://127.0.0.1:${config.devPort ?? 5173}${redirectPath}`
			: metadata.redirect_uris[0];
		configureOAuth({
			metadata: {
				client_id: dev
					? `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(metadata.scope)}`
					: metadata.client_id,
				redirect_uri: redirectUri
			},
			identityResolver,
			storageName: config.network ? storageKey('atcute-oauth') : undefined
		});
		configured = true;
	}
	function readHistory(did: string): string[] | null {
		const value = readJson(localStorage, historyKey(did)) as {
			version?: number;
			requestedScope?: unknown;
		} | null;
		return value?.version === 1 &&
			Array.isArray(value.requestedScope) &&
			value.requestedScope.every((s) => typeof s === 'string')
			? normalizeScope(value.requestedScope)
			: null;
	}
	function upgradeRejection(flow: Flow, did: Did | null): AuthorizationError | null {
		if (!did || did !== flow.expectedDid) return 'identity_mismatch';
		if (
			!flow.sessionId || flow.sessionId !== localStorage.getItem(sessionKey(did)) ||
			readHistory(did)?.some((s) => !flow.requestedScope.includes(s))
		) return 'stale_upgrade';
		return null;
	}
	function snapshot(session: Session): PermissionSnapshot {
		return {
			did: session.info.sub,
			requestedScope: readHistory(session.info.sub),
			grantedScope: normalizeScope(session.token.scope)
		};
	}
	function applySession(
		session: Session,
		authorizationError: AuthorizationError | null = lastError
	) {
		config.network?.assertUrl(session.info.aud);
		current = session;
		lastError = authorizationError;
		const agent = new OAuthUserAgent(session);
		_user.set({
			agent,
			client: new Client({ handler: agent }),
			did: session.info.sub,
			isInitializing: false,
			isLoggedIn: true,
			permissions: snapshot(session),
			authorizationError
		});
	}
	function clearSession(authorizationError: AuthorizationError | null = null) {
		current = null;
		lastError = authorizationError;
		_user.set({
			agent: null,
			client: null,
			did: null,
			isInitializing: false,
			isLoggedIn: false,
			permissions: emptyPermissions(),
			authorizationError
		});
	}
	async function resume(did: Did | null, authorizationError: AuthorizationError | null = null) {
		if (!did) {
			clearSession(authorizationError);
			return;
		}
		try {
			applySession(await getSession(did), authorizationError);
		} catch (e) {
			// Network/storage outages don't delete an otherwise recoverable session.
			if (e instanceof TokenRefreshError) {
				// localStorage is shared: another tab may have switched to a different account meanwhile.
				if (localStorage.getItem(STORAGE_KEY) === did) localStorage.removeItem(STORAGE_KEY);
				deleteStoredSession(did);
				localStorage.removeItem(historyKey(did));
				localStorage.removeItem(sessionKey(did));
			}
			clearSession(authorizationError ?? 'failed');
		}
	}
	function consumeReturnError(did: Did | null): AuthorizationError | null {
		const value = readJson(sessionStorage, outcomeKey) as {
			version?: unknown;
			did?: unknown;
			error?: unknown;
		} | null;
		sessionStorage.removeItem(outcomeKey);
		return value?.version === 1 && value.did === did &&
			AUTHORIZATION_ERRORS.some((error) => error === value.error)
			? value.error as AuthorizationError
			: null;
	}
	function finishReturn(flow: Flow | null) {
		sessionStorage.removeItem(pendingKey);
		sessionStorage.removeItem(outcomeKey);
		const returnTo = safeReturnTo(flow?.returnTo);
		if (
			returnTo &&
			returnTo !== window.location.pathname + window.location.search + window.location.hash
		) {
			// location.replace reloads the app. Deliver the fixed outcome once in this tab,
			// without leaking it to another client/profile or a subsequently switched account.
			if (lastError) sessionStorage.setItem(outcomeKey, JSON.stringify({
				version: 1, did: localStorage.getItem(STORAGE_KEY), error: lastError
			}));
			window.location.replace(returnTo);
		}
	}
	async function init(): Promise<void> {
		if (typeof window === 'undefined') {
			_user.update((s) => ({ ...s, isInitializing: false }));
			return;
		}
		return withLifecycleLock(initialize);
	}
	async function initialize(): Promise<void> {
		ensureConfigured();
		const params = new URLSearchParams(window.location.hash.slice(1));
		const did = localStorage.getItem(STORAGE_KEY) as Did | null;
		if (!params.has('code') && !params.has('error')) {
			await resume(did, consumeReturnError(did));
			return;
		}
		sessionStorage.removeItem(outcomeKey);
		const pending = parseFlow(readJson(sessionStorage, pendingKey));
		window.history.replaceState(null, '', window.location.pathname + window.location.search);
		let previous: Session | null = null;
		try {
			if (did) {
				try {
					previous = await getSession(did, { allowStale: true });
				} catch {
					/* A stale previous login must not prevent a new login. */
				}
			}
			const rejection = !pending
				? 'missing_pending'
				: pending.upgrade ? upgradeRejection(pending, did) : null;
			if (rejection) {
				// Without this tab's pending flow, we cannot check an upgrade before the SDK
				// replaces its stored session. Fail closed, including legacy unbound upgrades.
				const discarded = new URLSearchParams(params);
				discarded.delete('code');
				discarded.set('error', 'access_denied');
				await finalizeAuthorization(discarded).catch(() => {});
				throw new Error(rejection);
			}
			const { session, state } = await finalizeAuthorization(params);
			const flow = parseFlow(state);
			if (
				flow?.expectedDid &&
				(session.info.sub !== flow.expectedDid || (flow.upgrade && did !== flow.expectedDid))
			) {
				await new OAuthUserAgent(session).signOut().catch(() => {});
				deleteStoredSession(session.info.sub);
				throw new Error('identity_mismatch');
			}
			const staleFlow = flow?.upgrade ? upgradeRejection(flow, did) : null;
			if (staleFlow) {
				await new OAuthUserAgent(session).signOut().catch(() => {});
				deleteStoredSession(session.info.sub);
				throw new Error(staleFlow);
			}
			if (!normalizeScope(session.token.scope).includes('atproto')) {
				await new OAuthUserAgent(session).signOut().catch(() => {});
				deleteStoredSession(session.info.sub);
				throw new Error('missing_identity');
			}
			if (flow)
				localStorage.setItem(
					historyKey(session.info.sub),
					JSON.stringify({ version: 1, requestedScope: flow.requestedScope })
				);
			else localStorage.removeItem(historyKey(session.info.sub));
			localStorage.setItem(sessionKey(session.info.sub), flow?.upgrade ? flow.sessionId! : crypto.randomUUID());
			localStorage.setItem(STORAGE_KEY, session.info.sub);
			// SDK stores the callback session before returning it. A same-DID reduced grant cannot
			// safely be rolled back via its public API: expose the true new grant plus an error.
			const reduced =
				flow?.upgrade &&
				((flow.previousGrant && !preservesScopes(session.token.scope, flow.previousGrant)) ||
					(previous && !preservesScopes(session.token.scope, previous.token.scope)));
			const missing =
				flow?.upgrade &&
				(flow.requirements?.length
					? !flow.requirements.every((capability) => hasCapability(session.token.scope, capability))
					: !!flow.additionalScope &&
						hasScopes(flow.additionalScope, flow.additionalScope) &&
						!hasScopes(session.token.scope, flow.additionalScope));
			applySession(session, reduced ? 'reduced_grant' : missing ? 'permissions_missing' : null);
			finishReturn(flow);
		} catch (e) {
			const reason =
				e instanceof Error && ['identity_mismatch', 'stale_upgrade'].includes(e.message)
					? (e.message as AuthorizationError)
					: params.get('error') === 'access_denied'
						? 'denied'
						: 'failed';
			await resume(did, reason);
			finishReturn(pending);
		}
	}
	function normalizeHandle(input: string): ActorIdentifier {
		const value = input.trim().replace(/^@/, '');
		if (value.startsWith('did:') ? value.length < 6 : !value.includes('.') || value.length < 4)
			throw new TypeError('Provide a valid handle or DID');
		return value as ActorIdentifier;
	}
	async function navigate(
		target: { type: 'account'; identifier: ActorIdentifier } | { type: 'pds'; serviceUrl: string },
		options: BrowserLoginOptions,
		upgrade = false,
		details?: Pick<Flow, 'additionalScope' | 'requirements' | 'previousGrant'>
	) {
		ensureConfigured();
		if (target.type === 'pds') config.network?.assertUrl(target.serviceUrl);
		const requested = validateScope(options.scope ?? scope, scope);
		let sessionId: string | undefined;
		if (upgrade) {
			if (target.type !== 'account' || localStorage.getItem(STORAGE_KEY) !== target.identifier)
				throw new Error('Sign in before requesting permissions');
			// Legacy sessions acquire a generation without inventing request history.
			sessionId = localStorage.getItem(sessionKey(target.identifier)) ?? crypto.randomUUID();
			localStorage.setItem(sessionKey(target.identifier), sessionId);
		}
		const flow: Flow = {
			kind: 'svelte-atproto/browser-authorization',
			version: 1,
			requestedScope: requested,
			expectedDid:
				target.type === 'account' && target.identifier.startsWith('did:')
					? (target.identifier as Did)
					: undefined,
			returnTo: safeReturnTo(options.returnTo),
			upgrade,
			sessionId,
			...details
		};
		const url = await createAuthorizationUrl({
			target,
			scope: requested.join(' '),
			state: flow,
			prompt: target.type === 'pds' ? 'create' : undefined
		});
		config.network?.assertUrl(url);
		sessionStorage.removeItem(outcomeKey);
		sessionStorage.setItem(pendingKey, JSON.stringify(flow));
		// Allow the SDK's browser storage to flush before navigation.
		await new Promise((resolve) => setTimeout(resolve, 100));
		window.location.assign(url.toString());
	}
	async function login(handleOrDid?: string, options: BrowserLoginOptions = {}) {
		await withLifecycleLock(async () => {
			const identifier = handleOrDid ?? localStorage.getItem(STORAGE_KEY);
			if (!identifier) throw new TypeError('A handle is required when signed out');
			await navigate({ type: 'account', identifier: normalizeHandle(identifier) }, options);
		});
	}
	async function signup(options: BrowserLoginOptions = {}) {
		if (!config.signupPDS) throw new Error('Signup is not enabled');
		await withLifecycleLock(() => navigate({ type: 'pds', serviceUrl: config.signupPDS! }, options));
	}
	async function getPermissions(options: { refresh?: boolean } = {}): Promise<PermissionSnapshot> {
		if (!current) return emptyPermissions();
		return withLifecycleLock(() => readPermissions(options));
	}
	async function readPermissions(options: { refresh?: boolean } = {}): Promise<PermissionSnapshot> {
		if (!current) return emptyPermissions();
		if (localStorage.getItem(STORAGE_KEY) !== current.info.sub) {
			clearSession();
			return emptyPermissions();
		}
		assertBrowserEgress();
		const session = await getSession(
			current.info.sub,
			options.refresh ? { noCache: true } : undefined
		);
		const next = snapshot(session);
		// Only notify subscribers on change, so can() inside an effect that reads the store can't loop.
		if (
			current?.info.sub !== session.info.sub ||
			current.token.access !== session.token.access ||
			JSON.stringify(get(_user).permissions) !== JSON.stringify(next)
		)
			applySession(session);
		else current = session;
		return next;
	}
	async function can(capability: Capability, options: { refresh?: boolean } = {}) {
		return hasCapability((await getPermissions(options)).grantedScope, capability);
	}
	async function requestPermissions(additional: Scope, options: BrowserPermissionOptions = {}) {
		return withLifecycleLock(() => upgradePermissions(additional, options));
	}
	async function upgradePermissions(additional: Scope, options: BrowserPermissionOptions) {
		const permissions = await readPermissions();
		if (!permissions.did) throw new Error('Sign in before requesting permissions');
		if (!normalizeScope(additional).length) throw new TypeError('At least one scope is required');
		validateScope(['atproto', ...normalizeScope(additional)], scope);
		const satisfied = options.requirements?.length
			? options.requirements.every((c) => hasCapability(permissions.grantedScope, c))
			: hasScopes(permissions.grantedScope, additional);
		if (satisfied) return;
		const requested = upgradeScope({
			declared: scope,
			requested: permissions.requestedScope,
			granted: permissions.grantedScope,
			additional,
			previousScope: options.previousScope
		});
		await navigate(
			{ type: 'account', identifier: permissions.did as Did },
			{ scope: requested, returnTo: options.returnTo },
			true,
			{
				additionalScope: normalizeScope(additional),
				previousGrant: permissions.grantedScope,
				requirements: options.requirements
			}
		);
	}
	async function logout() {
		return withLifecycleLock(async () => {
			ensureConfigured();
			// A queued callback (possibly in another tab) may have replaced current.
			const did = (localStorage.getItem(STORAGE_KEY) as Did | null) ?? current?.info.sub;
			if (did) {
				try {
					const session = await getSession(did, { allowStale: true });
					await new OAuthUserAgent(session).signOut();
				} catch {
					deleteStoredSession(did);
				}
				localStorage.removeItem(historyKey(did));
				localStorage.removeItem(sessionKey(did));
			}
			localStorage.removeItem(STORAGE_KEY);
			sessionStorage.removeItem(pendingKey);
			sessionStorage.removeItem(outcomeKey);
			clearSession();
		});
	}
	return {
		user: { subscribe: _user.subscribe },
		metadata,
		init,
		login,
		signup,
		logout,
		getPermissions,
		can,
		requestPermissions
	};
}

export type { Capability, PermissionSnapshot, Scope } from '../permissions/index.js';
