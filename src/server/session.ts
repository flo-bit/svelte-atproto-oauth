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
import { migrateRequestedScope } from './authorization.js';
import { clientRequestLock } from './lock.js';

export interface SessionLocals {
	session: OAuthSession | null;
	client: Client | null;
	did: Did | null;
}

const EMPTY: SessionLocals = { session: null, client: null, did: null };

function errorName(e: unknown): string {
	return e instanceof Error ? e.name : typeof e;
}

export async function restoreSession(
	event: RequestEvent,
	config: ResolvedConfig
): Promise<SessionLocals> {
	const did = (await getSignedCookie(event.cookies, COOKIE_DID, config.cookieSecret)) as Did | null;

	if (!did) return EMPTY;

	try {
		const oauth = createOAuthClient(config);
		const session = await oauth.restore(did);
		const savedScope = await getSignedCookie(event.cookies, COOKIE_SCOPE, config.cookieSecret);
		if (savedScope !== null) {
			// Best effort only: bookkeeping failure must not invalidate an otherwise valid login.
			try {
				await clientRequestLock(config)(`oauth-session-${did}`, () =>
					migrateRequestedScope(config.resolveSessions(), did, savedScope)
				);
				event.cookies.delete(COOKIE_SCOPE, { path: '/' });
			} catch {
				console.warn('atproto-oauth: legacy scope migration deferred');
			}
		}
		return {
			session,
			client: new Client({ handler: session }),
			did
		};
	} catch (e) {
		// Only clear cookies for genuinely unrecoverable failures.
		// Transient errors (network, KV blip) preserve the cookie so the
		// next request can retry without forcing a full re-login.
		let gone =
			e instanceof TokenInvalidError ||
			e instanceof TokenRevokedError ||
			e instanceof TokenRefreshError ||
			e instanceof AuthMethodUnsatisfiableError;

		if (gone) {
			// The SDK treats a failed store read as a missing session. Verify deletion
			// before clearing identity cookies; an adapter outage is not revocation.
			try {
				gone = (await config.resolveSessions().get(did)) === undefined;
			} catch {
				gone = false;
			}
		}
		if (gone) clearAuthCookies(event.cookies);
		// Error messages can carry upstream URLs or tokens; the class name alone is safe to log.
		else console.warn(`atproto-oauth: session restoration temporarily failed (${errorName(e)})`);

		return EMPTY;
	}
}
