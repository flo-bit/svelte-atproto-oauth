import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	createAtprotoNetwork, createActorResolver, createHandleResolver, createDidDocumentResolver
} from '../dist/network/index.mjs';
import * as helpers from '../dist/helper/index.mjs';
import * as bsky from '../dist/bsky/index.mjs';

const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const identity = { did, handle: 'alice.sandbox.test', pds: 'https://pds.sandbox.test' };
const bases = {
	plc: 'https://plc.sandbox.test', doh: 'https://dns.sandbox.test/dns-query',
	ufo: 'https://ufo.sandbox.test', constellation: 'https://links.sandbox.test',
	appview: 'https://appview.sandbox.test', cdn: 'https://cdn.sandbox.test'
};
const allowedOrigins = [...new Set([...Object.values(bases).map(u => new URL(u).origin), identity.pds, 'https://as.sandbox.test'])];
const options = { mode: 'isolated', namespace: 'sandbox', allowedOrigins, ...bases, slingshot: false };
const json = value => Response.json(value);
function setup(extra = {}) {
	const requests = [];
	const fetch = async (input, init = {}) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
		requests.push({ url, init });
		assert.ok(allowedOrigins.includes(url.origin), 'fixture cannot reach production');
		assert.equal(init.redirect, 'error');
		assert.equal(init.credentials, 'omit');
		if (url.origin === bases.plc) return json({
			'@context': ['https://www.w3.org/ns/did/v1'], id: did, alsoKnownAs: [`at://${identity.handle}`],
			service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: identity.pds }]
		});
		if (url.origin === new URL(bases.doh).origin) return json({
			Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false,
			Question: [{ name: `_atproto.${identity.handle}`, type: 16 }],
			Answer: [{ name: `_atproto.${identity.handle}`, type: 16, TTL: 300, data: `"did=${did}"` }]
		});
		if (url.pathname.endsWith('describeRepo')) return json({ did, handle: identity.handle, collections: [] });
		if (url.pathname.endsWith('listRecords')) return json({ records: [] });
		if (url.pathname.endsWith('getRecord')) return json({ uri: `at://${did}/app.example.post/self`, cid: 'TEST-ONLY-cid', value: {} });
		if (url.pathname.endsWith('getProfile')) return json({ ...identity, displayName: 'Sandbox' });
		if (url.pathname.endsWith('getProfiles')) return json({ profiles: [{ ...identity, displayName: 'Sandbox' }] });
		if (url.pathname.endsWith('searchActorsTypeahead')) return json({ actors: [identity] });
		if (url.pathname === '/records') return json([]);
		if (url.pathname === '/links/count' || url.pathname === '/links/count/distinct-dids') return json({ total: 3 });
		if (url.pathname === '/links') return json({ total: 0, linking_records: [], cursor: null });
		if (url.pathname === '/links/distinct-dids') return json({ total: 0, linking_dids: [], cursor: null });
		if (url.pathname === '/links/all') return json({ links: {} });
		throw new Error('Unexpected sandbox endpoint');
	};
	const network = createAtprotoNetwork({ ...options, fetch, ...extra });
	return { network, requests, fetch };
}

test('isolated profiles require explicit identity routing, origins, and a cache namespace', () => {
	for (const config of [
		{ mode: 'isolated' }, { ...options, namespace: '' }, { ...options, allowedOrigins: [] },
		{ ...options, plc: undefined }, { ...options, doh: undefined },
		{ ...options, plc: 'https://plc.directory' },
		{ ...options, allowedOrigins: ['https://plc.sandbox.test/path'] }
	]) assert.throws(() => createAtprotoNetwork(config));
});

test('missing/disabled services fail instead of selecting production defaults', async () => {
	const { network, requests } = setup({ ufo: undefined, constellation: undefined, appview: undefined, cdn: undefined });
	await assert.rejects(helpers.recentRecords('app.example.post', { network }), /Configure ufo/);
	await assert.rejects(helpers.countBacklinks(did, { collection: 'app.example.post', path: '.subject' }, { network }), /Configure constellation/);
	await assert.rejects(bsky.loadBskyProfile(did, { network }), /Configure appview/);
	assert.throws(() => bsky.getCDNImageBlobUrl({ did, blob: { ref: { $link: 'cid' } }, network }), /Configure cdn/);
	const disabled = setup({ ufo: false });
	await assert.rejects(helpers.recentRecords('app.example.post', { network: disabled.network }), /disabled/);
	assert.equal(requests.length, 0);
});

const constellationSource = { collection: 'app.example.post', path: '.subject' };
const constellationHelpers = [
	['countBacklinks', options => helpers.countBacklinks(did, constellationSource, options)],
	['countDistinctBacklinkers', options => helpers.countDistinctBacklinkers(did, constellationSource, options)],
	['listBacklinks', options => helpers.listBacklinks(did, constellationSource, options)],
	['listDistinctBacklinkers', options => helpers.listDistinctBacklinkers(did, constellationSource, options)],
	['backlinksRollup', options => helpers.backlinksRollup(did, options)]
];
for (const [name, call] of constellationHelpers) {
	test(`${name} returns undefined when disabled outside isolated mode without making requests`, async () => {
		let calls = 0;
		const fetch = async () => { calls++; throw new Error('Disabled helper contacted the network'); };
		const disabled = createAtprotoNetwork({ constellation: false, fetch });
		const enabled = createAtprotoNetwork({ constellation: bases.constellation, fetch });
		for (const options of [
			{ constellation: false, fetch }, { network: disabled },
			{ network: enabled, constellation: false }
		]) assert.equal(await call(options), undefined);
		assert.equal(calls, 0);
	});
	test(`${name} still throws when disabled or missing in isolated mode`, async () => {
		for (const constellation of [false, undefined]) {
			const { network, requests } = setup({ constellation });
			await assert.rejects(call({ network }), /disabled|Configure constellation/);
			assert.equal(requests.length, 0);
		}
		const { network, requests } = setup();
		await assert.rejects(call({ network, constellation: false }), /disabled/);
		assert.equal(requests.length, 0);
	});
}

test('sandbox exceptions are explicit, origin-scoped, and invalid in production mode', async () => {
	assert.throws(() => createAtprotoNetwork({ mode: 'production', sandbox: {} }), /isolated mode/);
	assert.throws(() => createAtprotoNetwork({ mode: 'production', allowedOrigins }), /isolated mode/);
	const input = { ...options, allowedOrigins: [...allowedOrigins, 'http://127.0.0.1:8888'] };
	const strict = createAtprotoNetwork(input);
	assert.throws(() => strict.assertUrl('http://127.0.0.1:8888'), /outside/);
	let calls = 0;
	const sandbox = createAtprotoNetwork({ ...input, sandbox: {
		httpOrigins: ['http://127.0.0.1:8888'], fetch: async () => { calls++; return json({}); }
	} });
	await sandbox.fetch('http://127.0.0.1:8888/test');
	await assert.rejects(sandbox.fetch('http://127.0.0.1:9999/test'), /outside/);
	await assert.rejects(sandbox.fetch('https://plc.directory/test'), /outside/);
	assert.equal(calls, 1);
	assert.throws(() => createAtprotoNetwork({ ...options, sandbox: { httpOrigins: ['http://127.0.0.1:8888'] } }), /allowedOrigins/);
});

test('isolated transport blocks redirects, credentials in URLs, and per-call transport bypasses', async () => {
	const { network, requests } = setup();
	await assert.rejects(network.fetch('https://alice:secret@pds.sandbox.test/'), /Invalid network/);
	await assert.rejects(network.fetch('https://public.api.bsky.app/'), /outside/);
	assert.equal(requests.length, 0);
	await assert.rejects(helpers.recentRecords('app.example.post', { network, fetch: async () => json([]) }), /network profile/);
});

test('custom PLC and DNS work with the real identity resolvers without public traffic', async () => {
	const { network, requests } = setup();
	assert.equal((await createDidDocumentResolver({ network }).resolve(did)).id, did);
	assert.equal(await createHandleResolver({ network }).resolve(identity.handle), did);
	assert.deepEqual(await createActorResolver({ network }).resolve(identity.handle), { ...identity, pds: `${identity.pds}/` });
	assert.ok(requests.some(r => r.url.origin === bases.plc));
	assert.ok(requests.some(r => r.url.origin === new URL(bases.doh).origin));
});

test('private DNS failure never falls through to public well-known handle resolution', async () => {
	const requests = [];
	const network = createAtprotoNetwork({ ...options, fetch: async (input) => {
		requests.push(String(input)); return json({
			Status: 3, TC: false, RD: true, RA: true, AD: false, CD: false,
			Question: [{ name: '_atproto.alice.bsky.social', type: 16 }], Answer: []
		});
	} });
	await assert.rejects(createHandleResolver({ network }).resolve('alice.bsky.social'));
	assert.equal(requests.length, 1);
	assert.equal(new URL(requests[0]).origin, new URL(bases.doh).origin);
});

test('custom actor failures propagate; a production PDS result is rejected', async () => {
	const error = new Error('Sandbox account missing');
	const supplied = { resolve: async () => { throw error; } };
	assert.equal(createActorResolver({ actorResolver: supplied }), supplied);
	await assert.rejects(createActorResolver({ actorResolver: supplied }).resolve(identity.handle), error);
	const { network, requests } = setup({ actorResolver: { resolve: async () => ({ ...identity, pds: 'https://bsky.social' }) } });
	await assert.rejects(createActorResolver({ network }).resolve(identity.handle), /outside/);
	assert.equal(requests.length, 0);
});

test('identity, PDS discovery, records, and blob URLs honor the same private profile', async () => {
	const { network } = setup();
	assert.equal(await helpers.resolveHandle({ handle: identity.handle, network }), did);
	assert.equal(await helpers.actorToDid(identity.handle, { network }), did);
	assert.deepEqual(await helpers.loadMiniDoc(identity.handle, { network }), identity);
	assert.equal(await helpers.getPDS(did, { network }), identity.pds);
	assert.equal(await helpers.loadHandle(did, { network }), identity.handle);
	assert.equal((await helpers.loadHandles([did], { network }))[did], identity.handle);
	assert.deepEqual(await helpers.listRecords({ did, collection: 'app.example.post', network }), []);
	assert.ok(await helpers.getRecord({ did, collection: 'app.example.post', network }));
	assert.ok(await helpers.getRecordByUri(`at://${did}/app.example.post/self`, { network }));
	assert.equal((await helpers.describeRepo({ did, network })).handle, identity.handle);
	assert.ok((await helpers.getBlobURL({ did, blob: { ref: { $link: 'TEST-ONLY-cid' } }, network })).startsWith(identity.pds));
});

test('all external helper and AppView endpoints are routed privately', async () => {
	const { network, requests } = setup();
	const source = { collection: 'app.example.post', path: '.subject' };
	await helpers.recentRecords(source.collection, { network });
	assert.equal(await helpers.countBacklinks(did, source, { network }), 3);
	assert.equal(await helpers.countDistinctBacklinkers(did, source, { network }), 3);
	await helpers.listBacklinks(did, source, { network });
	await helpers.listDistinctBacklinkers(did, source, { network });
	await helpers.backlinksRollup(did, { network });
	assert.equal((await bsky.loadBskyProfile(did, { network })).displayName, 'Sandbox');
	assert.ok((await bsky.loadBskyProfiles([did], { network }))[did]);
	assert.ok(await bsky.getDetailedProfile({ did, network }));
	assert.equal((await bsky.searchActorsTypeahead({ q: 'alice', network })).actors.length, 1);
	assert.ok(bsky.getCDNImageBlobUrl({ did, blob: { ref: { $link: 'cid' } }, network }).startsWith(bases.cdn));
	assert.ok(requests.some(r => r.url.origin === bases.ufo));
	assert.ok(requests.some(r => r.url.origin === bases.constellation));
	assert.ok(requests.some(r => r.url.origin === bases.appview));
});

test('helper/AppView errors fail loudly in isolated mode without production fallback', async () => {
	const urls = [];
	const { network } = setup({ fetch: async input => { urls.push(String(input)); return new Response(null, { status: 503 }); } });
	await assert.rejects(helpers.loadMiniDoc(did, { network }));
	await assert.rejects(helpers.recentRecords('app.example.post', { network }));
	await assert.rejects(bsky.loadBskyProfile(did, { network }), /AppView failed/);
	await assert.rejects(bsky.loadBskyProfiles([did], { network }), /AppView batch failed/);
	assert.ok(!urls.some(url => /plc\.directory|microcosm\.blue|bsky\.app/.test(url)));
});

test('AppView fallback also carries the private identity and transport configuration', async () => {
	const fixture = setup();
	const network = createAtprotoNetwork({ ...options, fetch: async (input, init) => {
		if (String(input).includes('getProfile')) return json({ ...identity, handle: 'handle.invalid' });
		return fixture.fetch(input, init);
	} });
	assert.equal((await bsky.loadBskyProfile(did, { network })).handle, identity.handle);
	assert.ok(fixture.requests.some(r => r.url.origin === bases.plc));
});

test('private cache keys cannot reuse unnamespaced production identity/profile values', async () => {
	const data = new Map([[did, { did, handle: 'PRODUCTION', pds: 'https://bsky.social' }]]);
	const cache = { get: key => data.get(key), set: (key, value) => data.set(key, value) };
	const { network } = setup();
	assert.equal((await helpers.loadMiniDoc(did, { network, cache })).handle, identity.handle);
	assert.equal((await bsky.loadBskyProfile(did, { network, cache })).displayName, 'Sandbox');
	assert.equal((await bsky.loadBskyProfiles([did], { network, cache }))[did].displayName, 'Sandbox');
	assert.ok(data.has(network.cacheKey(`identity:${did}`)));
	assert.ok(data.has(network.cacheKey(`bsky-profile:${did}`)));
	assert.equal(data.get(did).handle, 'PRODUCTION');
});


test('isolated custom transports cannot return redirects or an off-network response URL', async () => {
	for (const kind of ['redirect', 'followed', 'foreign']) {
		const response = kind === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://bsky.social' } }) : json({});
		if (kind === 'followed') Object.defineProperty(response, 'redirected', { value: true });
		if (kind === 'foreign') Object.defineProperty(response, 'url', { value: 'https://bsky.social/response' });
		const network = createAtprotoNetwork({ ...options, fetch: async () => response });
		await assert.rejects(network.fetch(identity.pds), /forbidden|outside/);
	}
});

test('Slingshot failures/foreign PDS results do not silently fall back in isolation', async () => {
	for (const badPds of [false, true]) {
		const requests = [];
		const network = createAtprotoNetwork({ ...options, slingshot: bases.plc, fetch: async input => {
			requests.push(String(input));
			return badPds ? json({ ...identity, pds: 'https://bsky.social' }) : new Response(null, { status: 503 });
		} });
		await assert.rejects(helpers.loadMiniDoc(did, { network }));
		assert.equal(requests.length, 1);
		assert.ok(requests[0].includes('/blue.microcosm.identity.resolveMiniDoc'));
	}
});

test('production defaults stay compatible; endpoint overrides are opt-in', () => {
	const defaults = createAtprotoNetwork({});
	assert.equal(defaults.endpoint('plc'), 'https://plc.directory');
	assert.equal(defaults.endpoint('appview'), 'https://public.api.bsky.app');
	assert.equal(defaults.cacheKey(did), did);
	const custom = createAtprotoNetwork({ plc: bases.plc, doh: bases.doh, appview: bases.appview });
	assert.equal(custom.endpoint('plc'), bases.plc);
	assert.equal(custom.endpoint('doh'), bases.doh);
	assert.equal(custom.endpoint('appview'), bases.appview);
	assert.equal(custom.endpoint('ufo'), 'https://ufos-api.microcosm.blue');
});
