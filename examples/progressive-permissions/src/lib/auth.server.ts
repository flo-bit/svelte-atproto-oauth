import { createAtprotoAuth } from '@svelte-atproto/oauth/server';
import { env } from '$env/dynamic/private';
import { building } from '$app/environment';
import { declaredScope, devPort } from './scopes';
export const auth = createAtprotoAuth({
	scope: declaredScope,
	devPort,
	origin: env.ORIGIN,
	cookieSecret: env.COOKIE_SECRET || (building ? 'build-only-not-a-runtime-secret' : undefined),
	clientAssertionKey: env.CLIENT_ASSERTION_KEY
});
