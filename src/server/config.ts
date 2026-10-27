import {
	MemoryStore,
	type Store,
	type StoredSession,
	type StoredState
} from '@atcute/oauth-node-client';
import type { Did } from '@atcute/lexicons';
import { dev } from '$app/environment';
import { normalizeScope, validateScope } from '../permissions/index.js';
import { localRequestLock, type RequestLock } from './lock.js';
import { createActorResolver, networkFetch, type IdentityOptions } from '../network/index.js';

export type SessionsStore = Store<Did, StoredSession>;
export type StatesStore = Store<string, StoredState>;

// Loose accepted shape at the user boundary. Adapter factories like
// `memory()` / `cloudflareKV()` return `Store<string, unknown>` when no
// type parameters are specified; we accept any compatible store and cast
// internally when handing off to atcute's strict `OAuthClientStores`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStore = Store<string, any>;

/**
 * A store value, a factory returning a store, or a factory returning
 * undefined to fall back to the library's in-memory default. Useful for
 * conditional patterns: "use Cloudflare KV when the binding exists,
 * memory otherwise."
 */
type StoreOrFactory<S> = S | (() => S | undefined | null);

export interface AtprotoAuthConfig extends IdentityOptions {
	/**
	 * Public origin of the deployed app (e.g. `https://mybookmarks.app`).
	 * Leave undefined in dev → falls back to loopback (`http://127.0.0.1:<devPort>`).
	 * Required outside dev.
	 */
	origin?: string | undefined;

	/**
	 * HMAC secret for signed cookies. Required outside dev. In dev, falls
	 * back to a fixed dev string with a one-time warning.
	 */
	cookieSecret?: string | undefined;

	/**
	 * JSON-stringified `ClientAssertionPrivateJwk` for confidential client
	 * signing. Required when `origin` is set; ignored in dev loopback.
	 */
	clientAssertionKey?: string | undefined;

	/**
	 * Declared scopes and default login request. Override per flow with startLogin({ scope }).
	 * Default `'atproto'` (login only — identity, no write
	 * access). Add space-separated scope tokens for more permissions:
	 * - `'atproto repo:app.bsky.feed.post'` — write to a collection
	 * - `'atproto blob?accept=image/*'` — upload images
	 * - `'atproto rpc?lxm=<nsid>&aud=<did>'` — proxied RPC
	 *
	 * String or array of strings. Use atcute's `scope` helpers for type-safe
	 * construction (`scope.repo({...})`, `scope.blob({...})`, …).
	 */
	scope?: string | readonly string[];

	/**
	 * PDS URL used for new-account signup. Leave undefined to disable
	 * signup. The user picks dev vs prod themselves
	 * (e.g. `dev ? 'https://pds.rip/' : 'https://selfhosted.social/'`).
	 */
	signupPDS?: string | undefined;

	/** Default `/oauth/callback`. */
	redirectPath?: string;

	/** Path served for OAuth client metadata. Default `/oauth-client-metadata.json`. */
	metadataPath?: string;

	/** Path served for OAuth JWKS. Default `/oauth/jwks.json`. */
	jwksPath?: string;

	/** Path that POSTs to start a login flow (returns `{ url }`). Default `/oauth/login`. */
	loginPath?: string;

	/** Path that POSTs to request incremental permissions. Default `/oauth/permissions`. */
	permissionsPath?: string;

	/** Path that POSTs to log the user out. Default `/oauth/logout`. */
	logoutPath?: string;

	/** DoH resolver URL for handle resolution. Default Mozilla/Cloudflare. */
	doh?: string;

	/** Loopback port used in dev. Default 5173 (Vite's default). Override if your dev server runs elsewhere. */
	devPort?: number;

	/** Cookie max-age in seconds. Default 180 days. */
	cookieMaxAge?: number;

	/**
	 * Session store. Optional — defaults to in-memory. Wire a persistent
	 * adapter (cloudflareKV, upstashRedis, …) for production.
	 */
	sessions?: StoreOrFactory<AnyStore>;

	/**
	 * State store (10 min TTL). Optional — defaults to in-memory.
	 */
	states?: StoreOrFactory<AnyStore>;

	/** Coordinates refreshes, authorization commits, and logout. Default is process-local.
	 * Multi-instance deployments need a distributed lock AND a strongly consistent session store.
	 */
	requestLock?: RequestLock;
}

export interface ResolvedConfig {
	origin: string | undefined;
	cookieSecret: string;
	clientAssertionKey: string | undefined;
	signupPDS: string | undefined;
	redirectPath: string;
	metadataPath: string;
	jwksPath: string;
	loginPath: string;
	logoutPath: string;
	permissionsPath: string;
	doh: string;
	identity: IdentityOptions;
	fetch: typeof globalThis.fetch | undefined;
	dev: boolean;
	devPort: number;
	cookieMaxAge: number;
	scope: string[];
	scopeString: string;
	resolveSessions: () => AnyStore;
	resolveStates: () => AnyStore;
	requestLock: RequestLock;
}

const DEFAULT_DOH = 'https://mozilla.cloudflare-dns.com/dns-query';
const DEFAULT_REDIRECT = '/oauth/callback';
const DEFAULT_METADATA_PATH = '/oauth-client-metadata.json';
const DEFAULT_JWKS_PATH = '/oauth/jwks.json';
const DEFAULT_LOGIN_PATH = '/oauth/login';
const DEFAULT_LOGOUT_PATH = '/oauth/logout';
const DEFAULT_DEV_PORT = 5173;
const DEFAULT_MAX_AGE = 60 * 60 * 24 * 180;
const DEV_COOKIE_SECRET = 'dev-cookie-secret-not-for-production';
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SCOPE = 'atproto';

function asFactory<S extends AnyStore>(s: StoreOrFactory<S>, fallback: S): () => S {
	if (typeof s === 'function') {
		const fn = s as () => S | undefined | null;
		return () => fn() ?? fallback;
	}
	return () => s;
}

let warnedDevSecret = false;

export function resolveConfig(c: AtprotoAuthConfig): ResolvedConfig {
	const identity: IdentityOptions = {
		network: c.network, plc: c.plc, doh: c.doh, actorResolver: c.actorResolver,
		handleResolver: c.handleResolver, didDocumentResolver: c.didDocumentResolver, fetch: c.fetch
	};
	createActorResolver(identity); // Validate explicit network configuration before starting OAuth.
	const fetchThis = c.network || c.fetch ? networkFetch(identity) : undefined;
	let cookieSecret = c.cookieSecret;
	if (!cookieSecret) {
		if (!dev) throw new Error('atproto-oauth: cookieSecret is required outside dev');
		if (!warnedDevSecret) {
			console.warn(
				'[atproto-oauth] cookieSecret not set — using a known dev fallback. ' +
					'Set `cookieSecret` (e.g. via env) before deploying.'
			);
			warnedDevSecret = true;
		}
		cookieSecret = DEV_COOKIE_SECRET;
	}

	const memSessions = new MemoryStore<string, unknown>();
	const memStates = new MemoryStore<string, unknown>({ ttl: DEFAULT_STATE_TTL_MS });

	const sessions = c.sessions ?? memSessions;
	const states = c.states ?? memStates;

	const scope = normalizeScope(c.scope ?? DEFAULT_SCOPE);
	validateScope(scope, scope);

	return {
		origin: c.origin || undefined,
		cookieSecret,
		clientAssertionKey: c.clientAssertionKey || undefined,
		signupPDS: c.signupPDS || undefined,
		redirectPath: c.redirectPath ?? DEFAULT_REDIRECT,
		metadataPath: c.metadataPath ?? DEFAULT_METADATA_PATH,
		jwksPath: c.jwksPath ?? DEFAULT_JWKS_PATH,
		loginPath: c.loginPath ?? DEFAULT_LOGIN_PATH,
		logoutPath: c.logoutPath ?? DEFAULT_LOGOUT_PATH,
		permissionsPath: c.permissionsPath ?? '/oauth/permissions',
		doh: c.doh ?? DEFAULT_DOH,
		identity,
		fetch: fetchThis,
		dev,
		devPort: c.devPort ?? DEFAULT_DEV_PORT,
		cookieMaxAge: c.cookieMaxAge ?? DEFAULT_MAX_AGE,
		scope,
		scopeString: scope.join(' '),
		resolveSessions: asFactory(sessions, memSessions),
		resolveStates: asFactory(states, memStates),
		requestLock: c.requestLock ?? localRequestLock
	};
}
