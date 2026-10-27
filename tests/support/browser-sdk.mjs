// Models the browser SDK's documented store-before-return callback behavior.
export class TokenRefreshError extends Error {}
export function configureOAuth(options) {
	globalThis.authTest.configured = options;
}
export async function createAuthorizationUrl(options) {
	globalThis.authTest.flow = options;
	return new URL('https://as.example.com/authorize?request_uri=scripted');
}
export async function finalizeAuthorization(params) {
	const t = globalThis.authTest;
	(t.finalizations ??= []).push(new URLSearchParams(params));
	if (params.has('error')) throw new Error('authorization failed');
	if (t.callbackError) throw t.callbackError;
	const session = t.next;
	const state = Object.hasOwn(t, 'callbackState') ? t.callbackState : (t.flow?.state ?? null);
	await t.beforeFinalize?.();
	t.sessions.set(session.info.sub, session);
	return { session, state };
}
export async function getSession(did, options) {
	const t = globalThis.authTest;
	if (t.resumeError) throw t.resumeError;
	const session = t.sessions.get(did);
	if (!session) throw new TokenRefreshError('session gone');
	if (options?.noCache && t.refreshed) {
		t.sessions.set(did, t.refreshed);
		return t.refreshed;
	}
	return session;
}
export function deleteStoredSession(did) {
	globalThis.authTest.sessions.delete(did);
}
export class OAuthUserAgent {
	constructor(session) {
		this.session = session;
	}
	get sub() {
		return this.session.info.sub;
	}
	async handle() {
		return new Response(null, { status: 200 });
	}
	async getSession(options) {
		this.session = await getSession(this.session.info.sub, options);
		return this.session;
	}
	async signOut() {
		const t = globalThis.authTest;
		t.revoked.push(this.session.info.sub);
		await t.beforeSignOut?.();
		deleteStoredSession(this.session.info.sub);
	}
}
