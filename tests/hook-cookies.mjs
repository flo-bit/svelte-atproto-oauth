import './support/register.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeRuntime, memoryStore, event, DID, POST } from './support/runtime.mjs';

const { createAtprotoAuth } = await import('../src/server/index.ts');
const { setSignedCookie } = await import('../src/server/cookie.ts');
const { withCookieHeaders } = await import('../src/server/response-cookies.ts');
// Use SvelteKit's actual cookie jar/serializer, not a mock that writes headers eagerly.
const { get_cookies, add_cookies_to_headers } = await import(
	new URL('../runtime/server/cookie.js', import.meta.resolve('@sveltejs/kit')).href
);
const secret = 'TEST-ONLY-cookie-secret';

function setup() {
	const t = nodeRuntime();
	const sessions = memoryStore(), states = memoryStore();
	const auth = createAtprotoAuth({ scope: ['atproto', POST], cookieSecret: secret, sessions, states });
	return { t, sessions, states, auth };
}
function request(ctx, path, { method = 'GET', body, cookie } = {}) {
	const e = event(path);
	e.request = new Request(e.url, {
		method,
		headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
		...(body ? { body: JSON.stringify(body) } : {})
	});
	const jar = get_cookies(e.request, e.url);
	jar.set_trailing_slash('never');
	// Kit 3 exposes this property as readonly. The bridge must not replace it.
	Object.defineProperty(e, 'cookies', { value: jar.cookies, writable: false });
	ctx.t.event = e;
	return { e, jar };
}
async function mounted(ctx, e) {
	return ctx.auth.handle({ event: e, resolve: () => assert.fail('Intercepted endpoint called resolve') });
}
async function signedIn(ctx) {
	const { e } = request(ctx, '/');
	await ctx.auth.api.startLogin({ handle: 'test.example.com', scope: 'atproto' });
	const state = [...ctx.states.data.keys()].at(-1);
	ctx.t.tokens.set(state, { scope: 'atproto' });
	e.url = new URL(`/oauth/callback?state=${state}&code=${state}&iss=https://as.example.com`, e.url);
	await assert.rejects(ctx.auth.handlers.callback(e), (error) => error.status === 303);
	return `did=${encodeURIComponent(e.cookies.get('did'))}`;
}
function deletions(response) {
	return response.headers.getSetCookie().map((header) => {
		assert.match(header, /Max-Age=0/);
		assert.match(header, /Path=\//);
		assert.match(header, /HttpOnly/);
		assert.match(header, /SameSite=Lax/);
		return header.split('=')[0];
	}).sort();
}

test('mounted logout ships cookie deletions on the returned JSON response', async () => {
	const ctx = setup();
	const cookie = await signedIn(ctx);
	const { e, jar } = request(ctx, '/oauth/logout', { method: 'POST', cookie });
	// Migration and logout both delete scope; only the final mutation should ship.
	await setSignedCookie(e.cookies, 'scope', 'atproto', secret, { path: '/' });
	const response = await mounted(ctx, e);
	assert.equal(response.status, 200);
	assert.deepEqual(deletions(response), ['did', 'scope']);
	assert.equal(ctx.sessions.data.has(DID), false);
	assert.equal(e.cookies, jar.cookies, 'cookie facade must be restored');
	assert.equal((await response.json()).ok, true);
});

test('restoration cleanup ships even when intercepted login returns a JSON error', async () => {
	const ctx = setup();
	const { e } = request(ctx, '/oauth/login', { method: 'POST', body: { handle: 42 } });
	await setSignedCookie(e.cookies, 'did', DID, secret, { path: '/' });
	const response = await mounted(ctx, e);
	assert.equal(response.status, 400);
	assert.deepEqual(deletions(response), ['did', 'scope']);
});

test('legacy scope migration ships one deletion on intercepted permissions response', async () => {
	const ctx = setup();
	const cookie = await signedIn(ctx);
	const { e } = request(ctx, '/oauth/permissions', { method: 'POST', body: { scope: 'atproto' }, cookie });
	await setSignedCookie(e.cookies, 'scope', 'atproto', secret, { path: '/' });
	const response = await mounted(ctx, e);
	assert.deepEqual(await response.json(), { url: null });
	assert.deepEqual(deletions(response), ['scope']);
});

test('ordinary routes leave cookie delivery to resolve without duplicate headers', async () => {
	const ctx = setup();
	const { e, jar } = request(ctx, '/organizer');
	await setSignedCookie(e.cookies, 'did', DID, secret, { path: '/' });
	const response = await ctx.auth.handle({ event: e, resolve: async (routeEvent) => {
		assert.equal(routeEvent.cookies, jar.cookies);
		const response = new Response('page');
		add_cookies_to_headers(response.headers, jar.new_cookies.values());
		return response;
	} });
	assert.deepEqual(deletions(response), ['did', 'scope']);
	assert.equal(await response.text(), 'page');
});

test('cookie bridge preserves existing headers, defaults, encoding, and last-write semantics', async () => {
	const ctx = setup();
	const { e, jar } = request(ctx, '/oauth/login');
	const response = await withCookieHeaders(e, async () => {
		e.cookies.set('feature', 'discarded', { path: '/', secure: false });
		e.cookies.set('feature', '/organizer?name=hello world;', { path: '/', secure: false, maxAge: 600 });
		e.cookies.set('feature', 'other-path', { path: '/organizer' });
		return new Response('payload', { status: 202, statusText: 'Queued', headers: {
			'set-cookie': 'app=keep; Path=/', 'x-test': 'preserved'
		} });
	});
	assert.equal(response.status, 202);
	assert.equal(response.statusText, 'Queued');
	assert.equal(response.headers.get('x-test'), 'preserved');
	assert.equal(await response.text(), 'payload');
	const headers = response.headers.getSetCookie();
	assert.equal(headers.length, 3);
	assert.equal(headers[0], 'app=keep; Path=/');
	assert.match(headers[1], /^feature=%2Forganizer%3Fname%3Dhello%20world%3B;/);
	assert.match(headers[1], /Max-Age=600/);
	assert.doesNotMatch(headers[1], /Secure/);
	assert.match(headers[2], /Path=\/organizer; HttpOnly; Secure; SameSite=Lax/);
	assert.equal(e.cookies, jar.cookies);
});

test('cookie bridge supports immutable response headers', async () => {
	const ctx = setup();
	const { e, jar } = request(ctx, '/oauth/login');
	const response = await withCookieHeaders(e, async () => {
		e.cookies.delete('did', { path: '/' });
		return Response.redirect('https://pds.example.com', 303);
	});
	assert.equal(response.status, 303);
	assert.equal(response.headers.get('location'), 'https://pds.example.com/');
	assert.deepEqual(deletions(response), ['did']);
	assert.equal(e.cookies, jar.cookies);
});

test('cookie bridge restores the original methods after returned and thrown responses', async () => {
	const ctx = setup();
	const { e } = request(ctx, '/oauth/login');
	const { set, delete: remove } = e.cookies;
	const failure = new Error('handler failed');
	await assert.rejects(withCookieHeaders(e, async () => {
		e.cookies.set('test', 'value', { path: '/' });
		throw failure;
	}), (error) => error === failure);
	assert.equal(e.cookies.set, set);
	assert.equal(e.cookies.delete, remove);
	assert.equal(await withCookieHeaders(e, async () => undefined), undefined);
	assert.equal(e.cookies.set, set);
	assert.equal(e.cookies.delete, remove);
});

test('state-bound return paths survive separate cookie-free login requests and reversed callbacks', async () => {
	const ctx = setup();
	const flows = [];
	for (const returnTo of ['/organizer?draft=1', '/survey?name=hello%20world']) {
		const { e } = request(ctx, '/oauth/login', { method: 'POST', body: { handle: 'test.example.com', scope: 'atproto', returnTo } });
		const response = await mounted(ctx, e);
		assert.equal(response.status, 200);
		assert.ok((await response.json()).url);
		assert.deepEqual(response.headers.getSetCookie(), []);
		flows.push({ state: [...ctx.states.data.keys()].at(-1), returnTo });
	}
	for (const { state, returnTo } of flows.reverse()) {
		ctx.t.tokens.set(state, { scope: 'atproto' });
		const { e, jar } = request(ctx, `/oauth/callback?state=${state}&code=${state}&iss=https://as.example.com`);
		await assert.rejects(mounted(ctx, e), (error) => error.status === 303 && error.location === returnTo);
		assert.equal(e.cookies, jar.cookies);
		// SvelteKit handles thrown redirects, packing its own jar exactly once.
		const response = new Response(null, { status: 303, headers: { location: returnTo } });
		add_cookies_to_headers(response.headers, jar.new_cookies.values());
		assert.equal(response.headers.getSetCookie().length, 2);
		// Kit 3's cookie serializer leaves colons unescaped; both encodings
		// must carry the same signed DID cookie value.
		assert.ok(response.headers.getSetCookie().some((header) =>
			decodeURIComponent(header.split(';')[0]).startsWith('did=did:plc:')
		));
	}
});
