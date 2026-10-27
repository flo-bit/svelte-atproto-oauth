import './support/register.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	browserRuntime,
	browserSession,
	DID,
	OTHER_DID,
	POST,
	INCLUDE,
	BLOB
} from './support/runtime.mjs';
const { createAtprotoBrowserAuth } = await import('../src/browser/index.ts');
const { TokenRefreshError } = await import('./support/browser-sdk.mjs');
const config = { origin: 'https://client.example.com', scope: ['atproto', POST, INCLUDE, BLOB] };
const repo = { type: 'repo', collection: 'app.example.post', action: 'create' };
function setup() {
	const t = browserRuntime();
	const auth = createAtprotoBrowserAuth(config);
	let user;
	auth.user.subscribe((s) => {
		user = s;
	});
	return { t, auth, user: () => user };
}
async function complete(ctx, grant, did = DID) {
	ctx.t.next = browserSession(grant, did);
	window.location.hash = '#code=SCRIPTED&state=SCRIPTED&iss=https://as.example.com';
	await ctx.auth.init();
}
async function login(ctx, requested = 'atproto', grant = requested) {
	await ctx.auth.login('test.example.com', { scope: requested });
	await complete(ctx, grant);
}

test('browser default request is backwards compatible; overrides request exact scopes', async () => {
	const ctx = setup();
	await ctx.auth.login('test.example.com');
	assert.equal(ctx.t.flow.scope, config.scope.join(' '));
	await ctx.auth.login('test.example.com', { scope: 'atproto' });
	assert.equal(ctx.t.flow.scope, 'atproto');
	await complete(ctx, 'atproto');
	assert.equal(ctx.user().isLoggedIn, true);
	assert.deepEqual((await ctx.auth.getPermissions()).requestedScope, ['atproto']);
});
test('browser rejects undeclared request and empty incremental scopes', async () => {
	const ctx = setup();
	await assert.rejects(
		ctx.auth.login('test.example.com', { scope: 'atproto repo:*' }),
		/not declared/
	);
	await login(ctx);
	await assert.rejects(ctx.auth.requestPermissions(''), /At least one/);
});
test('browser include grant is checked concretely and include request retained on upgrade', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	assert.equal(await ctx.auth.can(repo), true);
	await ctx.auth.requestPermissions(BLOB);
	assert.equal(ctx.t.flow.scope, `atproto ${INCLUDE} ${BLOB}`);
	assert.equal(ctx.t.flow.target.identifier, DID);
	await complete(ctx, `atproto ${POST} ${BLOB}`);
	assert.equal(await ctx.auth.can({ type: 'blob', mimeType: 'image/png' }), true);
	assert.deepEqual((await ctx.auth.getPermissions()).requestedScope, ['atproto', INCLUDE, BLOB]);
});
test('already-granted scopes or concrete permission-set requirements avoid navigation', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	const count = ctx.t.assigned.length;
	await ctx.auth.requestPermissions(POST);
	await ctx.auth.requestPermissions(INCLUDE, { requirements: [repo] });
	assert.equal(ctx.t.assigned.length, count);
});
test('scope changes and expanded grants no longer trigger browser auto-signout', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	const changed = createAtprotoBrowserAuth({
		...config,
		scope: [...config.scope, 'repo:app.example.newRecord']
	});
	await changed.init();
	assert.equal((await changed.getPermissions()).did, DID);
	assert.equal(ctx.t.revoked.length, 0);
});
test('legacy browser expanded grant stays signed in but ambiguous upgrade needs explicit recovery', async () => {
	const ctx = setup();
	// No POST token is declared, so an expansion cannot be reconstructed as a direct request.
	const auth = createAtprotoBrowserAuth({ ...config, scope: ['atproto', INCLUDE, BLOB] });
	ctx.t.sessions.set(DID, browserSession(`atproto ${POST}`));
	localStorage.setItem('atproto-current-login', DID);
	await auth.init();
	assert.equal((await auth.getPermissions()).requestedScope, null);
	await assert.rejects(auth.requestPermissions(BLOB), /Previous requested scopes are unknown/);
	await auth.requestPermissions(BLOB, { previousScope: `atproto ${INCLUDE}` });
	assert.equal(ctx.t.flow.scope, `atproto ${INCLUDE} ${BLOB}`);
});
test('browser partial grant reports missing newly requested permissions', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	await complete(ctx, 'atproto');
	assert.equal(ctx.user().authorizationError, 'permissions_missing');
	assert.equal(ctx.user().isLoggedIn, true);
	assert.equal(await ctx.auth.can(repo), false);
	assert.equal(ctx.user().authorizationError, 'permissions_missing');
});
test('browser reports missing concrete permission-set requirements after authorization', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(INCLUDE, {
		requirements: [{ ...repo, collection: 'app.example.newRecord' }]
	});
	await complete(ctx, `atproto ${POST}`);
	assert.equal(ctx.user().authorizationError, 'permissions_missing');
});
test('declined browser upgrade retains login and returns to the originating page', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST, { returnTo: '/compose?draft=1' });
	window.location.hash = '#error=access_denied&state=SCRIPTED';
	await ctx.auth.init();
	assert.equal(ctx.user().did, DID);
	assert.equal(ctx.user().authorizationError, 'denied');
	assert.equal(ctx.t.replaced.at(-1), '/compose?draft=1');
	assert.deepEqual(ctx.user().permissions.grantedScope, ['atproto']);
});
function afterReturnNavigation(authConfig = config) {
	const destination = new URL(globalThis.authTest.replaced.at(-1), config.origin);
	Object.assign(window.location, {
		pathname: destination.pathname, search: destination.search, hash: destination.hash
	});
	const auth = createAtprotoBrowserAuth(authConfig);
	let user;
	auth.user.subscribe((s) => { user = s; });
	return { auth, user: () => user };
}
for (const outcome of ['denied', 'failed', 'permissions_missing', 'reduced_grant', 'identity_mismatch', 'stale_upgrade']) {
	test(`browser ${outcome} survives return navigation and is consumed once`, async () => {
		const ctx = setup();
		await login(ctx, outcome === 'reduced_grant' ? `atproto ${POST}` : 'atproto');
		await ctx.auth.requestPermissions(outcome === 'reduced_grant' ? BLOB : POST, {
			returnTo: '/compose?draft=1#edit'
		});
		if (outcome === 'denied') {
			window.location.hash = '#error=access_denied&state=SCRIPTED';
			await ctx.auth.init();
		} else {
			if (outcome === 'failed') ctx.t.callbackError = new Error('scripted failure');
			if (outcome === 'stale_upgrade') {
				const key = [...Array(localStorage.length)].map((_, i) => localStorage.key(i))
					.find((s) => s.startsWith('svelte-atproto:requested:'));
				localStorage.setItem(key, JSON.stringify({ version: 1, requestedScope: ['atproto', BLOB] }));
			}
			await complete(ctx, outcome === 'reduced_grant' ? `atproto ${BLOB}` : 'atproto',
				outcome === 'identity_mismatch' ? OTHER_DID : DID);
		}
		assert.equal(ctx.user().authorizationError, outcome);
		assert.equal(ctx.t.replaced.at(-1), '/compose?draft=1#edit');
		const returned = afterReturnNavigation();
		await returned.auth.init();
		assert.equal(returned.user().authorizationError, outcome);
		assert.equal(returned.user().did, DID);
		await returned.auth.getPermissions();
		assert.equal(returned.user().authorizationError, outcome);
		assert.equal(sessionStorage.length, 0, 'outcome should be consumed on arrival');
		const reloaded = afterReturnNavigation();
		await reloaded.auth.init();
		assert.equal(reloaded.user().authorizationError, null);
	});
}
test('signed-out browser denial survives return navigation without a session', async () => {
	const ctx = setup();
	await ctx.auth.login('test.example.com', { scope: 'atproto', returnTo: '/login' });
	window.location.hash = '#error=access_denied&state=SCRIPTED';
	await ctx.auth.init();
	const returned = afterReturnNavigation();
	await returned.auth.init();
	assert.equal(returned.user().authorizationError, 'denied');
	assert.equal(returned.user().isLoggedIn, false);
});
test('browser return outcome is discarded if the current account changes', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST, { returnTo: '/compose' });
	await complete(ctx, 'atproto');
	ctx.t.sessions.set(OTHER_DID, browserSession('atproto', OTHER_DID));
	localStorage.setItem('atproto-current-login', OTHER_DID);
	const returned = afterReturnNavigation();
	await returned.auth.init();
	assert.equal(returned.user().did, OTHER_DID);
	assert.equal(returned.user().authorizationError, null);
	assert.equal(sessionStorage.length, 0);
});
test('browser return outcomes are isolated by OAuth client metadata', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST, { returnTo: '/compose' });
	await complete(ctx, 'atproto');
	const otherClient = afterReturnNavigation({ ...config, metadataPath: '/other-metadata.json' });
	await otherClient.auth.init();
	assert.equal(otherClient.user().authorizationError, null);
	assert.equal(sessionStorage.length, 1, 'another client must not consume this outcome');
	const returned = afterReturnNavigation();
	await returned.auth.init();
	assert.equal(returned.user().authorizationError, 'permissions_missing');
});
for (const value of [
	'not JSON',
	JSON.stringify({ version: 1, did: DID, error: 'raw upstream message' }),
	JSON.stringify({ version: 2, did: DID, error: 'denied' }),
	JSON.stringify({ version: 1, error: 'denied' })
]) {
	test(`invalid stored browser outcome is discarded: ${value}`, async () => {
		const ctx = setup();
		await login(ctx);
		sessionStorage.setItem(`svelte-atproto:outcome:${ctx.auth.metadata.client_id}`, value);
		const returned = createAtprotoBrowserAuth(config);
		let user;
		returned.user.subscribe((s) => { user = s; });
		await returned.init();
		assert.equal(user.authorizationError, null);
		assert.equal(sessionStorage.length, 0);
	});
}
test('same-page browser authorization errors need no stored return outcome', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST, { returnTo: '/' });
	await complete(ctx, 'atproto');
	assert.equal(ctx.user().authorizationError, 'permissions_missing');
	assert.equal(ctx.t.replaced.length, 0);
	assert.equal(sessionStorage.length, 0);
});
test('logout clears a browser outcome awaiting return navigation', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST, { returnTo: '/compose' });
	await complete(ctx, 'atproto');
	await ctx.auth.logout();
	const returned = afterReturnNavigation();
	await returned.auth.init();
	assert.equal(returned.user().authorizationError, null);
	assert.equal(sessionStorage.length, 0);
});
test('successful browser return navigation does not report an authorization error', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST, { returnTo: '/compose' });
	await complete(ctx, `atproto ${POST}`);
	const returned = afterReturnNavigation();
	await returned.auth.init();
	assert.equal(returned.user().authorizationError, null);
	assert.deepEqual(returned.user().permissions.grantedScope, ['atproto', POST]);
	assert.equal(sessionStorage.length, 0);
});
test('browser rejects unexpected identity and revokes the new mismatched session', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	await complete(ctx, `atproto ${POST}`, OTHER_DID);
	assert.equal(ctx.user().did, DID);
	assert.equal(ctx.user().authorizationError, 'identity_mismatch');
	assert.deepEqual(ctx.t.revoked, [OTHER_DID]);
	assert.equal(ctx.t.sessions.has(OTHER_DID), false);
});
test('browser reduced grant exposes real capabilities and an explicit error, never false success', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${POST}`);
	await ctx.auth.requestPermissions(BLOB);
	await complete(ctx, `atproto ${BLOB}`);
	assert.equal(ctx.user().authorizationError, 'reduced_grant');
	assert.equal(ctx.user().isLoggedIn, true);
	assert.deepEqual(ctx.user().permissions.grantedScope, ['atproto', BLOB]);
	assert.equal(await ctx.auth.can(repo), false);
});
test('browser retains conservation evidence if the old SDK session disappears during authorization', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${POST}`);
	await ctx.auth.requestPermissions(BLOB);
	ctx.t.sessions.delete(DID);
	await complete(ctx, `atproto ${BLOB}`);
	assert.equal(ctx.user().authorizationError, 'reduced_grant');
	assert.equal(ctx.user().did, DID);
});
test('stale browser upgrade is rejected before callback replacement', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(BLOB);
	const old = ctx.t.sessions.get(DID);
	const key = [...Array(localStorage.length)]
		.map((_, i) => localStorage.key(i))
		.find((s) => s.startsWith('svelte-atproto:requested:'));
	localStorage.setItem(key, JSON.stringify({ version: 1, requestedScope: ['atproto', POST] }));
	await complete(ctx, `atproto ${BLOB}`);
	assert.equal(ctx.user().authorizationError, 'stale_upgrade');
	assert.equal(ctx.t.sessions.get(DID), old);
});
test('refresh can update permission-set capabilities while preserving request history', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	const next = { type: 'repo', collection: 'app.example.newRecord', action: 'create' };
	assert.equal(await ctx.auth.can(next), false);
	ctx.t.refreshed = browserSession(`atproto ${POST} repo:app.example.newRecord`);
	assert.equal(await ctx.auth.can(next, { refresh: true }), true);
	assert.deepEqual((await ctx.auth.getPermissions()).requestedScope, ['atproto', INCLUDE]);
});
test('transient browser restore errors preserve persisted sessions for later retry', async () => {
	const ctx = setup();
	await login(ctx);
	ctx.t.resumeError = new TypeError('SCRIPTED network error');
	await ctx.auth.init();
	assert.equal(localStorage.getItem('atproto-current-login'), DID);
	assert.equal(ctx.t.sessions.has(DID), true);
	ctx.t.resumeError = null;
	await ctx.auth.init();
	assert.equal(ctx.user().did, DID);
});
test('browser signup accepts exact scope overrides and safe return paths', async () => {
	const ctx = setup();
	const auth = createAtprotoBrowserAuth({ ...config, signupPDS: 'https://pds.example.com' });
	await auth.signup({ scope: 'atproto', returnTo: '//evil.example' });
	assert.equal(ctx.t.flow.scope, 'atproto');
	assert.equal(ctx.t.flow.prompt, 'create');
	assert.equal(ctx.t.flow.state.returnTo, undefined);
});
test('legacy browser callback clears any history that belongs to a different request', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${POST}`);
	await ctx.auth.login(undefined, { scope: 'atproto' });
	ctx.t.callbackState = null;
	await complete(ctx, 'atproto');
	assert.equal((await ctx.auth.getPermissions()).requestedScope, null);
	assert.equal(ctx.user().did, DID);
});
test('repeated permission checks only notify subscribers when the session changes', async () => {
	const ctx = setup();
	await login(ctx, `atproto ${INCLUDE}`, `atproto ${POST}`);
	let notifications = 0;
	const unsubscribe = ctx.auth.user.subscribe(() => notifications++);
	const client = ctx.user().client;
	await ctx.auth.can(repo);
	await ctx.auth.getPermissions();
	assert.equal(notifications, 1);
	assert.equal(ctx.user().client, client);
	ctx.t.refreshed = browserSession(`atproto ${POST} ${BLOB}`);
	await ctx.auth.getPermissions({ refresh: true });
	assert.equal(notifications, 2);
	assert.deepEqual(ctx.user().permissions.grantedScope, ['atproto', POST, BLOB]);
	unsubscribe();
});
test('a failed restore leaves another tab’s newer current login in place', async () => {
	const ctx = setup();
	localStorage.setItem('atproto-current-login', DID);
	// Another tab switches to OTHER_DID while this tab's restore of DID is failing.
	Object.defineProperty(ctx.t, 'resumeError', {
		get() {
			localStorage.setItem('atproto-current-login', OTHER_DID);
			return new TokenRefreshError('session deleted');
		}
	});
	await ctx.auth.init();
	assert.equal(ctx.user().isLoggedIn, false);
	assert.equal(localStorage.getItem('atproto-current-login'), OTHER_DID);
});
test('browser logout removes session, history and pending flow', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.logout();
	assert.equal(ctx.user().isLoggedIn, false);
	assert.equal(localStorage.length, 0);
	assert.equal(sessionStorage.length, 0);
	assert.deepEqual(ctx.t.revoked, [DID]);
});
const pendingKey = `svelte-atproto:pending:${config.origin}/oauth-client-metadata.json`;
const generationKey = `svelte-atproto:session:${config.origin}/oauth-client-metadata.json:${DID}`;

test('browser logout waits for an in-flight upgrade and deletes its replacement session', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	const entered = Promise.withResolvers(), released = Promise.withResolvers();
	ctx.t.beforeFinalize = async () => { entered.resolve(); await released.promise; };
	const callback = complete(ctx, `atproto ${POST}`);
	await entered.promise;
	let loggedOut = false;
	const logout = ctx.auth.logout().then(() => { loggedOut = true; });
	try {
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(loggedOut, false, 'logout must wait for the SDK store-before-return commit');
	} finally {
		released.resolve();
		await Promise.all([callback, logout]);
	}
	assert.equal(ctx.user().isLoggedIn, false);
	assert.equal(ctx.t.sessions.has(DID), false);
	assert.equal(localStorage.length, 0);
	assert.equal(sessionStorage.length, 0);
});

test('an upgrade in another auth instance waits for logout and is rejected before exchange', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	const pending = sessionStorage.getItem(pendingKey);
	const entered = Promise.withResolvers(), released = Promise.withResolvers();
	ctx.t.beforeSignOut = async () => { entered.resolve(); await released.promise; };
	const logout = ctx.auth.logout();
	await entered.promise;
	// Another tab has its own pending flow, but shares selected-account storage and locks.
	const other = createAtprotoBrowserAuth(config);
	sessionStorage.setItem(pendingKey, pending);
	ctx.t.next = browserSession(`atproto ${POST}`);
	window.location.hash = '#code=SCRIPTED&state=SCRIPTED';
	const before = ctx.t.finalizations.length;
	const callback = other.init();
	try {
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(ctx.t.finalizations.length, before);
	} finally {
		released.resolve();
		await Promise.all([logout, callback]);
	}
	assert.equal(ctx.t.sessions.has(DID), false);
	assert.equal(localStorage.getItem('atproto-current-login'), null);
	assert.equal(ctx.t.finalizations.at(-1).get('error'), 'access_denied');
});

test('an old browser upgrade cannot replace a new login for the same DID after logout', async () => {
	const ctx = setup();
	await login(ctx);
	const originalGeneration = localStorage.getItem(generationKey);
	await ctx.auth.requestPermissions(POST);
	const oldFlow = ctx.t.flow.state;
	const pending = sessionStorage.getItem(pendingKey);
	await ctx.auth.logout();
	await login(ctx);
	const replacement = ctx.t.sessions.get(DID);
	const newGeneration = localStorage.getItem(generationKey);
	assert.notEqual(newGeneration, originalGeneration);
	sessionStorage.setItem(pendingKey, pending);
	ctx.t.callbackState = oldFlow;
	await complete(ctx, `atproto ${POST}`);
	assert.equal(ctx.user().authorizationError, 'stale_upgrade');
	assert.equal(ctx.t.sessions.get(DID), replacement);
	assert.equal(localStorage.getItem(generationKey), newGeneration);
	assert.equal(ctx.t.finalizations.at(-1).get('error'), 'access_denied');
});

test('browser generation survives refresh and upgrades; legacy assignment does not invent history', async () => {
	const ctx = setup();
	ctx.t.sessions.set(DID, browserSession('atproto'));
	localStorage.setItem('atproto-current-login', DID);
	await ctx.auth.init();
	assert.equal((await ctx.auth.getPermissions()).requestedScope, null);
	await ctx.auth.requestPermissions(POST);
	const generation = localStorage.getItem(generationKey);
	assert.ok(generation);
	assert.equal(ctx.t.flow.state.sessionId, generation);
	assert.equal((await ctx.auth.getPermissions()).requestedScope, null);
	await complete(ctx, `atproto ${POST}`);
	assert.equal(localStorage.getItem(generationKey), generation);
	ctx.t.refreshed = browserSession(`atproto ${POST}`);
	await ctx.auth.getPermissions({ refresh: true });
	assert.equal(localStorage.getItem(generationKey), generation);
	await ctx.auth.requestPermissions(BLOB);
	assert.equal(ctx.t.flow.state.sessionId, generation);
});

test('failed browser remote revocation still invalidates pending upgrades', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	const pending = sessionStorage.getItem(pendingKey);
	ctx.t.beforeSignOut = () => { throw new Error('Scripted revocation outage'); };
	await ctx.auth.logout();
	assert.equal(localStorage.getItem(generationKey), null);
	assert.equal(ctx.t.sessions.has(DID), false);
	sessionStorage.setItem(pendingKey, pending);
	await complete(ctx, `atproto ${POST}`);
	assert.equal(ctx.user().isLoggedIn, false);
	assert.equal(ctx.t.sessions.has(DID), false);
	assert.equal(ctx.t.finalizations.at(-1).get('error'), 'access_denied');
});

test('browser callbacks without tab-local pending state cannot overwrite a current login', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	const previous = ctx.t.sessions.get(DID);
	sessionStorage.removeItem(pendingKey);
	await complete(ctx, `atproto ${POST}`);
	assert.equal(ctx.t.sessions.get(DID), previous);
	assert.equal(ctx.user().authorizationError, 'failed');
	assert.equal(ctx.t.finalizations.at(-1).get('error'), 'access_denied');
});

test('legacy browser upgrades without a generation fail before replacing a session', async () => {
	const ctx = setup();
	await login(ctx);
	await ctx.auth.requestPermissions(POST);
	const flow = JSON.parse(sessionStorage.getItem(pendingKey));
	delete flow.sessionId;
	sessionStorage.setItem(pendingKey, JSON.stringify(flow));
	const previous = ctx.t.sessions.get(DID);
	await complete(ctx, `atproto ${POST}`);
	assert.equal(ctx.user().authorizationError, 'stale_upgrade');
	assert.equal(ctx.t.sessions.get(DID), previous);
});

test('browser auth fails closed when cross-tab Web Locks are unavailable', async () => {
	const ctx = setup();
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
	await assert.rejects(ctx.auth.init(), /Web Locks/);
	await assert.rejects(ctx.auth.login('test.example.com'), /Web Locks/);
	assert.equal(ctx.t.assigned.length, 0);
});

test('browser init is SSR-safe and does not navigate', async () => {
	const ctx = setup();
	delete globalThis.window;
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
	await ctx.auth.init();
	assert.equal(ctx.user().isInitializing, false);
	assert.deepEqual(await ctx.auth.getPermissions(), { did: null, requestedScope: null, grantedScope: [] });
	assert.equal(await ctx.auth.can(repo), false);
	assert.equal(ctx.t.assigned.length, 0);
});
