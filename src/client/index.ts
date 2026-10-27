// /client exports imperative auth actions only. There is no global reactive
// `user` — auth state lives on `event.locals` (server) and is forwarded to
// page data per-route via your own `+page.server.ts` load functions.

import type { Capability, Scope } from '../permissions/index.js';

const DEFAULT_LOGIN_PATH = '/oauth/login';
const DEFAULT_LOGOUT_PATH = '/oauth/logout';

export interface LoginOptions {
	/** Path of the lib's login endpoint. Default `/oauth/login` (matches `loginPath` server config). */
	loginPath?: string;
	/** Save the current page path so the OAuth callback redirects back here. Default `true`. */
	saveReturnTo?: boolean;
	/** Exact requested scope. Defaults to the server's configured scope. */
	scope?: Scope;
	returnTo?: string;
}

export interface SignupOptions extends LoginOptions {}

export interface PermissionOptions {
	permissionsPath?: string;
	saveReturnTo?: boolean;
	returnTo?: string;
	requirements?: readonly Capability[];
	previousScope?: Scope;
}

export interface LogoutOptions {
	logoutPath?: string;
}

function currentReturnTo(): string | undefined {
	if (typeof window === 'undefined') return undefined;
	return window.location.pathname + window.location.search;
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

async function startOauthFlow(
	path: string,
	body: {
		handle?: string;
		signup?: boolean;
		returnTo?: string;
		scope?: Scope;
		requirements?: readonly Capability[];
		previousScope?: Scope;
	}
): Promise<string | null> {
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
		throw new Error(err.message ?? err.error ?? `Login failed (${res.status})`);
	}
	const data = (await res.json()) as { url?: string | null };
	if (data.url === null) return null;
	if (typeof data.url !== 'string' || !data.url) throw new Error('Login response missing url');
	return data.url;
}

async function navigateAndAwait(url: string, abortMessage: string): Promise<never> {
	window.location.assign(url);
	await new Promise<never>((_resolve, reject) => {
		window.addEventListener('pageshow', () => reject(new Error(abortMessage)), { once: true });
	});
	throw new Error(abortMessage);
}

/**
 * Start a login flow. Validates the handle/DID, POSTs to the lib's login
 * endpoint, then navigates the browser to the PDS authorize URL.
 */
export async function login(handle?: string, options: LoginOptions = {}): Promise<void> {
	const path = options.loginPath ?? DEFAULT_LOGIN_PATH;
	const normalized = handle === undefined ? undefined : normalizeHandle(handle);
	const returnTo =
		options.returnTo ?? (options.saveReturnTo === false ? undefined : currentReturnTo());
	const url = await startOauthFlow(path, { handle: normalized, scope: options.scope, returnTo });
	if (url) await navigateAndAwait(url, 'user aborted the login request');
}

/**
 * Start a signup flow (PDS prompt=create). Requires `signupPDS` configured
 * server-side; otherwise the endpoint returns 403.
 */
export async function signup(options: SignupOptions = {}): Promise<void> {
	const path = options.loginPath ?? DEFAULT_LOGIN_PATH;
	const returnTo =
		options.returnTo ?? (options.saveReturnTo === false ? undefined : currentReturnTo());
	const url = await startOauthFlow(path, { signup: true, scope: options.scope, returnTo });
	if (url) await navigateAndAwait(url, 'user aborted the signup request');
}

/** Add permissions without dropping original request tokens. Returns immediately if already granted. */
export async function requestPermissions(
	scope: Scope,
	options: PermissionOptions = {}
): Promise<void> {
	const returnTo =
		options.returnTo ?? (options.saveReturnTo === false ? undefined : currentReturnTo());
	const url = await startOauthFlow(options.permissionsPath ?? '/oauth/permissions', {
		scope,
		returnTo,
		requirements: options.requirements,
		previousScope: options.previousScope
	});
	if (url) await navigateAndAwait(url, 'user aborted the permission request');
}

/**
 * Log out. POSTs to the lib's logout endpoint (revokes server-side session
 * and clears cookies), then redirects the browser to `/`.
 */
export async function logout(options: LogoutOptions = {}): Promise<void> {
	const path = options.logoutPath ?? DEFAULT_LOGOUT_PATH;
	try {
		await fetch(path, { method: 'POST' });
	} catch (e) {
		console.error('[atproto-oauth/client] logout request failed:', e);
	}
	if (typeof window !== 'undefined') window.location.href = '/';
}
