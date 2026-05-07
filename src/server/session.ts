import type { RequestEvent } from '@sveltejs/kit';
import { Client } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
import {
	type OAuthSession,
	TokenInvalidError,
	TokenRefreshError,
	TokenRevokedError,
	AuthMethodUnsatisfiableError
} from '@atcute/oauth-node-client';
import { createOAuthClient } from './oauth.js';
import { getSignedCookie } from './cookie.js';
import { clearAuthCookies, COOKIE_DID, COOKIE_SCOPE } from './cookies.js';
import type { ResolvedConfig } from './config.js';

export interface SessionLocals {
	session: OAuthSession | null;
	client: Client | null;
	did: Did | null;
}

const EMPTY: SessionLocals = { session: null, client: null, did: null };

export async function restoreSession(
	event: RequestEvent,
	config: ResolvedConfig
): Promise<SessionLocals> {
	const did = (await getSignedCookie(event.cookies, COOKIE_DID, config.cookieSecret)) as
		| Did
		| null;

	if (!did) return EMPTY;

	const savedScope = await getSignedCookie(event.cookies, COOKIE_SCOPE, config.cookieSecret);
	if (savedScope !== null && savedScope !== config.scopeString) {
		clearAuthCookies(event.cookies);
		return EMPTY;
	}

	try {
		const oauth = createOAuthClient(config);
		const session = await oauth.restore(did);
		return {
			session,
			client: new Client({ handler: session }),
			did
		};
	} catch (e) {
		// Only clear cookies for genuinely unrecoverable failures.
		// Transient errors (network, KV blip) preserve the cookie so the
		// next request can retry without forcing a full re-login.
		const gone =
			e instanceof TokenInvalidError ||
			e instanceof TokenRevokedError ||
			e instanceof TokenRefreshError ||
			e instanceof AuthMethodUnsatisfiableError;

		if (gone) clearAuthCookies(event.cookies);
		else console.error('atproto-oauth: failed to restore session:', e);

		return EMPTY;
	}
}
