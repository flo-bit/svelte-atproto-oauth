import { writable, type Readable } from 'svelte/store';
import {
	configureOAuth,
	createAuthorizationUrl,
	finalizeAuthorization,
	OAuthUserAgent,
	getSession,
	deleteStoredSession,
	type Session
} from '@atcute/oauth-browser-client';
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver
} from '@atcute/identity-resolver';
import { Client } from '@atcute/client';
import type { ActorIdentifier, Did } from '@atcute/lexicons';
import { dev } from '$app/environment';

const DEFAULT_DOH = 'https://mozilla.cloudflare-dns.com/dns-query';
const DEFAULT_REDIRECT = '/';
const DEFAULT_METADATA_PATH = '/oauth-client-metadata.json';
const DEFAULT_DEV_PORT = 5173;
const STORAGE_KEY = 'atproto-current-login';

export interface BrowserAuthConfig {
	/**
	 * Public URL of your deployed site, e.g. `https://my-app.example`. Used
	 * to build `client_id` and `redirect_uri` in the OAuth metadata.
	 *
	 * In dev (when `$app/environment` says `dev: true`), the lib swaps to a
	 * loopback `client_id` automatically — no public URL needed.
	 */
	origin: string;

	/** Path the PDS redirects to after auth. Default `/`. */
	redirectPath?: string;

	/** Path your metadata JSON is served at. Default `/oauth-client-metadata.json`. */
	metadataPath?: string;

	/** OAuth scope. String or string[]. Default `'atproto'`. */
	scope?: string | readonly string[];

	/** PDS for new-account signup. Leave undefined to disable signup. */
	signupPDS?: string;

	/** DoH resolver URL for handle resolution. */
	doh?: string;

	/** Loopback port used in dev. Default 5173. */
	devPort?: number;
}

export interface UserState {
	agent: OAuthUserAgent | null;
	client: Client | null;
	did: Did | null;
	isInitializing: boolean;
	isLoggedIn: boolean;
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

export interface AtprotoBrowserAuth {
	/**
	 * Reactive auth state. Subscribe via Svelte's `$user.did` syntax in
	 * components, or via `user.subscribe(...)` outside.
	 */
	user: Readable<UserState>;

	/** OAuth client metadata. Serve this from a prerendered `+server.ts` route. */
	metadata: ClientMetadata;

	/**
	 * Call once on app boot (e.g. in your root `+layout.svelte`'s `onMount`).
	 * Reads the URL fragment for OAuth params (just-returned from PDS) or
	 * resumes a stored session.
	 */
	init(): Promise<void>;

	/** Start a login flow for a handle/DID. Navigates the browser to the PDS authorize URL. */
	login(handleOrDid: string): Promise<void>;

	/** Start a signup flow (PDS prompt=create). Throws if `signupPDS` isn't set. */
	signup(): Promise<void>;

	/** Sign out — revokes the session at the PDS and clears local state. */
	logout(): Promise<void>;
}

function normalizeScope(s: string | readonly string[] | undefined): string[] {
	if (s === undefined) return ['atproto'];
	if (typeof s === 'string') return s.split(/\s+/).filter(Boolean);
	return s.flatMap((entry) => entry.split(/\s+/).filter(Boolean));
}

export function createAtprotoBrowserAuth(config: BrowserAuthConfig): AtprotoBrowserAuth {
	const origin = config.origin;
	const redirectPath = config.redirectPath ?? DEFAULT_REDIRECT;
	const metadataPath = config.metadataPath ?? DEFAULT_METADATA_PATH;
	const scope = normalizeScope(config.scope);
	const scopeString = scope.join(' ');
	const signupPDS = config.signupPDS;
	const doh = config.doh ?? DEFAULT_DOH;
	const devPort = config.devPort ?? DEFAULT_DEV_PORT;

	const metadata: ClientMetadata = {
		client_id: origin + metadataPath,
		redirect_uris: [origin + redirectPath],
		scope: scopeString,
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web',
		dpop_bound_access_tokens: true
	};

	const _user = writable<UserState>({
		agent: null,
		client: null,
		did: null,
		isInitializing: true,
		isLoggedIn: false
	});

	let configured = false;

	function ensureConfigured() {
		if (configured) return;

		const clientId = dev
			? `http://localhost?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${devPort}${redirectPath}`)}&scope=${encodeURIComponent(scopeString)}`
			: metadata.client_id;
		const redirectUri = dev
			? `http://127.0.0.1:${devPort}${redirectPath}`
			: metadata.redirect_uris[0];

		configureOAuth({
			metadata: { client_id: clientId, redirect_uri: redirectUri },
			identityResolver: new LocalActorResolver({
				handleResolver: new CompositeHandleResolver({
					methods: {
						dns: new DohJsonHandleResolver({ dohUrl: doh }),
						http: new WellKnownHandleResolver()
					}
				}),
				didDocumentResolver: new CompositeDidDocumentResolver({
					methods: {
						plc: new PlcDidDocumentResolver(),
						web: new WebDidDocumentResolver()
					}
				})
			})
		});
		configured = true;
	}

	function applySession(session: Session) {
		const agent = new OAuthUserAgent(session);
		const client = new Client({ handler: agent });
		_user.set({
			agent,
			client,
			did: session.info.sub,
			isInitializing: false,
			isLoggedIn: true
		});
	}

	function clearSession() {
		_user.set({
			agent: null,
			client: null,
			did: null,
			isInitializing: false,
			isLoggedIn: false
		});
	}

	async function init() {
		if (typeof window === 'undefined') {
			_user.update((s) => ({ ...s, isInitializing: false }));
			return;
		}

		ensureConfigured();
		_user.update((s) => ({ ...s, isInitializing: true }));

		const params = new URLSearchParams(window.location.hash.slice(1));
		const stored = (localStorage.getItem(STORAGE_KEY) as Did | null) ?? null;

		try {
			if (params.size > 0 && (params.has('code') || params.has('error'))) {
				const { session } = await finalizeAuthorization(params);
				// Clear the OAuth params from the URL without a navigation.
				window.history.replaceState(
					null,
					'',
					window.location.pathname + window.location.search
				);
				applySession(session);
				localStorage.setItem(STORAGE_KEY, session.info.sub);
				return;
			}

			if (stored) {
				const session = await getSession(stored);
				if (session.token.expires_at && session.token.expires_at < Date.now()) {
					throw new Error('session expired');
				}
				if (session.token.scope && session.token.scope !== scopeString) {
					throw new Error('scope changed since last login');
				}
				applySession(session);
				return;
			}

			_user.update((s) => ({ ...s, isInitializing: false }));
		} catch (e) {
			console.error('[atproto-oauth/browser] init failed:', e);
			if (stored) {
				localStorage.removeItem(STORAGE_KEY);
				try {
					deleteStoredSession(stored);
				} catch {
					/* ignore */
				}
			}
			clearSession();
		}
	}

	function normalizeHandle(input: string): string {
		let s = input.trim();
		if (s.startsWith('@')) s = s.slice(1);
		if (s.startsWith('did:')) {
			if (s.length < 6) throw new Error('DID must be at least 6 characters');
			return s;
		}
		if (!s.includes('.') || s.length < 4) {
			throw new Error('Please provide a valid handle (e.g. alice.bsky.social) or DID');
		}
		return s;
	}

	async function login(handleOrDid: string): Promise<void> {
		ensureConfigured();
		const identity = normalizeHandle(handleOrDid) as ActorIdentifier;
		const url = await createAuthorizationUrl({
			target: { type: 'account', identifier: identity },
			scope: scopeString
		});
		// Give the browser a tick to persist any OAuth state to localStorage
		// before navigating away.
		await new Promise((resolve) => setTimeout(resolve, 100));
		window.location.assign(url.toString());
		await new Promise<never>((_resolve, reject) => {
			window.addEventListener(
				'pageshow',
				() => reject(new Error('user aborted the login request')),
				{ once: true }
			);
		});
		throw new Error('user aborted the login request');
	}

	async function signup(): Promise<void> {
		if (!signupPDS) throw new Error('Signup is not enabled — set `signupPDS` in the config');
		ensureConfigured();
		const url = await createAuthorizationUrl({
			target: { type: 'pds', serviceUrl: signupPDS },
			scope: scopeString,
			prompt: 'create'
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		window.location.assign(url.toString());
		await new Promise<never>((_resolve, reject) => {
			window.addEventListener(
				'pageshow',
				() => reject(new Error('user aborted the signup request')),
				{ once: true }
			);
		});
		throw new Error('user aborted the signup request');
	}

	async function logout(): Promise<void> {
		let agent: OAuthUserAgent | null = null;
		_user.update((s) => {
			agent = s.agent;
			return s;
		});

		if (typeof window !== 'undefined') {
			localStorage.removeItem(STORAGE_KEY);
		}

		if (agent) {
			try {
				await (agent as OAuthUserAgent).signOut();
			} catch (e) {
				console.error('[atproto-oauth/browser] signOut failed:', e);
				try {
					deleteStoredSession((agent as OAuthUserAgent).session.info.sub);
				} catch {
					/* ignore */
				}
			}
		}

		clearSession();
	}

	return {
		user: { subscribe: _user.subscribe },
		metadata,
		init,
		login,
		signup,
		logout
	};
}
