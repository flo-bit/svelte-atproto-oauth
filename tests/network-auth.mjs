import './support/register.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeRuntime, browserRuntime, browserSession, DID, memoryStore } from './support/runtime.mjs';
const { createAtprotoAuth } = await import('../src/server/index.ts');
const { createAtprotoBrowserAuth } = await import('../src/browser/index.ts');
const { createAtprotoNetwork } = await import('../src/network/index.ts');
const identity = { did: DID, handle: 'test.example.com', pds: 'https://pds.example.com' };
const base = { mode: 'isolated', namespace: 'sandbox', allowedOrigins: ['https://pds.example.com', 'https://as.example.com'], slingshot: false };

test('server OAuth forwards custom actor resolution and guarded transport to the real SDK', async () => {
	const t = nodeRuntime();
	t.useConfiguredResolver = true;
	const actors = [], requests = [];
	const actorResolver = { resolve: async identifier => { actors.push(identifier); return identity; } };
	const network = createAtprotoNetwork({ ...base, actorResolver, fetch: async (input, init) => {
		requests.push(input instanceof Request ? input.url : String(input));
		assert.equal(init.redirect, 'error');
		return t.fetch(input, init);
	} });
	const auth = createAtprotoAuth({ cookieSecret: 'TEST-ONLY', network, sessions: memoryStore(), states: memoryStore() });
	assert.ok((await auth.api.startLogin({ handle: identity.handle })).url.startsWith('https://as.example.com/authorize'));
	assert.deepEqual(actors, [identity.handle]);
	assert.ok(requests.some(url => url.includes('oauth-protected-resource')));
	assert.ok(requests.some(url => url.endsWith('/par')));
	assert.equal(t.oauthOptions.fetch, network.fetch);
});

test('server custom resolver failure does not retry with the default PLC/handle resolver', async () => {
	const t = nodeRuntime();
	t.useConfiguredResolver = true;
	let resolves = 0, calls = 0;
	const actorResolver = { resolve: async () => { resolves++; throw new Error('Sandbox account missing'); } };
	const auth = createAtprotoAuth({ cookieSecret: 'TEST-ONLY', actorResolver, fetch: async () => { calls++; throw new Error('Network forbidden'); } });
	await assert.rejects(auth.api.startLogin({ handle: identity.handle }), e => e.status === 400);
	assert.equal(resolves, 1);
	assert.equal(calls, 0);
	assert.equal(t.oauthOptions.actorResolver, actorResolver);
});

test('server rejects an advertised production AS before contacting it', async () => {
	const t = nodeRuntime();
	t.useConfiguredResolver = true;
	const requests = [];
	const network = createAtprotoNetwork({ ...base, actorResolver: { resolve: async () => identity }, fetch: async (input) => {
		requests.push(String(input));
		return Response.json({ resource: identity.pds, authorization_servers: ['https://bsky.social'] });
	} });
	const auth = createAtprotoAuth({ cookieSecret: 'TEST-ONLY', network });
	await assert.rejects(auth.api.startLogin({ handle: identity.handle }), e => e.status === 400);
	assert.equal(requests.length, 1);
	assert.ok(requests[0].startsWith(identity.pds));
});

test('browser OAuth accepts a custom resolver and namespaces all selected-account/state/history keys', async () => {
	const t = browserRuntime();
	localStorage.setItem('atproto-current-login', 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
	const network = createAtprotoNetwork({ ...base, actorResolver: { resolve: async () => identity } });
	let checked = 0;
	const auth = createAtprotoBrowserAuth({ origin: 'https://client.example.com', network, assertBrowserEgress: () => { checked++; } });
	await auth.init();
	assert.equal((await auth.getPermissions()).did, null);
	assert.equal(localStorage.getItem('atproto-current-login'), 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
	assert.equal(t.configured.storageName, network.cacheKey('atcute-oauth'));
	assert.deepEqual(await t.configured.identityResolver.resolve(identity.handle), identity);
	await auth.login(identity.handle);
	assert.ok(sessionStorage.getItem(network.cacheKey('svelte-atproto:pending:https://client.example.com/oauth-client-metadata.json')));
	t.next = browserSession();
	window.location.hash = '#code=SCRIPTED&state=SCRIPTED';
	await auth.init();
	assert.equal(localStorage.getItem(network.cacheKey('atproto-current-login')), DID);
	assert.equal(localStorage.getItem('atproto-current-login'), 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
	assert.ok(localStorage.getItem(network.cacheKey(`svelte-atproto:requested:https://client.example.com/oauth-client-metadata.json:${DID}`)));
	await auth.logout();
	assert.ok(checked >= 4);
	assert.ok(t.lockRequests.length > 0);
	assert.ok(t.lockRequests.every(name => name === network.cacheKey('svelte-atproto:lifecycle')));
	assert.equal(localStorage.getItem('atproto-current-login'), 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb');
});

test('browser accepts direct custom actor resolver without changing production SDK storage naming', async () => {
	const t = browserRuntime();
	const actorResolver = { resolve: async () => identity };
	const auth = createAtprotoBrowserAuth({ origin: 'https://client.example.com', actorResolver });
	await auth.init();
	assert.equal(t.configured.identityResolver, actorResolver);
	assert.equal(t.configured.storageName, undefined);
});


test('isolated browser OAuth refuses to run without working external egress protection', async () => {
	const t = browserRuntime();
	const network = createAtprotoNetwork({ ...base, actorResolver: { resolve: async () => identity } });
	assert.throws(() => createAtprotoBrowserAuth({ origin: 'https://client.example.com', network }), /assertBrowserEgress/);
	const error = new Error('Egress guard unavailable');
	const auth = createAtprotoBrowserAuth({ origin: 'https://client.example.com', network,
		assertBrowserEgress: () => { throw error; }
	});
	await assert.rejects(auth.login(identity.handle), error);
	assert.equal(t.assigned.length, 0);
	assert.equal(t.configured, undefined);
});

test('server refuses a production authorization destination advertised by a private AS', async () => {
	const t = nodeRuntime();
	t.useConfiguredResolver = true;
	const urls = [];
	const network = createAtprotoNetwork({ ...base, actorResolver: { resolve: async () => identity }, fetch: async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		urls.push(url);
		const response = await t.fetch(input, init);
		if (url.endsWith('/.well-known/oauth-authorization-server'))
			return Response.json({ ...await response.json(), authorization_endpoint: 'https://bsky.social/authorize' });
		return response;
	} });
	const auth = createAtprotoAuth({ cookieSecret: 'TEST-ONLY', network });
	await assert.rejects(auth.api.startLogin({ handle: identity.handle }), e => e.status === 400);
	assert.ok(urls.every(url => base.allowedOrigins.includes(new URL(url).origin)));
});
