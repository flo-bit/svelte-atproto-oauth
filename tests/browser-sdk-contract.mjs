import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { nodeRuntime, storage, DID, OTHER_DID, POST, INCLUDE, BLOB } from './support/runtime.mjs';

// Actual installed browser SDK, with web storage/locks and AS transport scripted
// in Node. Not a real-browser or live-AS test. This establishes SDK contracts
// separately from the package lifecycle adapter tests.
const events = new EventTarget();
globalThis.addEventListener = events.addEventListener.bind(events);
Object.defineProperty(globalThis, 'navigator', {
	configurable: true,
	value: {
		locks: {
			request: async (_name, options, callback) =>
				typeof options === 'function' ? options({}) : callback(options.ifAvailable ? null : {})
		}
	}
});
const sdk = await import('../node_modules/@atcute/oauth-browser-client/dist/index.js');
const environment =
	await import('../node_modules/@atcute/oauth-browser-client/dist/environment.js');
afterEach(() => environment.database.dispose());
let count = 0;
function setup() {
	const t = nodeRuntime();
	globalThis.localStorage = storage();
	globalThis.fetch = (...args) => t.fetch(...args);
	sdk.configureOAuth({
		metadata: {
			client_id: 'https://client.example.com/browser-metadata.json',
			redirect_uri: 'https://client.example.com/browser'
		},
		storageName: `sdk-contract-${++count}`,
		identityResolver: {
			resolve: async (identifier) => ({
				did: identifier.startsWith('did:') ? identifier : DID,
				handle: 'test.example.com',
				pds: 'https://pds.example.com'
			})
		}
	});
	return t;
}
async function flow(t, scope, grant, did = DID) {
	await sdk.createAuthorizationUrl({
		target: { type: 'account', identifier: DID },
		scope,
		state: { requestedScope: scope }
	});
	const state = t.requests.findLast((r) => r.path === '/par').body.get('state');
	const code = `test-${t.requests.length}`;
	t.tokens.set(code, { scope: grant, did });
	const result = await sdk.finalizeAuthorization(
		new URLSearchParams({ state, code, iss: 'https://as.example.com' })
	);
	return { ...result, stateId: state };
}

test('real browser SDK exposes expanded grant and separate authorization state through restore/refresh', async () => {
	const t = setup();
	const result = await flow(t, `atproto ${INCLUDE}`, `atproto ${POST}`);
	assert.equal(result.state.requestedScope, `atproto ${INCLUDE}`);
	assert.equal(result.session.token.scope, `atproto ${POST}`);
	assert.equal((await sdk.getSession(DID)).token.scope, `atproto ${POST}`);
	t.nextRefreshScope = `atproto ${POST} ${BLOB}`;
	assert.equal(
		(await sdk.getSession(DID, { noCache: true })).token.scope,
		`atproto ${POST} ${BLOB}`
	);
});
test('real browser SDK commits a reduced same-DID grant before returning to its caller', async () => {
	const t = setup();
	await flow(t, `atproto ${POST}`, `atproto ${POST}`);
	const reduced = await flow(t, `atproto ${POST} ${BLOB}`, `atproto ${BLOB}`);
	assert.equal(reduced.session.token.scope, `atproto ${BLOB}`);
	assert.equal((await sdk.getSession(DID)).token.scope, `atproto ${BLOB}`);
});
test('real browser SDK does not bind callback identity to the authorize target', async () => {
	const t = setup();
	await flow(t, 'atproto', 'atproto');
	const mismatch = await flow(t, `atproto ${POST}`, `atproto ${POST}`, OTHER_DID);
	assert.equal(mismatch.session.info.sub, OTHER_DID);
	assert.equal((await sdk.getSession(DID)).info.sub, DID);
	assert.equal((await sdk.getSession(OTHER_DID)).info.sub, OTHER_DID);
	await new sdk.OAuthUserAgent(mismatch.session).signOut();
	assert.equal(sdk.listStoredSessions().includes(OTHER_DID), false);
});
test('real browser SDK denial consumes state but leaves the old stored session intact', async () => {
	const t = setup();
	await flow(t, 'atproto', 'atproto');
	await sdk.createAuthorizationUrl({
		target: { type: 'account', identifier: DID },
		scope: `atproto ${POST}`
	});
	const state = t.requests.findLast((r) => r.path === '/par').body.get('state');
	await assert.rejects(
		sdk.finalizeAuthorization(new URLSearchParams({ state, error: 'access_denied' }))
	);
	assert.equal((await sdk.getSession(DID)).token.scope, 'atproto');
	await assert.rejects(
		sdk.finalizeAuthorization(
			new URLSearchParams({ state, code: 'replay', iss: 'https://as.example.com' })
		),
		/unknown state/
	);
});
