import { OAuthClient as RealOAuthClient } from '../../node_modules/@atcute/oauth-node-client/dist/index.js';
export * from '../../node_modules/@atcute/oauth-node-client/dist/index.js';
const cache = () => {
	const data = new Map();
	return {
		get: async (k) => data.get(k),
		set: async (k, v) => {
			data.set(k, v);
		},
		delete: async (k) => {
			data.delete(k);
		},
		clear: async () => data.clear()
	};
};
export class OAuthClient extends RealOAuthClient {
	constructor(options) {
		globalThis.authTest.oauthOptions = options;
		super({
			...options,
			stores: { ...options.stores, asMetadata: cache(), prMetadata: cache(), dpopNonces: cache() },
			fetch: options.fetch ?? ((...args) => globalThis.authTest.fetch(...args)),
			actorResolver: globalThis.authTest.useConfiguredResolver ? options.actorResolver : {
				resolve: async (identifier) => ({
					did: identifier.startsWith('did:') ? identifier : globalThis.authTest.did,
					handle: 'test.example.com',
					pds: 'https://pds.example.com'
				})
			}
		});
	}
}
