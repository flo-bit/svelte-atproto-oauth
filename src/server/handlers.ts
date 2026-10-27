import { json, redirect, isHttpError, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import type { Did } from '@atcute/lexicons';
import { createOAuthClient } from './oauth.js';
import { getSignedCookie, setSignedCookie } from './cookie.js';
import { COOKIE_DID, COOKIE_RETURN_TO, COOKIE_SCOPE, cookieOptions } from './cookies.js';
import { authorizationState } from './authorization.js';
import {
	hasCapability,
	hasScopes,
	safeReturnTo,
	PermissionHistoryUnavailableError
} from '../permissions/index.js';
import { createApi, type LoginInput, type PermissionInput } from './api.js';
import type { ResolvedConfig } from './config.js';
import { clientRequestLock } from './lock.js';

async function readInput(request: Request): Promise<Record<string, unknown>> {
	if (request.headers.get('content-type')?.includes('application/json')) {
		const value: unknown = await request.json();
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new TypeError('Expected an object');
		return value as Record<string, unknown>;
	}
	const fd = await request.formData();
	return {
		handle: fd.get('handle')?.toString() || undefined,
		signup: fd.get('signup') === 'true' || fd.get('signup') === 'on',
		scope: fd.has('scope') ? fd.getAll('scope').map(String) : undefined,
		returnTo: fd.get('returnTo')?.toString() || undefined
	};
}

function validateInput(body: Record<string, unknown>): void {
	if (body.handle !== undefined && typeof body.handle !== 'string')
		throw new TypeError('Invalid handle');
	if (body.signup !== undefined && typeof body.signup !== 'boolean')
		throw new TypeError('Invalid signup');
	if (body.returnTo !== undefined && typeof body.returnTo !== 'string')
		throw new TypeError('Invalid returnTo');
	if (
		body.requirements !== undefined &&
		(!Array.isArray(body.requirements) ||
			body.requirements.some((c) => !c || typeof c !== 'object' || typeof c.type !== 'string'))
	)
		throw new TypeError('Invalid requirements');
}

function errorReturnTo(
	returnTo: string,
	outcome: 'auth_denied' | 'auth_failed' | 'permissions_missing'
): string {
	const destination = new URL(returnTo, 'https://return.invalid');
	destination.searchParams.set('error', outcome);
	// Dot-segment normalization can turn a local path into a scheme-relative Location.
	return safeReturnTo(destination.pathname + destination.search + destination.hash) ??
		`/?error=${outcome}`;
}

function crossOrigin(event: RequestEvent): boolean {
	const origin = event.request.headers.get('origin');
	return (
		(origin !== null && origin !== event.url.origin) ||
		event.request.headers.get('sec-fetch-site') === 'cross-site'
	);
}

export function createHandlers(config: ResolvedConfig) {
	const api = createApi(config);
	const metadata: RequestHandler = async () => {
		try {
			return json(createOAuthClient(config).metadata);
		} catch {
			return json({ error: 'oauth_client_misconfigured' }, { status: 500 });
		}
	};
	const jwks: RequestHandler = async () => json(createOAuthClient(config).jwks ?? { keys: [] });

	const completeCallback: RequestHandler = async ({ url, cookies }) => {
		const id = url.searchParams.get('state');
		let stored;
		try {
			stored = id ? await config.resolveStates().get(id) : undefined;
		} catch {
			redirect(303, '/?error=auth_failed');
		}
		const flow = authorizationState(stored?.userState);
		const legacyReturnTo = safeReturnTo(cookies.get(COOKIE_RETURN_TO));
		const returnTo = flow ? (safeReturnTo(flow.returnTo) ?? '/') : (legacyReturnTo ?? '/');
		if (!flow && cookies.get(COOKIE_RETURN_TO)) cookies.delete(COOKIE_RETURN_TO, { path: '/' });
		let missingPermissions = false;
		try {
			if (flow?.upgrade) {
				const did = await getSignedCookie(cookies, COOKIE_DID, config.cookieSecret);
				if (!did || did !== flow.expectedDid) {
					if (id) await config.resolveStates().delete(id);
					throw new Error('identity_mismatch');
				}
			}
			const oauth = createOAuthClient(config, flow);
			const { session } = await oauth.callback(url.searchParams);
			if (flow?.upgrade) {
				const { scope } = await session.getTokenInfo(false);
				missingPermissions = flow.requirements?.length
					? !flow.requirements.every((capability) => hasCapability(scope, capability))
					: !!flow.additionalScope &&
						hasScopes(flow.additionalScope, flow.additionalScope) &&
						!hasScopes(scope, flow.additionalScope);
			}
			await setSignedCookie(
				cookies,
				COOKIE_DID,
				session.did as Did,
				config.cookieSecret,
				cookieOptions(config.cookieMaxAge, config.dev)
			);
			// New sessions keep request history next to the tokens. No scope equality cookie is needed.
			cookies.delete(COOKIE_SCOPE, { path: '/' });
		} catch {
			// SDK logs/errors can contain secrets. Return only a fixed, non-sensitive outcome.
			const outcome =
				url.searchParams.get('error') === 'access_denied' ? 'auth_denied' : 'auth_failed';
			redirect(303, errorReturnTo(returnTo, outcome));
		}
		if (missingPermissions) {
			redirect(303, errorReturnTo(returnTo, 'permissions_missing'));
		}
		redirect(303, returnTo);
	};
	const callback: RequestHandler = (event) =>
		clientRequestLock(config)(
			`oauth-state-${event.url.searchParams.get('state') ?? 'missing'}`,
			async () => completeCallback(event)
		);

	const post =
		(operation: 'login' | 'permissions'): RequestHandler =>
		async (event: RequestEvent) => {
			if (crossOrigin(event)) return json({ error: 'cross_origin_request' }, { status: 403 });
			try {
				const body = await readInput(event.request);
				validateInput(body);
				return json(
					operation === 'login'
						? await api.startLogin(body as LoginInput)
						: await api.requestPermissions(body as unknown as PermissionInput)
				);
			} catch (e) {
				if (isHttpError(e)) throw e;
				if (e instanceof PermissionHistoryUnavailableError)
					return json({ error: 'permission_history_unavailable' }, { status: 409 });
				return json({ error: 'invalid_authorization_request' }, { status: 400 });
			}
		};
	const login = post('login');
	const permissions = post('permissions');
	const logout: RequestHandler = async (event) =>
		crossOrigin(event)
			? json({ error: 'cross_origin_request' }, { status: 403 })
			: json(await api.logout());
	return { metadata, jwks, callback, login, permissions, logout };
}

export type Handlers = ReturnType<typeof createHandlers>;
export type { Did };
