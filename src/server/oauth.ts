import {
	OAuthClient,
	type ClientAssertionPrivateJwk,
	type OAuthClientStores
} from '@atcute/oauth-node-client';
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver
} from '@atcute/identity-resolver';
import type { ResolvedConfig } from './config.js';

function actorResolver(doh: string) {
	return new LocalActorResolver({
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
	});
}

export function createOAuthClient(config: ResolvedConfig): OAuthClient {
	const stores = {
		sessions: config.resolveSessions(),
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
			actorResolver: actorResolver(config.doh),
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
			client_id: `${config.origin}/oauth-client-metadata.json`,
			redirect_uris: [`${config.origin}${config.redirectPath}`],
			scope: config.scope,
			jwks_uri: `${config.origin}/oauth/jwks.json`
		},
		keyset: [key],
		actorResolver: actorResolver(config.doh),
		stores
	});
}
