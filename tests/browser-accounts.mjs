import './support/register.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserRuntime, browserSession, DID, OTHER_DID, POST } from './support/runtime.mjs';
const { createAtprotoBrowserAuth, AccountSwitchError } = await import('../src/browser/index.ts');
const { createAtprotoNetwork } = await import('../src/network/index.ts');
const config = { origin: 'https://client.example.com', scope: ['atproto', POST] };
const SELECTED = 'atproto-current-login';

// Scripted SDK and web storage. Each "tab" is an auth instance with its own listeners
// over shared storage; not a real-browser multi-tab test.
function tab(t, options = config, lock = 'svelte-atproto:lifecycle') {
	const listeners = [];
	// Listeners register lazily; route registrations made by this tab to its own list.
	const auth = createAtprotoBrowserAuth(options);
	let user, accounts;
	auth.user.subscribe((s) => (user = s));
	auth.accounts.subscribe((s) => (accounts = s));
	const bind = () => (window.addEventListener = (type, fn) => listeners.push({ type, fn }));
	return {
		t,
		auth,
		user: () => user,
		accounts: () => accounts,
		async run(operation) {
			bind();
			return operation(auth);
		},
		/** Deliver a storage event as another tab's write would. */
		async storage(key) {
			for (const l of listeners) if (l.type === 'storage') l.fn({ key, storageArea: localStorage });
			// Reconciliation is queued behind the lifecycle lock.
			await navigator.locks.request(lock, async () => {});
			await new Promise((resolve) => setImmediate(resolve));
		}
	};
}
function setup() {
	const t = browserRuntime();
	return tab(t);
}
async function login(ctx, did = DID, grant = 'atproto') {
	await ctx.run((auth) => auth.login(did, { scope: grant }));
	ctx.t.next = browserSession(grant, did);
	window.location.hash = '#code=SCRIPTED&state=SCRIPTED&iss=https://as.example.com';
	await ctx.run((auth) => auth.init());
}
const list = (ctx) => ctx.accounts().map((a) => `${a.did}${a.active ? '*' : ''}`);

test('adding an account retains the first and selects the new one', async () => {
	const ctx = setup();
	await login(ctx);
	assert.deepEqual(list(ctx), [`${DID}*`]);
	await login(ctx, OTHER_DID);
	assert.equal(ctx.user().did, OTHER_DID);
	assert.deepEqual(list(ctx), [DID, `${OTHER_DID}*`]);
	assert.deepEqual(ctx.t.revoked, []);
});
test('switching restores the retained session without authorization or revocation', async () => {
	const ctx = setup();
	await login(ctx, DID, `atproto ${POST}`);
	await login(ctx, OTHER_DID);
	const navigations = ctx.t.assigned.length;
	await ctx.auth.switchAccount(DID);
	assert.equal(ctx.user().did, DID);
	assert.equal(ctx.user().client !== null, true);
	assert.deepEqual(ctx.user().permissions.grantedScope, ['atproto', POST]);
	assert.equal(localStorage.getItem(SELECTED), DID);
	assert.deepEqual(list(ctx), [`${DID}*`, OTHER_DID]);
	await ctx.auth.switchAccount(OTHER_DID);
	assert.equal(ctx.user().did, OTHER_DID);
	assert.equal(ctx.t.assigned.length, navigations);
	assert.deepEqual(ctx.t.revoked, []);
});
test('a failed authorization keeps every retained account and the selection', async () => {
	const ctx = setup();
	await login(ctx);
	await login(ctx, OTHER_DID);
	await ctx.auth.login('third.example.com');
	window.location.hash = '#error=access_denied&state=SCRIPTED';
	await ctx.auth.init();
	assert.equal(ctx.user().did, OTHER_DID);
	assert.equal(ctx.user().authorizationError, 'denied');
	assert.deepEqual(list(ctx), [DID, `${OTHER_DID}*`]);
});
test('switching to a missing session requires reauthorization and keeps the active account', async () => {
	const ctx = setup();
	await login(ctx);
	localStorage.setItem(`svelte-atproto:requested:${config.origin}/oauth-client-metadata.json:${OTHER_DID}`, '{}');
	await assert.rejects(ctx.auth.switchAccount(OTHER_DID), (e) =>
		e instanceof AccountSwitchError && e.reason === 'reauthorization_required' && e.did === OTHER_DID
	);
	assert.equal(ctx.user().did, DID);
	assert.equal(localStorage.getItem(SELECTED), DID);
	assert.deepEqual(list(ctx), [`${DID}*`]);
	assert.equal(
		localStorage.getItem(`svelte-atproto:requested:${config.origin}/oauth-client-metadata.json:${OTHER_DID}`),
		null
	);
});
test('a transient failure while switching keeps both sessions', async () => {
	const ctx = setup();
	await login(ctx);
	await login(ctx, OTHER_DID);
	ctx.t.resumeError = new Error('offline');
	await assert.rejects(ctx.auth.switchAccount(DID), (e) =>
		e instanceof AccountSwitchError && e.reason === 'unavailable'
	);
	ctx.t.resumeError = null;
	assert.equal(ctx.user().did, OTHER_DID);
	assert.equal(ctx.t.sessions.has(DID), true);
	await ctx.auth.switchAccount(DID);
	assert.equal(ctx.user().did, DID);
});
test('logging out the active account leaves the other retained and nobody active', async () => {
	const ctx = setup();
	await login(ctx);
	await login(ctx, OTHER_DID);
	await ctx.auth.logout();
	assert.equal(ctx.user().isLoggedIn, false);
	assert.equal(localStorage.getItem(SELECTED), null);
	assert.deepEqual(list(ctx), [DID]);
	assert.deepEqual(ctx.t.revoked, [OTHER_DID]);
	await ctx.auth.switchAccount(DID);
	assert.equal(ctx.user().did, DID);
});
test('logging out an inactive account does not disturb the active one', async () => {
	const ctx = setup();
	await login(ctx);
	await login(ctx, OTHER_DID);
	const client = ctx.user().client;
	ctx.t.beforeSignOut = async () => { throw new Error('revocation endpoint down'); };
	await ctx.auth.logout({ did: DID });
	assert.equal(ctx.user().did, OTHER_DID);
	assert.equal(ctx.user().client, client);
	assert.equal(ctx.t.sessions.has(DID), false, 'local invalidation does not depend on revocation');
	assert.deepEqual(list(ctx), [`${OTHER_DID}*`]);
	assert.equal(localStorage.getItem(`svelte-atproto:session:${config.origin}/oauth-client-metadata.json:${DID}`), null);
});
test('logoutAll signs out every retained account', async () => {
	const ctx = setup();
	await login(ctx);
	await login(ctx, OTHER_DID);
	await ctx.auth.logoutAll();
	assert.equal(ctx.user().isLoggedIn, false);
	assert.deepEqual(ctx.accounts(), []);
	assert.deepEqual(ctx.t.revoked.sort(), [DID, OTHER_DID].sort());
	assert.equal(localStorage.length, 0);
	assert.equal(sessionStorage.length, 0);
});
test('an upgrade started by one account is rejected after switching, leaving both intact', async () => {
	const ctx = setup();
	await login(ctx);
	await login(ctx, OTHER_DID);
	await ctx.auth.switchAccount(DID);
	await ctx.auth.requestPermissions(POST);
	await ctx.auth.switchAccount(OTHER_DID);
	ctx.t.next = browserSession(`atproto ${POST}`, DID);
	window.location.hash = '#code=SCRIPTED&state=SCRIPTED&iss=https://as.example.com';
	await ctx.auth.init();
	assert.equal(ctx.user().did, OTHER_DID);
	assert.equal(ctx.user().authorizationError, 'identity_mismatch');
	assert.equal(ctx.t.sessions.get(DID).token.scope, 'atproto');
	assert.deepEqual(list(ctx), [DID, `${OTHER_DID}*`]);
});
test('other tabs follow a switch, a sign-out and a removed account', async () => {
	const a = setup();
	await login(a);
	await login(a, OTHER_DID);
	const b = tab(a.t);
	await b.run((auth) => auth.init());
	assert.equal(b.user().did, OTHER_DID);

	await a.auth.switchAccount(DID);
	assert.equal(b.user().did, OTHER_DID, 'not updated until the tab is notified');
	await b.storage(SELECTED);
	assert.equal(b.user().did, DID);
	assert.deepEqual(list(b), [`${DID}*`, OTHER_DID]);

	await a.auth.logout({ did: OTHER_DID });
	await b.storage(`atcute-oauth:sessions:${OTHER_DID}`);
	assert.deepEqual(list(b), [`${DID}*`]);
	assert.equal(b.user().did, DID);

	await a.auth.logout();
	await b.storage(SELECTED);
	assert.equal(b.user().isLoggedIn, false);
	assert.equal(b.user().client, null);
});
test('a tab that missed the event reconciles when it becomes visible', async () => {
	const a = setup();
	await login(a);
	await login(a, OTHER_DID);
	const listeners = [];
	window.addEventListener = (type, fn) => listeners.push({ type, fn });
	const b = createAtprotoBrowserAuth(config);
	let user;
	b.user.subscribe((s) => (user = s));
	await b.init();
	await a.auth.switchAccount(DID);
	globalThis.document = { visibilityState: 'visible' };
	try {
		for (const l of listeners) if (l.type === 'visibilitychange') l.fn();
		await navigator.locks.request('svelte-atproto:lifecycle', async () => {});
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		delete globalThis.document;
	}
	assert.equal(user.did, DID);
});
test('a legacy single-account browser lists its one session', async () => {
	const ctx = setup();
	ctx.t.sessions.set(DID, browserSession());
	localStorage.setItem(SELECTED, DID);
	await ctx.auth.init();
	assert.deepEqual(list(ctx), [`${DID}*`]);
});

test('other tabs pick up new permissions for the account they already show', async () => {
	const a = setup();
	await login(a);
	const b = tab(a.t);
	await b.run((auth) => auth.init());
	const client = b.user().client;
	assert.deepEqual(b.user().permissions.grantedScope, ['atproto']);

	await a.auth.requestPermissions(POST);
	a.t.next = browserSession(`atproto ${POST}`);
	a.t.next.token.access = 'TEST-ONLY-upgraded';
	window.location.hash = '#code=SCRIPTED&state=SCRIPTED&iss=https://as.example.com';
	await a.auth.init();
	assert.deepEqual(a.user().permissions.grantedScope, ['atproto', POST]);

	await b.storage(`atcute-oauth:sessions:${DID}`);
	assert.equal(b.user().did, DID);
	assert.deepEqual(b.user().permissions.grantedScope, ['atproto', POST]);
	assert.deepEqual(b.user().permissions.requestedScope, ['atproto', POST]);
	assert.notEqual(b.user().client, client, 'requests use the replacement session');
	assert.equal(b.user().agent.session.token.access, 'TEST-ONLY-upgraded');

	// The session disappearing elsewhere without a selection change signs this tab out too.
	a.t.sessions.delete(DID);
	await b.storage(`atcute-oauth:sessions:${DID}`);
	assert.equal(b.user().isLoggedIn, false);
});
test('a tab that is behind cannot sign out an account that is no longer active', async () => {
	const a = setup();
	await login(a);
	await login(a, OTHER_DID);
	await a.auth.switchAccount(DID);
	const b = tab(a.t);
	await b.run((auth) => auth.init());
	await b.auth.switchAccount(OTHER_DID);
	await b.auth.logout();
	assert.equal(localStorage.getItem(SELECTED), null);
	assert.equal(a.user().did, DID, 'this tab has not caught up');

	await a.auth.logout();
	assert.deepEqual(a.t.revoked, [OTHER_DID]);
	assert.equal(a.t.sessions.has(DID), true);
	assert.equal(a.user().isLoggedIn, false, 'it catches up instead');
	assert.deepEqual(list(a), [DID]);
	// An explicit DID still signs out an inactive account.
	await a.auth.logout({ did: DID });
	assert.deepEqual(a.t.revoked, [OTHER_DID, DID]);
	assert.deepEqual(a.accounts(), []);
});
test('a tab that is behind signs out the selected account, not the one it shows', async () => {
	const a = setup();
	await login(a);
	await login(a, OTHER_DID);
	const b = tab(a.t);
	await b.run((auth) => auth.init());
	await b.auth.switchAccount(DID);
	assert.equal(a.user().did, OTHER_DID);
	await a.auth.logout();
	assert.deepEqual(a.t.revoked, [DID]);
	assert.equal(a.t.sessions.has(OTHER_DID), true);
	assert.equal(a.user().isLoggedIn, false);
});
test('cross-tab restoration checks isolated-network egress before touching a session', async () => {
	const t = browserRuntime();
	const network = createAtprotoNetwork({
		mode: 'isolated',
		namespace: 'sandbox',
		allowedOrigins: ['https://pds.example.com', 'https://as.example.com'],
		slingshot: false,
		actorResolver: { resolve: async () => ({ did: DID, handle: 'test.example.com', pds: 'https://pds.example.com' }) }
	});
	let open = true;
	const selected = network.cacheKey(SELECTED);
	const ctx = tab(
		t,
		{ ...config, network, assertBrowserEgress: () => { if (!open) throw new Error('egress unprotected'); } },
		network.cacheKey('svelte-atproto:lifecycle')
	);
	t.sessions.set(DID, browserSession());
	t.sessions.set(OTHER_DID, browserSession('atproto', OTHER_DID));
	localStorage.setItem(selected, DID);
	await ctx.run((auth) => auth.init());
	assert.equal(ctx.user().did, DID);

	let reads = 0;
	Object.defineProperty(t, 'resumeError', { get: () => void reads++ });
	open = false;
	localStorage.setItem(selected, OTHER_DID);
	await ctx.storage(selected);
	localStorage.setItem(selected, DID);
	await ctx.storage(`${network.cacheKey('atcute-oauth')}:sessions:${DID}`);
	localStorage.setItem(selected, OTHER_DID);
	globalThis.document = { visibilityState: 'visible' };
	try {
		await ctx.storage(null);
	} finally {
		delete globalThis.document;
	}
	assert.equal(reads, 0, 'no session is read, so no refresh can be sent');
	assert.equal(ctx.user().did, DID);

	open = true;
	await ctx.storage(selected);
	assert.equal(ctx.user().did, OTHER_DID);
	assert.ok(reads > 0);
});
