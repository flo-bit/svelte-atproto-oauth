import type { Cookies } from '@sveltejs/kit';

export const COOKIE_DID = 'did';
export const COOKIE_SCOPE = 'scope';
export const COOKIE_RETURN_TO = 'oauth_return_to';

export function cookieOptions(maxAge: number, dev: boolean) {
	return {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax' as const,
		maxAge
	};
}

export function clearAuthCookies(cookies: Cookies) {
	cookies.delete(COOKIE_DID, { path: '/' });
	cookies.delete(COOKIE_SCOPE, { path: '/' });
}
