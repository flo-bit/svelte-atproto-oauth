import './support/register.mjs';
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { browserRuntime, nodeRuntime, DID, POST } from './support/runtime.mjs';

// Exercise the package adapter with the actual installed browser SDK. Only the
// browser primitives, identity lookup, and authorization-server transport are scripted.
const sdkUrl = new URL('../node_modules/@atcute/oauth-browser-client/dist/index.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
	return specifier === '@atcute/oauth-browser-client'
		? { url: sdkUrl, shortCircuit: true }
		: next(specifier, context);
} });
const events = new EventTarget();
globalThis.addEventListener = events.addEventListener.bind(events);
const sdk = await import(sdkUrl);
const environment = await import('../node_modules/@atcute/oauth-browser-client/dist/environment.js');
const { createAtprotoBrowserAuth } = await import('../src/browser/index.ts');
afterEach(() => environment.database?.dispose());

function setup() {
	const browser = browserRuntime();
	const server = nodeRuntime();
	globalThis.fetch = (...args) => server.fetch(...args);
	const config = {
		origin: 'https://client.example.com', scope: ['atproto', POST],
		actorResolver: { resolve: async () => ({ did: DID, handle: 'test.example.com', pds: 'https://pds.example.com' }) }
	};
	const auth = createAtprotoBrowserAuth(config);
	let user;
	auth.user.subscribe(value => { user = value; });
	return { browser, server, auth, config, user: () => user };
}
function callback(ctx, scope) {
	const state = ctx.server.requests.findLast(request => request.path === '/par').body.get('state');
	ctx.server.tokens.set(state, { scope });
	window.location.hash = `#code=${state}&state=${state}&iss=https://as.example.com`;
	return { state, hash: window.location.hash };
}
async function login(ctx) {
	await ctx.auth.login('test.example.com', { scope: 'atproto' });
	callback(ctx, 'atproto');
	await ctx.auth.init();
}

test('real browser SDK callback and logout serialize without resurrecting the stored session', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	callback(ctx, `atproto ${POST}`);
	const entered = Promise.withResolvers(), released = Promise.withResolvers();
	const fetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (new URL(url).pathname === '/token') {
			entered.resolve();
			await released.promise;
		}
		return fetch(input, init);
	};
	const pending = ctx.auth.init();
	await entered.promise;
	let loggedOut = false;
	const logout = ctx.auth.logout().then(() => { loggedOut = true; });
	try {
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(loggedOut, false);
	} finally {
		released.resolve();
		await Promise.all([pending, logout]);
	}
	assert.equal(ctx.user().isLoggedIn, false);
	assert.equal(sdk.listStoredSessions().includes(DID), false);
	assert.equal(localStorage.getItem('atproto-current-login'), null);
	assert.ok(ctx.server.requests.some(request => request.path === '/revoke'));
});

test('a fresh browser auth instance can sign out the selected SDK session without init', async () => {
	const ctx = setup();
	await login(ctx);
	const other = createAtprotoBrowserAuth(ctx.config);
	await other.logout();
	assert.equal(sdk.listStoredSessions().includes(DID), false);
	assert.equal(localStorage.getItem('atproto-current-login'), null);
	assert.ok(ctx.server.requests.some(request => request.path === '/revoke'));
});

test('real browser SDK rejects an old upgrade before exchange after same-DID logout/relogin', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	const old = callback(ctx, `atproto ${POST}`);
	const pendingKey = `svelte-atproto:pending:${ctx.auth.metadata.client_id}`;
	const pending = sessionStorage.getItem(pendingKey);
	await ctx.auth.logout();
	await login(ctx);
	const replacement = await sdk.getSession(DID);
	const exchanges = ctx.server.requests.filter(request => request.path === '/token').length;
	sessionStorage.setItem(pendingKey, pending);
	window.location.hash = old.hash;
	await ctx.auth.init();
	assert.equal(ctx.user().authorizationError, 'stale_upgrade');
	assert.equal((await sdk.getSession(DID)).token.access, replacement.token.access);
	assert.equal(ctx.server.requests.filter(request => request.path === '/token').length, exchanges);
	await assert.rejects(sdk.finalizeAuthorization(new URLSearchParams(old.hash.slice(1))), /unknown state/);
});
