export const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
export const OTHER_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
export const POST = 'repo:app.example.post';
export const INCLUDE = 'include:app.example.authFull';
export const BLOB = 'blob?accept=image/*';
export const RPC = 'rpc:app.example.getFeed?aud=did:web:api.example.com%23appview';
export function memoryStore() {
	const data = new Map();
	return {
		data,
		get: async (k) => data.get(k),
		set: async (k, v) => {
			data.set(k, v);
		},
		delete: async (k) => {
			data.delete(k);
		},
		clear: async () => data.clear()
	};
}
export function cookies() {
	const values = new Map();
	return {
		values,
		get: (k) => values.get(k),
		set: (k, v) => values.set(k, v),
		delete: (k) => values.delete(k),
		getAll: () => [...values].map(([name, value]) => ({ name, value }))
	};
}
export function event(path = '/') {
	return {
		url: new URL(path, 'https://client.example.com'),
		request: new Request(new URL(path, 'https://client.example.com')),
		cookies: cookies(),
		locals: {}
	};
}
export function browserSession(scope = 'atproto', did = DID) {
	return {
		info: { sub: did, aud: 'https://pds.example.com' },
		token: { scope, access: 'TEST-ONLY', refresh: 'TEST-ONLY', expires_at: Date.now() + 3600000 }
	};
}
export function storage() {
	const data = new Map();
	return {
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => data.set(k, String(v)),
		removeItem: (k) => data.delete(k),
		clear: () => data.clear(),
		key: (i) => [...data.keys()][i] ?? null,
		get length() {
			return data.size;
		}
	};
}
export function browserRuntime() {
	const t = (globalThis.authTest = {
		sessions: new Map(),
		revoked: [],
		assigned: [],
		replaced: []
	});
	// Model shared Web Locks so separate auth instances serialize like separate tabs.
	const pending = new Map();
	t.lockRequests = [];
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
		request(name, options, callback) {
			// The real SDK uses ifAvailable for opportunistic background cleanup.
			if (typeof options !== 'function') return Promise.resolve(callback(null));
			const operation = options;
			t.lockRequests.push(name);
			const previous = pending.get(name) ?? Promise.resolve();
			const result = previous.catch(() => {}).then(operation);
			pending.set(name, result);
			return result.finally(() => {
				if (pending.get(name) === result) pending.delete(name);
			});
		}
	} } });
	globalThis.localStorage = storage();
	globalThis.sessionStorage = storage();
	globalThis.window = {
		location: {
			pathname: '/',
			search: '',
			hash: '',
			assign: (s) => t.assigned.push(s),
			replace: (s) => t.replaced.push(s)
		},
		history: {
			replaceState: () => {
				window.location.hash = '';
			}
		}
	};
	return t;
}
export function nodeRuntime() {
	const t = (globalThis.authTest = {
		did: DID,
		requests: [],
		tokens: new Map(),
		nextRefreshScope: null,
		event: event()
	});
	const metadata = {
		issuer: 'https://as.example.com',
		authorization_endpoint: 'https://as.example.com/authorize',
		token_endpoint: 'https://as.example.com/token',
		pushed_authorization_request_endpoint: 'https://as.example.com/par',
		revocation_endpoint: 'https://as.example.com/revoke',
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
		token_endpoint_auth_signing_alg_values_supported: ['ES256'],
		code_challenge_methods_supported: ['S256'],
		dpop_signing_alg_values_supported: ['ES256'],
		require_pushed_authorization_requests: true,
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true
	};
	t.fetch = async (url, options = {}) => {
		const request = url instanceof Request ? url : new Request(url, options);
		const path = new URL(request.url).pathname;
		if (path === '/.well-known/oauth-protected-resource')
			return Response.json({
				resource: 'https://pds.example.com',
				authorization_servers: [metadata.issuer],
				bearer_methods_supported: ['header']
			});
		if (path === '/.well-known/oauth-authorization-server') return Response.json(metadata);
		const text = await request.text();
		const body = request.headers.get('content-type')?.includes('application/json')
			? new URLSearchParams(
					Object.entries(JSON.parse(text || '{}')).map(([k, v]) => [k, String(v)])
				)
			: new URLSearchParams(text);
		t.requests.push({ path, body, headers: request.headers });
		if (path === '/par')
			return Response.json({ request_uri: `urn:scripted:${t.requests.length}`, expires_in: 600 });
		if (path === '/revoke') return new Response(null, { status: 200 });
		if (path === '/token') {
			if (t.tokenError) throw new Error('SCRIPTED NETWORK OUTAGE');
			if (t.invalidGrant) return Response.json({ error: 'invalid_grant' }, { status: 400 });
			const value =
				body.get('grant_type') === 'refresh_token'
					? { did: DID, scope: t.nextRefreshScope ?? 'atproto' }
					: t.tokens.get(body.get('code'));
			if (!value) throw new Error('Unknown scripted authorization code');
			return Response.json({
				sub: value.did ?? DID,
				scope: value.scope,
				access_token: `TEST-ONLY-access-${t.requests.length}`,
				refresh_token: `TEST-ONLY-refresh-${t.requests.length}`,
				token_type: 'DPoP',
				expires_in: 3600
			});
		}
		throw new Error(`Unexpected network request: ${request.url}`);
	};
	return t;
}
