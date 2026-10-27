import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, ClientResponseError, ok } from '@atcute/client';
import { needsPermissions } from '../dist/permissions/index.mjs';

const failed = (error, status = 403) => ({ ok: false, status, data: { error } });
const challenge = (value, status = 403) => ({
	...failed('AuthMissing', status),
	headers: new Headers({ 'WWW-Authenticate': value })
});

for (const code of ['insufficient_scope', 'InsufficientScope']) {
	for (const status of [401, 403]) {
		test(`recognizes explicit ${code} response with ${status}`, () => {
			assert.equal(needsPermissions(failed(code, status)), true);
		});
	}
}

test('accepts real atcute results and errors without consuming bodies again', async () => {
	const client = new Client({
		handler: async () => new Response(JSON.stringify({ error: 'AuthMissing' }), {
			status: 403,
			headers: {
				'content-type': 'application/json',
				'www-authenticate': 'DPoP error="insufficient_scope"'
			}
		})
	});
	const result = await client.post('com.atproto.repo.createRecord', { input: {} });
	assert.equal(needsPermissions(result), true);
	assert.throws(() => ok(result), (error) => {
		assert.ok(error instanceof ClientResponseError);
		assert.equal(needsPermissions(error), true);
		return true;
	});
	assert.equal(needsPermissions(new ClientResponseError({
		status: 403, data: { error: 'InsufficientScope' }
	})), true);
});

const positive = [
	'Bearer error="insufficient_scope"',
	'DPoP realm="pds", error="insufficient_scope", scope="repo:app.example.post"',
	'bearer ERROR = insufficient_scope',
	'Basic realm="other", DPoP error="insufficient_scope"',
	'Bearer realm="comma, and \\"quoted\\" text", error="insufficient_scope"',
	'DPoP error="insufficient\\_scope"',
	'Bearer error="invalid_token", DPoP error="insufficient_scope"'
];
for (const header of positive) test(`recognizes challenge ${header}`, () => {
	assert.equal(needsPermissions(challenge(header)), true);
});

const negative = [
	'Basic error="insufficient_scope"',
	'DPoP error="invalid_token"',
	'DPoP error_description="insufficient_scope"',
	'DPoP realm="error=insufficient_scope"',
	'DPoP realm="text, error=insufficient_scope"',
	'Bearer realm="text, DPoP error=insufficient_scope"',
	'Bearer error="insufficient_scope_extra"',
	'Bearer error="INSUFFICIENT_SCOPE"',
	'Bearer error="invalid_token", error="insufficient_scope"',
	'Bearer error="insufficient_scope',
	'error="insufficient_scope"'
];
// A later unrelated challenge does not erase an explicit scope failure in an earlier one.
test('independent later challenge does not erase scope failure', () => {
	assert.equal(needsPermissions(challenge('Bearer error="insufficient_scope", Basic error="invalid_token"')), true);
});
for (const header of negative) test(`does not infer missing scopes from ${header}`, () => {
	assert.equal(needsPermissions(challenge(header)), false);
});

test('generic authorization errors and messages are not scope evidence', () => {
	for (const code of ['Forbidden', 'AuthMissing', 'Unauthorized', 'invalid_token', 'InvalidToken']) {
		assert.equal(needsPermissions(failed(code)), false);
	}
	assert.equal(needsPermissions({ ...failed('Forbidden'), data: {
		error: 'Forbidden', message: 'Missing permissions; insufficient_scope'
	} }), false);
});

test('success, unrelated statuses, and malformed inputs return false', () => {
	assert.equal(needsPermissions({ ...failed('InsufficientScope'), ok: true }), false);
	for (const status of [200, 400, 404, 409, 429, 500]) {
		assert.equal(needsPermissions(failed('InsufficientScope', status)), false);
		assert.equal(needsPermissions(challenge('Bearer error="insufficient_scope"', status)), false);
	}
	for (const value of [null, undefined, false, 'insufficient_scope', new Error('InsufficientScope'),
		{}, { status: '403', error: 'InsufficientScope' }, { status: 403, headers: {} },
		{ status: 403, headers: { get: () => { throw new Error('unavailable'); } } },
		{ status: 403, headers: { get: () => 123 } }]) {
		assert.equal(needsPermissions(value), false);
	}
});

test('fetch Response input is inspected synchronously without reading its body', () => {
	const response = new Response('{"error":"InsufficientScope"}', {
		status: 403, headers: { 'www-authenticate': 'DPoP error="insufficient_scope"' }
	});
	assert.equal(needsPermissions(response), true);
	assert.equal(response.bodyUsed, false);
	assert.equal(needsPermissions(new Response('{"error":"InsufficientScope"}', { status: 403 })), false);
});
