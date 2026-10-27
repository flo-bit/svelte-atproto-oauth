import { env } from '$env/dynamic/public';
export const collection = 'tools.atmo.oauthTest.record';
export const repoScope = `repo:${collection}`;
export const repoCreateScope = `${repoScope}?action=create`;
export const repoUpdateScope = `${repoScope}?action=update`;
export const repoDeleteScope = `${repoScope}?action=delete`;
export const concurrentScopes = [
	'repo:tools.atmo.oauthTest.concurrentA',
	'repo:tools.atmo.oauthTest.concurrentB'
];
export const profileScope = 'repo:app.bsky.actor.profile';
export const blobScope = 'blob?accept=image/*';
export const setScope = env.PUBLIC_PERMISSION_SET || null;
export const rpcScope = env.PUBLIC_RPC_SCOPE || null;
export const declaredScope = [
	'atproto',
	repoScope,
	repoCreateScope,
	repoUpdateScope,
	repoDeleteScope,
	blobScope,
	...concurrentScopes,
	profileScope,
	...[setScope, rpcScope].filter((s): s is string => !!s)
];
export const devPort = Number(env.PUBLIC_DEV_PORT || '5173');
if (!Number.isInteger(devPort) || devPort < 1024 || devPort > 65535) throw new Error('Invalid PUBLIC_DEV_PORT');
export const origin = env.PUBLIC_ORIGIN || `http://127.0.0.1:${devPort}`;
