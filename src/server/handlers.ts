import { json, redirect, type RequestHandler } from '@sveltejs/kit';
import type { Did } from '@atcute/lexicons';
import { createOAuthClient } from './oauth.js';
import { setSignedCookie } from './cookie.js';
import { COOKIE_DID, COOKIE_RETURN_TO, COOKIE_SCOPE, cookieOptions } from './cookies.js';
import { createApi } from './api.js';
import type { ResolvedConfig } from './config.js';

export function createHandlers(config: ResolvedConfig) {
	const api = createApi(config);

	const metadata: RequestHandler = async () => {
		try {
			const oauth = createOAuthClient(config);
			return json(oauth.metadata);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error('[atproto-oauth] metadata:', message);
			return json(
				{
					error: 'oauth_client_misconfigured',
					message: config.dev ? message : 'See server logs'
				},
				{ status: 500 }
			);
		}
	};

	const jwks: RequestHandler = async () => {
		const oauth = createOAuthClient(config);
		return json(oauth.jwks ?? { keys: [] });
	};

	const callback: RequestHandler = async ({ url, cookies }) => {
		const oauth = createOAuthClient(config);

		try {
			const { session } = await oauth.callback(url.searchParams);

			const opts = cookieOptions(config.cookieMaxAge, config.dev);
			await setSignedCookie(cookies, COOKIE_DID, session.did, config.cookieSecret, opts);
			await setSignedCookie(cookies, COOKIE_SCOPE, config.scopeString, config.cookieSecret, opts);
		} catch (e) {
			console.error('[atproto-oauth] callback failed:', e);
			redirect(303, '/?error=auth_failed');
		}

		const returnTo = cookies.get(COOKIE_RETURN_TO);
		if (returnTo) {
			cookies.delete(COOKIE_RETURN_TO, { path: '/' });
			const decoded = decodeURIComponent(returnTo);
			if (decoded.startsWith('/') && !decoded.startsWith('//')) {
				redirect(303, decoded);
			}
		}

		redirect(303, '/');
	};

	const login: RequestHandler = async ({ request }) => {
		let body: { handle?: string; signup?: boolean; returnTo?: string };
		try {
			const ct = request.headers.get('content-type') ?? '';
			if (ct.includes('application/json')) {
				body = (await request.json()) as typeof body;
			} else {
				const fd = await request.formData();
				body = {
					handle: fd.get('handle')?.toString() || undefined,
					signup: fd.get('signup') === 'true' || fd.get('signup') === 'on',
					returnTo: fd.get('returnTo')?.toString() || undefined
				};
			}
		} catch {
			return json({ error: 'invalid_body' }, { status: 400 });
		}

		const result = await api.startLogin(body);
		return json(result);
	};

	const logout: RequestHandler = async () => {
		const result = await api.logout();
		return json(result);
	};

	return { metadata, jwks, callback, login, logout };
}

export type Handlers = ReturnType<typeof createHandlers>;

export type { Did };
