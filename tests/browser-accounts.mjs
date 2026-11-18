import './support/register.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserRuntime, browserSession, DID, OTHER_DID, POST } from './support/runtime.mjs';
const { createAtprotoBrowserAuth, AccountSwitchError } = await import('../src/browser/index.ts');
const { TokenRefreshError } = await import('./support/browser-sdk.mjs');
const config = { origin: 'https://client.example.com', scope: ['atproto', POST] };
const SELECTED = 'atproto-current-login';

// Scripted SDK and web storage. Each "tab" is an auth instance with its own listeners
// over shared storage; not a real-browser multi-tab test.
function tab(t) {
	const listeners = [];
	// Listeners register lazily; route registrations made by this tab to its own list.
	const auth = createAtprotoBrowserAuth(config);
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
			await navigator.locks.request('svelte-atproto:lifecycle', async () => {});
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
