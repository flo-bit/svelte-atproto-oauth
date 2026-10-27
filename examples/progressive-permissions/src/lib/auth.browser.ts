import { createAtprotoBrowserAuth } from '@svelte-atproto/oauth/browser';
import { declaredScope, origin, devPort } from './scopes';
export const auth = createAtprotoBrowserAuth({
	origin,
	devPort,
	scope: declaredScope,
	redirectPath: '/browser',
	metadataPath: '/browser/oauth-client-metadata.json'
});
