import './support/register.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	nodeRuntime,
	memoryStore,
	DID,
	OTHER_DID,
	POST,
	INCLUDE,
	BLOB,
	event
} from './support/runtime.mjs';
const { createAtprotoAuth } = await import('../src/server/index.ts');
const { resolveConfig } = await import('../src/server/config.ts');
const { createOAuthClient } = await import('../src/server/oauth.ts');
const { restoreSession } = await import('../src/server/session.ts');
const { setSignedCookie, getSignedCookie } = await import('../src/server/cookie.ts');
const { authorizationSessions } = await import('../src/server/authorization.ts');
const secret = 'TEST-ONLY-cookie-secret';
function setup(scope = ['atproto', POST, INCLUDE, BLOB]) {
	const t = nodeRuntime();
	const sessions = memoryStore(),
		states = memoryStore();
	const config = { scope, cookieSecret: secret, sessions, states };
	const auth = createAtprotoAuth(config);
	return { t, sessions, states, config, auth };
}
async function callback(ctx, grant, { stateId, error, did = DID } = {}) {
	stateId ??= [...ctx.states.data.keys()].at(-1);
	const code = `code-${stateId}`;
	ctx.t.tokens.set(code, { scope: grant, did });
	const params = new URLSearchParams({
		state: stateId,
		iss: 'https://as.example.com',
		...(error ? { error } : { code })
	});
	ctx.t.event.url = new URL(`https://client.example.com/oauth/callback?${params}`);
	try {
		await ctx.auth.handlers.callback(ctx.t.event);
		assert.fail('Expected redirect');
	} catch (e) {
		assert.equal(e.status, 303, e.message);
		return e.location;
	}
}
async function restore(ctx) {
	const locals = await restoreSession(ctx.t.event, resolveConfig(ctx.config));
	Object.assign(ctx.t.event.locals, locals);
	return locals;
}
async function login(ctx, scope = 'atproto', grant = scope) {
	await ctx.auth.api.startLogin({ handle: 'test.example.com', scope });
	assert.equal(await callback(ctx, grant), '/');
	await restore(ctx);
}

test('existing login requests configured scope; override requests exactly identity', async () => {
	const ctx = setup();
	await ctx.auth.api.startLogin({ handle: 'test.example.com' });
	assert.equal(
		ctx.t.requests.findLast((r) => r.path === '/par').body.get('scope'),
		['atproto', POST, INCLUDE, BLOB].join(' ')
	);
	await ctx.auth.api.startLogin({
		handle: 'test.example.com',
		scope: 'atproto',
		returnTo: '/compose'
	});
	assert.equal(ctx.t.requests.findLast((r) => r.path === '/par').body.get('scope'), 'atproto');
	assert.equal(await callback(ctx, 'atproto'), '/compose');
	assert.deepEqual(ctx.sessions.data.get(DID).svelteAtproto.requestedScope, ['atproto']);
});
test('undeclared scope and missing identity fail before network calls', async () => {
	const ctx = setup();
	await assert.rejects(
		ctx.auth.api.startLogin({ handle: 'test.example.com', scope: 'atproto repo:*' }),
		(e) => e.status === 400
	);
	await assert.rejects(ctx.auth.api.startLogin({ scope: 'atproto' }), (e) => e.status === 400);
	assert.equal(ctx.t.requests.length, 0);
});
test('include request and expanded grant remain distinct across restore and refresh', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	assert.deepEqual(await ctx.auth.api.getPermissions(), {
		did: DID,
		requestedScope: ['atproto', INCLUDE],
		grantedScope: ['atproto', POST]
	});
	assert.equal(
		await ctx.auth.api.can({ type: 'repo', collection: 'app.example.newRecord', action: 'create' }),
		false
	);
	ctx.t.nextRefreshScope = `atproto ${POST} repo:app.example.newRecord`;
	assert.equal(
		await ctx.auth.api.can(
			{ type: 'repo', collection: 'app.example.newRecord', action: 'create' },
			{ refresh: true }
		),
		true
	);
	assert.deepEqual((await ctx.auth.api.getPermissions()).requestedScope, ['atproto', INCLUDE]);
	assert.ok(
		ctx.t.requests.some((r) => r.path === '/token' && r.body.get('grant_type') === 'refresh_token')
	);
});
test('incremental request retains original include token and binds to the current DID', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	await ctx.auth.api.requestPermissions({ scope: BLOB, returnTo: '/attach?draft=1' });
	const state = [...ctx.states.data.values()].at(-1).userState;
	assert.deepEqual(state.requestedScope, ['atproto', INCLUDE, BLOB]);
	assert.equal(state.expectedDid, DID);
	assert.equal(await callback(ctx, `atproto ${POST} ${BLOB}`), '/attach?draft=1');
	await restore(ctx);
	assert.equal(await ctx.auth.api.can({ type: 'blob', mimeType: 'image/png' }), true);
});
test('already granted direct permissions and concrete include requirements skip redirects', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	const count = ctx.t.requests.length;
	assert.deepEqual(await ctx.auth.api.requestPermissions({ scope: POST }), { url: null });
	assert.deepEqual(
		await ctx.auth.api.requestPermissions({
			scope: INCLUDE,
			requirements: [{ type: 'repo', collection: 'app.example.post', action: 'create' }]
		}),
		{ url: null }
	);
	assert.equal(ctx.t.requests.length, count);
	assert.ok((await ctx.auth.api.requestPermissions({ scope: INCLUDE })).url);
});
test('partial grant reports missing new permissions without claiming a successful upgrade', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST, returnTo: '/compose' });
	assert.equal(await callback(ctx, 'atproto'), '/compose?error=permissions_missing');
	await restore(ctx);
	assert.equal((await ctx.auth.api.getPermissions()).did, DID);
	assert.equal(
		await ctx.auth.api.can({ type: 'repo', collection: 'app.example.post', action: 'create' }),
		false
	);
});
for (const returnTo of ['/a/..//evil.example', '/%2e%2e//evil.example', '/a/%2E%2e//evil.example']) {
	for (const outcome of ['auth_denied', 'auth_failed', 'permissions_missing']) {
		test(`callback ${outcome} cannot turn ${returnTo} into an external redirect`, async () => {
			const ctx = setup();
			if (outcome === 'permissions_missing') {
				await login(ctx);
				await ctx.auth.api.requestPermissions({ scope: POST, returnTo });
			} else {
				await ctx.auth.api.startLogin({ handle: 'test.example.com', scope: 'atproto', returnTo });
			}
			if (outcome === 'auth_failed') ctx.t.tokenError = true;
			const location = await callback(ctx, 'atproto', {
				error: outcome === 'auth_denied' ? 'access_denied' : undefined
			});
			assert.equal(location, `/?error=${outcome}`);
			assert.equal(new URL(location, 'https://client.example.com').origin, 'https://client.example.com');
		});
	}
}
test('callback error redirects preserve local encoded paths, queries, and fragments', async () => {
	const ctx = setup();
	await ctx.auth.api.startLogin({
		handle: 'test.example.com', scope: 'atproto',
		returnTo: '/team/%F0%9F%8C%B1?draft=hello%20world#step%202'
	});
	assert.equal(
		await callback(ctx, '', { error: 'access_denied' }),
		'/team/%F0%9F%8C%B1?draft=hello+world&error=auth_denied#step%202'
	);
});
test('legacy callback error return cookies cannot normalize into external redirects', async () => {
	const ctx = setup();
	ctx.t.event.cookies.set('oauth_return_to', '/a/..//evil.example');
	assert.equal(await callback(ctx, '', { stateId: 'unknown', error: 'access_denied' }), '/?error=auth_denied');
});
test('missing concrete permission-set requirements are reported even if the include was requested', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({
		scope: INCLUDE,
		requirements: [{ type: 'repo', collection: 'app.example.newRecord', action: 'create' }]
	});
	assert.equal(await callback(ctx, `atproto ${POST}`), '/?error=permissions_missing');
});
test('already granted concrete features skip even when legacy include history is unknown', async () => {
	const ctx = setup(['atproto', INCLUDE, BLOB]);
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	delete ctx.sessions.data.get(DID).svelteAtproto;
	assert.deepEqual(
		await ctx.auth.api.requestPermissions({
			scope: INCLUDE,
			requirements: [{ type: 'repo', collection: 'app.example.post', action: 'create' }]
		}),
		{ url: null }
	);
	await assert.rejects(
		ctx.auth.api.requestPermissions({ scope: BLOB }),
		/Previous requested scopes are unknown/
	);
});
test('declining an upgrade consumes state and preserves the existing session', async () => {
	const ctx = setup();
	await login(ctx);
	const before = ctx.sessions.data.get(DID);
	await ctx.auth.api.requestPermissions({ scope: POST, returnTo: '/compose?draft=1' });
	assert.equal(
		await callback(ctx, '', { error: 'access_denied' }),
		'/compose?draft=1&error=auth_denied'
	);
	assert.equal(ctx.sessions.data.get(DID), before);
	assert.equal((await restore(ctx)).did, DID);
	assert.equal(ctx.states.data.size, 0);
});
test('a reduced upgrade grant is rejected before SDK replacement and the new token is revoked', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${POST}`);
	const before = ctx.sessions.data.get(DID);
	await ctx.auth.api.requestPermissions({ scope: BLOB });
	assert.equal(await callback(ctx, `atproto ${BLOB}`), '/?error=auth_failed');
	assert.equal(ctx.sessions.data.get(DID), before);
	assert.ok(ctx.t.requests.some((r) => r.path === '/revoke'));
});
test('upgrade conservation uses its grant snapshot even if a refresh removed the old record', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${POST}`);
	await ctx.auth.api.requestPermissions({ scope: BLOB });
	ctx.sessions.data.delete(DID);
	assert.equal(await callback(ctx, `atproto ${BLOB}`), '/?error=auth_failed');
	assert.equal(ctx.sessions.data.has(DID), false);
});
test('identity mismatch is rejected by the real SDK and never replaces the original account', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	assert.equal(await callback(ctx, `atproto ${POST}`, { did: OTHER_DID }), '/?error=auth_failed');
	assert.equal(await getSignedCookie(ctx.t.event.cookies, 'did', secret), DID);
	assert.equal(ctx.sessions.data.has(OTHER_DID), false);
});
test('scope changes retain old login; signed legacy scope cookie migrates the original request', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	delete ctx.sessions.data.get(DID).svelteAtproto;
	await setSignedCookie(ctx.t.event.cookies, 'scope', `atproto ${INCLUDE}`, secret, { path: '/' });
	const changed = resolveConfig({
		...ctx.config,
		scope: ['atproto', INCLUDE, BLOB, 'repo:app.example.newRecord']
	});
	assert.equal((await restoreSession(ctx.t.event, changed)).did, DID);
	assert.deepEqual(ctx.sessions.data.get(DID).svelteAtproto.requestedScope, ['atproto', INCLUDE]);
	assert.equal(ctx.t.event.cookies.get('scope'), undefined);
});
test('unknown history does not assume today’s configured scopes were requested', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	delete ctx.sessions.data.get(DID).svelteAtproto;
	assert.equal((await ctx.auth.api.getPermissions()).requestedScope, null);
	// POST is explicitly declared here, so exact direct grant reconstruction is possible.
	await ctx.auth.api.requestPermissions({ scope: BLOB });
	assert.deepEqual([...ctx.states.data.values()].at(-1).userState.requestedScope, [
		'atproto',
		POST,
		BLOB
	]);
});
test('simultaneous flows have separate return paths and stale upgrades cannot remove newer requests', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST, returnTo: '/first' });
	const first = [...ctx.states.data.keys()].at(-1);
	await ctx.auth.api.requestPermissions({ scope: BLOB, returnTo: '/second' });
	const second = [...ctx.states.data.keys()].at(-1);
	assert.equal(await callback(ctx, `atproto ${POST}`, { stateId: first }), '/first');
	assert.equal(
		await callback(ctx, `atproto ${POST} ${BLOB}`, { stateId: second }),
		'/second?error=auth_failed'
	);
	assert.deepEqual(ctx.sessions.data.get(DID).svelteAtproto.requestedScope, ['atproto', POST]);
});
test('state replay and forged state are rejected without deleting a valid session', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const stateId = [...ctx.states.data.keys()].at(-1);
	assert.equal(await callback(ctx, `atproto ${POST}`, { stateId }), '/');
	assert.equal(await callback(ctx, `atproto ${POST}`, { stateId }), '/?error=auth_failed');
	assert.equal(await callback(ctx, 'atproto', { stateId: 'forged' }), '/?error=auth_failed');
	assert.equal((await restore(ctx)).did, DID);
});
test('transient refresh outage retains cookie and stored session for retry', async () => {
	const ctx = setup();
	await login(ctx);
	ctx.sessions.data.get(DID).tokenSet.expires_at = 0;
	ctx.t.tokenError = true;
	assert.equal((await restore(ctx)).did, null);
	assert.equal(await getSignedCookie(ctx.t.event.cookies, 'did', secret), DID);
	assert.equal(ctx.sessions.data.has(DID), true);
	ctx.t.tokenError = false;
	assert.equal((await restore(ctx)).did, DID);
});
test('SDK swallowing a transient store read does not clear the valid identity cookie', async () => {
	const ctx = setup();
	await login(ctx);
	const get = ctx.sessions.get;
	let failed = false;
	ctx.sessions.get = async (did) => {
		if (!failed) {
			failed = true;
			throw new Error('SCRIPTED storage outage');
		}
		return get(did);
	};
	assert.equal((await restore(ctx)).did, null);
	assert.equal(await getSignedCookie(ctx.t.event.cookies, 'did', secret), DID);
	assert.equal((await restore(ctx)).did, DID);
});
test('history read failure during refresh keeps the refreshed tokens instead of revoking them', async () => {
	const ctx = setup();
	await login(ctx);
	ctx.sessions.data.get(DID).tokenSet.expires_at = 0;
	const get = ctx.sessions.get;
	let reads = 0;
	// First read is the SDK's own lookup; the second is the history-preserving decorator.
	ctx.sessions.get = async (did) => {
		if (++reads === 2) throw new Error('SCRIPTED storage outage');
		return get(did);
	};
	assert.equal((await restore(ctx)).did, DID);
	assert.equal(ctx.t.requests.some((r) => r.path === '/revoke'), false);
	const stored = ctx.sessions.data.get(DID);
	assert.ok(stored.tokenSet.expires_at > Date.now());
	assert.equal(stored.svelteAtproto, undefined);
});
test('real revocation deletes the stored session and clears auth cookies', async () => {
	const ctx = setup();
	await login(ctx);
	ctx.sessions.data.get(DID).tokenSet.expires_at = 0;
	ctx.t.invalidGrant = true;
	assert.equal((await restore(ctx)).did, null);
	assert.equal(ctx.sessions.data.has(DID), false);
	assert.equal(ctx.t.event.cookies.get('did'), undefined);
});
test('new state-bound return paths neither inherit nor consume legacy return cookies', async () => {
	const ctx = setup();
	ctx.t.event.cookies.set('oauth_return_to', '/legacy', { path: '/' });
	await ctx.auth.api.startLogin({ handle: 'test.example.com', scope: 'atproto' });
	assert.equal(await callback(ctx, 'atproto'), '/');
	assert.equal(ctx.t.event.cookies.get('oauth_return_to'), '/legacy');
	await ctx.auth.api.startLogin({ scope: 'atproto' });
	[...ctx.states.data.values()].at(-1).userState = undefined;
	assert.equal(await callback(ctx, 'atproto'), '/legacy');
	assert.equal(ctx.t.event.cookies.get('oauth_return_to'), undefined);
});
test('POST endpoints restore locals first, accept scope overrides, and reject malformed input', async () => {
	const ctx = setup();
	await login(ctx);
	ctx.t.event.locals = {};
	ctx.t.event.url = new URL('https://client.example.com/oauth/permissions');
	ctx.t.event.request = new Request(ctx.t.event.url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ scope: POST })
	});
	const result = await ctx.auth.handle({
		event: ctx.t.event,
		resolve: () => assert.fail('Unexpected route')
	});
	assert.ok((await result.json()).url);
	ctx.t.event.request = new Request(ctx.t.event.url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: 'null'
	});
	assert.equal((await ctx.auth.handlers.permissions(ctx.t.event)).status, 400);
});
test('logout deletes session, request history, and cookies', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.logout();
	assert.equal(ctx.sessions.data.has(DID), false);
	assert.equal(ctx.t.event.cookies.get('did'), undefined);
});
test('adapter decorator delegates clear and rejects missing identity grants', async () => {
	const store = memoryStore();
	const decorated = authorizationSessions(store, {
		expectedDid: DID,
		requestedScope: ['atproto'],
		upgrade: false
	});
	await assert.rejects(decorated.set(DID, { tokenSet: { scope: POST } }), /missing_identity/);
	await store.set(DID, {});
	await decorated.clear();
	assert.equal(store.data.size, 0);
});
test('legacy in-flight callback never substitutes today’s configuration for unknown request history', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${POST}`);
	await ctx.auth.api.startLogin({ scope: 'atproto' });
	[...ctx.states.data.values()].at(-1).userState = undefined;
	await setSignedCookie(ctx.t.event.cookies, 'scope', `atproto ${POST}`, secret, { path: '/' });
	assert.equal(await callback(ctx, 'atproto'), '/');
	assert.equal((await ctx.auth.api.getPermissions()).requestedScope, null);
	assert.equal(ctx.t.event.cookies.get('scope'), undefined);
});
test('concurrent callback commits serialize rather than losing a newer request union', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST, returnTo: '/first' });
	const first = [...ctx.states.data.keys()].at(-1);
	await ctx.auth.api.requestPermissions({ scope: BLOB, returnTo: '/second' });
	const second = [...ctx.states.data.keys()].at(-1);
	const set = ctx.sessions.set;
	ctx.sessions.set = async (...args) => {
		await new Promise((r) => setTimeout(r, 5));
		return set(...args);
	};
	const run = async (state, grant) => {
		const callbackEvent = event(
			`/oauth/callback?state=${state}&code=${state}&iss=https://as.example.com`
		);
		callbackEvent.cookies = ctx.t.event.cookies;
		ctx.t.tokens.set(state, { scope: grant });
		try {
			await ctx.auth.handlers.callback(callbackEvent);
		} catch (e) {
			assert.equal(e.status, 303);
			return e.location;
		}
	};
	const results = await Promise.all([
		run(first, `atproto ${POST}`),
		run(second, `atproto ${BLOB}`)
	]);
	assert.equal(results.filter((s) => s.includes('auth_failed')).length, 1);
	assert.equal(results.filter((s) => !s.includes('auth_failed')).length, 1);
});
test('refresh in flight cannot overwrite a subsequently completed upgrade', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const state = [...ctx.states.data.keys()].at(-1);
	const entered = Promise.withResolvers(),
		released = Promise.withResolvers();
	const transport = ctx.t.fetch;
	ctx.t.fetch = async (url, options) => {
		const request = url instanceof Request ? url : new Request(url, options);
		if (
			new URL(request.url).pathname === '/token' &&
			new URLSearchParams(await request.clone().text()).get('grant_type') === 'refresh_token'
		) {
			entered.resolve();
			await released.promise;
		}
		return transport(url, options);
	};
	const refresh = ctx.auth.api.getPermissions({ refresh: true });
	await entered.promise;
	const upgrade = callback(ctx, `atproto ${POST}`, { stateId: state });
	await new Promise((r) => setTimeout(r, 5));
	released.resolve();
	await refresh;
	assert.equal(await upgrade, '/');
	assert.equal(ctx.sessions.data.get(DID).tokenSet.scope, `atproto ${POST}`);
});
test('upgrade after signout fails and consumes its pending state', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const stateId = [...ctx.states.data.keys()].at(-1);
	await ctx.auth.api.logout();
	assert.equal(await callback(ctx, `atproto ${POST}`, { stateId }), '/?error=auth_failed');
	assert.equal(ctx.states.data.size, 0);
	assert.equal(ctx.sessions.data.has(DID), false);
});
test('an upgrade awaiting token exchange cannot recreate a session after logout', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const state = [...ctx.states.data.keys()].at(-1);
	ctx.t.tokens.set(state, { scope: `atproto ${POST}` });
	const callbackEvent = event(
		`/oauth/callback?state=${state}&code=${state}&iss=https://as.example.com`
	);
	// Separate requests retain their own incoming cookie jars even after logout.
	for (const { name, value } of ctx.t.event.cookies.getAll())
		callbackEvent.cookies.set(name, value);
	const cookieWrites = [];
	const setCookie = callbackEvent.cookies.set;
	callbackEvent.cookies.set = (...args) => {
		cookieWrites.push(args[0]);
		return setCookie(...args);
	};
	const entered = Promise.withResolvers(), released = Promise.withResolvers();
	const transport = ctx.t.fetch;
	ctx.t.fetch = async (url, options) => {
		const request = url instanceof Request ? url : new Request(url, options);
		if (new URL(request.url).pathname === '/token' &&
			new URLSearchParams(await request.clone().text()).get('code') === state) {
			entered.resolve();
			await released.promise;
		}
		return transport(url, options);
	};
	const upgrade = ctx.auth.handlers.callback(callbackEvent).catch((e) => {
		assert.equal(e.status, 303);
		return e.location;
	});
	await entered.promise;
	try {
		await ctx.auth.api.logout();
		assert.equal(ctx.sessions.data.has(DID), false);
	} finally {
		released.resolve();
	}
	assert.equal(await upgrade, '/?error=auth_failed');
	assert.equal(ctx.sessions.data.has(DID), false);
	assert.equal(ctx.states.data.size, 0);
	assert.equal(ctx.t.event.cookies.get('did'), undefined);
	assert.deepEqual(cookieWrites, [], 'rejected callback must not issue a fresh login cookie');
	assert.ok(ctx.t.requests.filter((r) => r.path === '/revoke' &&
		r.body.get('token')?.startsWith('TEST-ONLY-access-')).length >= 2,
		'both the old login and rejected callback token must be revoked');
});

test('an old upgrade cannot replace a new login for the same DID after logout', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const stateId = [...ctx.states.data.keys()].at(-1);
	await ctx.auth.api.logout();
	await login(ctx);
	const replacement = ctx.sessions.data.get(DID);
	assert.equal(await callback(ctx, `atproto ${POST}`, { stateId }), '/?error=auth_failed');
	assert.equal(ctx.sessions.data.get(DID), replacement);
	assert.equal(ctx.states.data.size, 0);
});

test('logout serializes with an upgrade commit already holding the session lock', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const entered = Promise.withResolvers(), released = Promise.withResolvers();
	const set = ctx.sessions.set;
	ctx.sessions.set = async (did, value) => {
		if (value.tokenSet.scope === `atproto ${POST}`) {
			entered.resolve();
			await released.promise;
		}
		return set(did, value);
	};
	const upgrade = callback(ctx, `atproto ${POST}`);
	await entered.promise;
	const logout = ctx.auth.api.logout();
	try {
		// Let logout reach its session lock while the commit is blocked.
		await new Promise((r) => setTimeout(r, 5));
	} finally {
		released.resolve();
	}
	await Promise.all([upgrade, logout]);
	assert.equal(ctx.sessions.data.has(DID), false);
	assert.equal(ctx.t.event.cookies.get('did'), undefined);
});

test('an upgrade waits for in-flight logout revocation and is rejected after deletion', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const stateId = [...ctx.states.data.keys()].at(-1);
	const entered = Promise.withResolvers(), released = Promise.withResolvers();
	const transport = ctx.t.fetch;
	let paused = false;
	ctx.t.fetch = async (url, options) => {
		const request = url instanceof Request ? url : new Request(url, options);
		if (new URL(request.url).pathname === '/revoke' && !paused) {
			paused = true;
			entered.resolve();
			await released.promise;
		}
		return transport(url, options);
	};
	const logout = ctx.auth.api.logout();
	await entered.promise;
	const upgrade = callback(ctx, `atproto ${POST}`, { stateId });
	try {
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(ctx.sessions.data.get(DID).tokenSet.scope, 'atproto');
	} finally {
		released.resolve();
	}
	await logout;
	assert.equal(await upgrade, '/?error=auth_failed');
	assert.equal(ctx.sessions.data.has(DID), false);
});

test('failed remote revocation still deletes the session and invalidates upgrades', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const stateId = [...ctx.states.data.keys()].at(-1);
	const transport = ctx.t.fetch;
	ctx.t.fetch = async (url, options) => {
		const request = url instanceof Request ? url : new Request(url, options);
		if (new URL(request.url).pathname === '/.well-known/oauth-authorization-server')
			throw new Error('SCRIPTED NETWORK OUTAGE');
		return transport(url, options);
	};
	await ctx.auth.api.logout();
	assert.equal(ctx.sessions.data.has(DID), false);
	ctx.t.fetch = transport;
	assert.equal(await callback(ctx, `atproto ${POST}`, { stateId }), '/?error=auth_failed');
});

test('login generation survives upgrades and refreshes; legacy assignment does not invent history', async () => {
	const ctx = setup();
	await login(ctx);
	const id = ctx.sessions.data.get(DID).svelteAtprotoSessionId;
	assert.equal(typeof id, 'string');
	await ctx.auth.api.requestPermissions({ scope: POST });
	assert.equal([...ctx.states.data.values()].at(-1).userState.sessionId, id);
	assert.equal(await callback(ctx, `atproto ${POST}`), '/');
	ctx.t.nextRefreshScope = `atproto ${POST}`;
	await ctx.auth.api.getPermissions({ refresh: true });
	assert.equal(ctx.sessions.data.get(DID).svelteAtprotoSessionId, id);
	delete ctx.sessions.data.get(DID).svelteAtprotoSessionId;
	delete ctx.sessions.data.get(DID).svelteAtproto;
	await ctx.auth.api.requestPermissions({ scope: BLOB });
	const legacy = ctx.sessions.data.get(DID);
	assert.equal(typeof legacy.svelteAtprotoSessionId, 'string');
	assert.equal(legacy.svelteAtproto, undefined);
	assert.equal([...ctx.states.data.values()].at(-1).userState.sessionId, legacy.svelteAtprotoSessionId);
});

test('concurrent callbacks for the same state exchange the code only once', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.api.requestPermissions({ scope: POST });
	const state = [...ctx.states.data.keys()].at(-1);
	ctx.t.tokens.set(state, { scope: `atproto ${POST}` });
	const run = async () => {
		const callbackEvent = event(
			`/oauth/callback?state=${state}&code=${state}&iss=https://as.example.com`
		);
		callbackEvent.cookies = ctx.t.event.cookies;
		try {
			await ctx.auth.handlers.callback(callbackEvent);
		} catch (e) {
			assert.equal(e.status, 303);
			return e.location;
		}
	};
	const results = await Promise.all([run(), run()]);
	assert.deepEqual(results.sort(), ['/', '/?error=auth_failed']);
	assert.equal(
		ctx.t.requests.filter((r) => r.path === '/token' && r.body.get('code') === state).length,
		1
	);
});
test('mounted POST endpoints reject cross-origin requests without changing authorization', async () => {
	const ctx = setup();
	await login(ctx);
	const before = ctx.sessions.data.get(DID);
	ctx.t.event.request = new Request('https://client.example.com/oauth/permissions', {
		method: 'POST',
		headers: { origin: 'https://other.example.com', 'content-type': 'application/json' },
		body: JSON.stringify({ scope: POST })
	});
	assert.equal((await ctx.auth.handlers.permissions(ctx.t.event)).status, 403);
	assert.equal((await ctx.auth.handlers.logout(ctx.t.event)).status, 403);
	assert.equal(ctx.sessions.data.get(DID), before);
});
test('custom production metadata/JWKS paths are used consistently', async () => {
	const ctx = setup();
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	]);
	const jwk = {
		...(await crypto.subtle.exportKey('jwk', pair.privateKey)),
		kid: 'test',
		alg: 'ES256'
	};
	const oauth = createOAuthClient(
		resolveConfig({
			...ctx.config,
			origin: 'https://client.example.com',
			metadataPath: '/auth/client.json',
			jwksPath: '/auth/keys.json',
			clientAssertionKey: JSON.stringify(jwk)
		})
	);
	assert.equal(oauth.metadata.client_id, 'https://client.example.com/auth/client.json');
	assert.equal(oauth.metadata.jwks_uri, 'https://client.example.com/auth/keys.json');
});
