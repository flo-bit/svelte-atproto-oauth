import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	hasCapability,
	hasScopes,
	normalizeScope,
	preservesScopes,
	safeReturnTo,
	upgradeScope,
	validateScope,
	PermissionHistoryUnavailableError
} from '../dist/permissions/index.mjs';
const repo = (action = 'create', collection = 'app.example.post') => ({
	type: 'repo',
	collection,
	action
});
const rpc = { type: 'rpc', lxm: 'app.example.getFeed', aud: 'did:web:api.example.com#appview' };
const cases = [
	['repo positional', 'atproto repo:app.example.post', repo(), true],
	[
		'repo query repeated values',
		'repo?collection=app.example.other&collection=app.example.post&action=create&action=update',
		repo('update'),
		true
	],
	['repo action denied', 'repo:app.example.post?action=create', repo('delete'), false],
	['collection denied', 'repo:app.example.other', repo(), false],
	['full wildcard', 'repo:*?action=create', repo(), true],
	['partial wildcard invalid', 'repo:app.example.*', repo(), false],
	[
		'positional plus named parameter invalid',
		'repo:app.example.post?collection=app.example.other',
		repo(),
		false
	],
	['unknown attenuation fails closed', 'repo:app.example.post?limit=one', repo(), false],
	[
		'invalid action fails whole token',
		'repo:app.example.post?action=create&action=read',
		repo(),
		false
	],
	['bad percent escape', 'repo:app.example.%XXpost', repo(), false],
	['permission set is not proof', 'include:app.example.authFull', repo(), false],
	['transitional scope not guessed', 'transition:generic', repo(), false],
	['blob wildcard', 'blob?accept=image/*', { type: 'blob', mimeType: 'image/png' }, true],
	['blob other type denied', 'blob:image/*', { type: 'blob', mimeType: 'video/mp4' }, false],
	['blob all', 'blob:*/*', { type: 'blob', mimeType: 'application/octet-stream' }, true],
	[
		'blob repeated',
		'blob?accept=image/png&accept=video/*',
		{ type: 'blob', mimeType: 'video/mp4' },
		true
	],
	['blob percent encoded', 'blob:image%2Fpng', { type: 'blob', mimeType: 'image/png' }, true],
	[
		'blob plus remains plus',
		'blob:application/ld+json',
		{ type: 'blob', mimeType: 'application/ld+json' },
		true
	],
	['blob invalid wildcard', 'blob:*/png', { type: 'blob', mimeType: 'image/png' }, false],
	[
		'rpc encoded audience',
		'rpc:app.example.getFeed?aud=did:web:api.example.com%23appview',
		rpc,
		true
	],
	[
		'rpc audience denied',
		'rpc:app.example.getFeed?aud=did:web:api.example.com%23other',
		rpc,
		false
	],
	['rpc wildcard audience', 'rpc:app.example.getFeed?aud=*', rpc, true],
	['rpc wildcard method', 'rpc:*?aud=did:web:api.example.com%23appview', rpc, true],
	['rpc double wildcard invalid', 'rpc:*?aud=*', rpc, false],
	['rpc missing audience', 'rpc:app.example.getFeed', rpc, false],
	['rpc duplicated audience invalid', 'rpc:app.example.getFeed?aud=*&aud=*', rpc, false],
	[
		'rpc audience needs fragment',
		'rpc:app.example.getFeed?aud=did:web:api.example.com',
		rpc,
		false
	],
	[
		'account default read',
		'account:email',
		{ type: 'account', attr: 'email', action: 'read' },
		true
	],
	[
		'account read not manage',
		'account:email',
		{ type: 'account', attr: 'email', action: 'manage' },
		false
	],
	[
		'account manage includes read',
		'account:email?action=manage',
		{ type: 'account', attr: 'email' },
		true
	],
	[
		'account attrs distinct',
		'account:repo?action=manage',
		{ type: 'account', attr: 'email' },
		false
	],
	['identity full', 'identity:*', { type: 'identity', attr: 'handle' }, true],
	['identity handle not full', 'identity:handle', { type: 'identity', attr: '*' }, false],
	['identity unknown attr', 'identity:future', { type: 'identity', attr: 'handle' }, false],
	[
		'identity repeated scalar invalid',
		'identity?attr=*&attr=handle',
		{ type: 'identity', attr: 'handle' },
		false
	]
];
for (const [name, grant, capability, expected] of cases)
	test(name, () => assert.equal(hasCapability(grant, capability), expected));

test('normalization preserves exact request tokens, removes duplicates and supports arrays', () => {
	assert.deepEqual(
		normalizeScope(['atproto repo:app.example.post', 'atproto', 'include:app.example.authFull']),
		['atproto', 'repo:app.example.post', 'include:app.example.authFull']
	);
	assert.throws(() => normalizeScope([123]), TypeError);
	assert.throws(() => validateScope('repo:*', 'atproto repo:*'), /include atproto/);
	assert.throws(() => validateScope('atproto repo:*', 'atproto'), /not declared/);
});
test('coverage joins repo actions across tokens but never crosses rpc audiences', () => {
	assert.equal(
		hasScopes(
			'atproto repo:app.example.post?action=create repo:app.example.post?action=update repo:app.example.post?action=delete',
			'atproto repo:app.example.post'
		),
		true
	);
	assert.equal(
		hasScopes(
			'rpc:app.example.getFeed?aud=did:web:other.example%23appview',
			'rpc:app.example.getFeed?aud=did:web:api.example.com%23appview'
		),
		false
	);
	assert.equal(hasScopes('repo:app.example.post', 'repo:*'), false);
	assert.equal(hasScopes('blob:image/png', 'blob:image/*'), false);
	assert.equal(hasScopes('include:app.example.authFull', 'include:app.example.authFull'), false);
	assert.equal(preservesScopes('atproto future:token', 'atproto future:token'), true);
	assert.equal(preservesScopes('atproto', 'atproto future:token'), false);
});
test('upgrade preserves include requests rather than copying expanded grants into metadata', () => {
	assert.deepEqual(
		upgradeScope({
			declared: 'atproto include:app.example.authFull blob:image/*',
			requested: 'atproto include:app.example.authFull',
			granted: 'atproto repo:app.example.post',
			additional: 'blob:image/*'
		}),
		['atproto', 'include:app.example.authFull', 'blob:image/*']
	);
});
test('legacy direct grants can be recovered but ambiguous expanded sets cannot', () => {
	assert.deepEqual(
		upgradeScope({
			declared: 'atproto repo:app.example.post blob:image/*',
			requested: null,
			granted: 'atproto repo:app.example.post',
			additional: 'blob:image/*'
		}),
		['atproto', 'repo:app.example.post', 'blob:image/*']
	);
	const input = {
		declared: 'atproto include:app.example.authFull blob:image/*',
		requested: null,
		granted: 'atproto repo:app.example.post',
		additional: 'blob:image/*'
	};
	assert.throws(() => upgradeScope(input), PermissionHistoryUnavailableError);
	assert.deepEqual(
		upgradeScope({ ...input, previousScope: 'atproto include:app.example.authFull' }),
		['atproto', 'include:app.example.authFull', 'blob:image/*']
	);
});
test('removed declarations are not silently dropped or replaced with today’s configuration', () => {
	assert.throws(
		() =>
			upgradeScope({
				declared: 'atproto blob:image/*',
				requested: 'atproto repo:app.example.post',
				granted: 'atproto repo:app.example.post',
				additional: 'blob:image/*'
			}),
		/not declared/
	);
});
for (const path of [
	'//evil.example',
	'/\\evil.example',
	'/%5cevil.example',
	'/%2fevil.example',
	'/%09/evil.example',
	'/bad%XX',
	'https://evil.example',
	'relative',
	'/\n/evil.example',
	'%2f%2fevil.example',
	'/\t/evil.example',
	'/foo%0d%0aLocation%3Ahttps%3A%2F%2Fevil.example',
	'/foo%00bar',
	'/foo%7fbar',
	'/bad%',
	'/raw space',
	'',
	null,
	undefined
])
	test(`reject unsafe return path ${JSON.stringify(path)}`, () =>
		assert.equal(safeReturnTo(path), undefined));
for (const path of [
	'/compose?q=hello%20world#draft',
	'/team/%F0%9F%8C%B1?next=%2Fsurvey#step%202',
	'/survey?url=https%3A%2F%2Fexample.com'
])
	test(`safe return path retains query, encoding and hash: ${path}`, () =>
		assert.equal(safeReturnTo(path), path));
