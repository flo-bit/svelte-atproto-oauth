import assert from 'node:assert/strict';
import { test } from 'node:test';
import { login, signup, requestPermissions } from '../dist/client/index.mjs';
function runtime(result = { url: null }) {
	const calls = [];
	const assigned = [];
	globalThis.window = {
		location: { pathname: '/compose', search: '?draft=1', assign: (url) => assigned.push(url) },
		addEventListener: (_event, fn) => queueMicrotask(fn)
	};
	globalThis.fetch = async (path, options) => {
		calls.push({ path, body: JSON.parse(options.body) });
		return Response.json(result);
	};
	return { calls, assigned };
}
test('client login forwards exact scope and preserves existing default behavior', async () => {
	const t = runtime();
	await login('@test.example.com');
	assert.deepEqual(t.calls[0], {
		path: '/oauth/login',
		body: { handle: 'test.example.com', returnTo: '/compose?draft=1' }
	});
	await login(undefined, { scope: 'atproto', returnTo: '/other', loginPath: '/custom/login' });
	assert.deepEqual(t.calls[1], {
		path: '/custom/login',
		body: { scope: 'atproto', returnTo: '/other' }
	});
});
test('client signup forwards scope and can suppress automatic returnTo', async () => {
	const t = runtime();
	await signup({ scope: ['atproto'], saveReturnTo: false });
	assert.deepEqual(t.calls[0].body, { signup: true, scope: ['atproto'] });
});
test('client permission helper forwards requirements and handles already-granted no-op', async () => {
	const t = runtime();
	const requirements = [{ type: 'repo', collection: 'app.example.post', action: 'create' }];
	await requestPermissions('include:app.example.authFull', {
		permissionsPath: '/custom/permissions',
		requirements,
		previousScope: 'atproto'
	});
	assert.deepEqual(t.calls[0], {
		path: '/custom/permissions',
		body: {
			scope: 'include:app.example.authFull',
			returnTo: '/compose?draft=1',
			requirements,
			previousScope: 'atproto'
		}
	});
	assert.equal(t.assigned.length, 0);
});
test('client permission helper navigates for a real upgrade', async () => {
	const t = runtime({ url: 'https://as.example.com/authorize' });
	await assert.rejects(requestPermissions('repo:app.example.post'), /user aborted/);
	assert.deepEqual(t.assigned, ['https://as.example.com/authorize']);
});
test('client helper rejects malformed endpoint responses and HTTP errors', async () => {
	runtime({});
	await assert.rejects(requestPermissions('repo:app.example.post'), /missing url/);
	globalThis.fetch = async () =>
		Response.json({ error: 'invalid_authorization_request' }, { status: 400 });
	await assert.rejects(
		requestPermissions('repo:app.example.post'),
		/invalid_authorization_request/
	);
});
