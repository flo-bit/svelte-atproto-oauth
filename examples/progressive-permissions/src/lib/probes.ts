import '@atcute/atproto';
import type { Client } from '@atcute/client';
import { isNsid } from '@atcute/lexicons/syntax';
import { collection, rpcScope } from './scopes';

/** Explicit user-triggered public test write, then cleanup. No automatic OAuth retries. */
export async function recordProbe(client: Client, did: `did:${string}:${string}`) {
	const created = await client.post('com.atproto.repo.createRecord', {
		input: {
			repo: did,
			collection,
			record: {
				$type: collection,
				createdAt: new Date().toISOString(),
				note: 'Explicit progressive-permissions test; intended for immediate deletion.'
			}
		}
	});
	if (!created.ok) return { ok: false, phase: 'create', status: created.status };
	const uri = created.data.uri;
	const deleted = await client.post('com.atproto.repo.deleteRecord', {
		input: { repo: did, collection, rkey: uri.split('/').at(-1)! }
	});
	return {
		ok: deleted.ok,
		phase: 'delete',
		status: deleted.status,
		uri,
		cid: created.data.cid,
		cleanupRequired: !deleted.ok
	};
}
export async function updateProbe(client: Client, did: `did:${string}:${string}`, rkey: string, cid: string) {
	const result = await client.post('com.atproto.repo.putRecord', {
		input: {
			repo: did,
			collection,
			rkey,
			swapRecord: cid,
			record: {
				$type: collection,
				createdAt: new Date().toISOString(),
				note: 'Explicit update of this diagnostic test record; intended for deletion.'
			}
		}
	});
	return { ok: result.ok, phase: 'update', status: result.status };
}
/** Check the PDS service-JWT gate without exposing or forwarding its token. */
export async function serviceAuthProbe(client: Client, variant: 'allowed' | 'wrongMethod' | 'wrongAudience') {
	if (!rpcScope) throw new Error('Configure one exact RPC scope first');
	const [prefix, query] = rpcScope.split('?');
	const params = new URLSearchParams(query);
	const lxm = prefix.startsWith('rpc:') ? prefix.slice(4) : params.get('lxm');
	const audience = params.get('aud');
	if (!lxm || !isNsid(lxm) || !audience?.startsWith('did:') || params.getAll('aud').length !== 1)
		throw new Error('Use a single exact RPC method and DID audience');
	const result = await client.get('com.atproto.server.getServiceAuth', {
		params: {
			aud: (variant === 'wrongAudience' ? 'did:web:example.com#oauth_test_ungranted' : audience) as `did:${string}:${string}`,
			lxm: variant === 'wrongMethod' ? (lxm === 'app.bsky.actor.getProfiles' ? 'app.bsky.actor.getProfile' : 'app.bsky.actor.getProfiles') : lxm,
			exp: Math.floor(Date.now() / 1000) + 60
		}
	});
	return { ok: result.ok, status: result.status, phase: `service auth ${variant}` };
}
export async function uploadProbe(client: Client, file: File) {
	if (!file.type.startsWith('image/') || file.size > 1024 * 1024)
		throw new Error('Use an image no larger than 1 MiB');
	const result = await client.post('com.atproto.repo.uploadBlob', { input: file });
	return result.ok
		? { ok: true, status: result.status, blob: result.data.blob }
		: { ok: false, status: result.status };
}
