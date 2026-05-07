import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import type { ActorIdentifier, Did } from '@atcute/lexicons';
import type { Client } from '@atcute/client';
import type { OAuthSession } from '@atcute/oauth-node-client';
import { createOAuthClient } from './oauth.js';
import { getSignedCookie } from './cookie.js';
import { clearAuthCookies, COOKIE_DID, COOKIE_RETURN_TO } from './cookies.js';
import type { ResolvedConfig } from './config.js';

const RETURN_TO_TTL = 600; // seconds

function isSafeReturnTo(value: string): boolean {
	const decoded = (() => {
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	})();
	return decoded.startsWith('/') && !decoded.startsWith('//');
}

export interface CurrentSession {
	did: Did | null;
	session: OAuthSession | null;
	client: Client | null;
}

export function createApi(config: ResolvedConfig) {
	async function startLogin(input: {
		handle?: string;
		signup?: boolean;
		/**
		 * Path to redirect to after the OAuth callback completes. Must start
		 * with `/` and not `//` (the callback re-validates). Stored in a
		 * short-lived `oauth_return_to` cookie that the callback consumes.
		 */
		returnTo?: string;
	}): Promise<{ url: string }> {
		try {
			const oauth = createOAuthClient(config);

			if (input.signup && !config.signupPDS) {
				error(403, 'Signup is not enabled');
			}

			if (input.returnTo && isSafeReturnTo(input.returnTo)) {
				const event = getRequestEvent();
				event.cookies.set(COOKIE_RETURN_TO, input.returnTo, {
					path: '/',
					httpOnly: true,
					sameSite: 'lax',
					secure: !config.dev,
					maxAge: RETURN_TO_TTL
				});
			}

			const target = input.signup
				? ({ type: 'pds', serviceUrl: config.signupPDS! } as const)
				: ({ type: 'account', identifier: input.handle as ActorIdentifier } as const);

			const { url } = await oauth.authorize({
				target,
				scope: config.scopeString,
				prompt: input.signup ? 'create' : undefined
			});

			return { url: url.toString() };
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e) throw e;
			const message = e instanceof Error ? e.message : 'Login failed';
			error(400, message);
		}
	}

	async function logout(): Promise<{ ok: true }> {
		const event = getRequestEvent();
		const did = (await getSignedCookie(event.cookies, COOKIE_DID, config.cookieSecret)) as
			| Did
			| null;

		if (did) {
			try {
				const oauth = createOAuthClient(config);
				await oauth.revoke(did);
			} catch (e) {
				console.error('[atproto-oauth] revoke failed:', e);
			}
		}

		clearAuthCookies(event.cookies);
		return { ok: true };
	}

	function getSession(): CurrentSession {
		const event = getRequestEvent();
		const locals = event.locals as unknown as CurrentSession;
		return {
			did: locals.did ?? null,
			session: locals.session ?? null,
			client: locals.client ?? null
		};
	}

	return { startLogin, logout, getSession };
}

export type Api = ReturnType<typeof createApi>;
