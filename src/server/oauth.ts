import {
	OAuthClient,
	type ClientAssertionPrivateJwk,
	type OAuthClientStores
} from '@atcute/oauth-node-client';
import { createActorResolver } from '../network/index.js';
import type { ResolvedConfig } from './config.js';
import { authorizationSessions, type AuthorizationState } from './authorization.js';
import { clientRequestLock, type RequestLock } from './lock.js';

export function createOAuthClient(
	config: ResolvedConfig,
	flow?: AuthorizationState | null,
	requestLock: RequestLock = clientRequestLock(config)
): OAuthClient {
	const stores = {
		sessions: authorizationSessions(config.resolveSessions(), flow, requestLock),
		states: config.resolveStates()
	} as OAuthClientStores;

	if (config.dev && !config.origin) {
		// Dev loopback (no public URL, no key). The library builds a
		// `client_id` from redirect_uris + scope. 127.0.0.1 is mandatory.
		return new OAuthClient({
			metadata: {
				redirect_uris: [`http://127.0.0.1:${config.devPort}${config.redirectPath}`],
				scope: config.scope
			},
			actorResolver: createActorResolver(config.identity),
			fetch: config.fetch,
			requestLock,
			stores
		});
	}

	if (!config.origin) {
		throw new Error('atproto-oauth: origin is required outside dev mode');
	}
	if (!config.clientAssertionKey) {
		throw new Error('atproto-oauth: clientAssertionKey is required when origin is set');
	}

	let key: ClientAssertionPrivateJwk;
	try {
		key = JSON.parse(config.clientAssertionKey) as ClientAssertionPrivateJwk;
	} catch {
		throw new Error('atproto-oauth: clientAssertionKey must be JSON-encoded JWK');
	}

	return new OAuthClient({
		metadata: {
			client_id: `${config.origin}${config.metadataPath}`,
			redirect_uris: [`${config.origin}${config.redirectPath}`],
			scope: config.scope,
			jwks_uri: `${config.origin}${config.jwksPath}`
		},
		keyset: [key],
		actorResolver: createActorResolver(config.identity),
		fetch: config.fetch,
		requestLock,
		stores
	});
}
