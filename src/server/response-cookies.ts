import type { Cookies, RequestEvent } from '@sveltejs/kit';

/**
 * A Response returned directly from handle bypasses SvelteKit's cookie flush.
 * Capture library cookie mutations while still updating the real request jar.
 * Only stamp returned responses; resolve() and thrown redirects flush the jar
 * themselves. Use the public serializer so defaults and escaping match Kit.
 */
export async function withCookieHeaders(
	event: RequestEvent,
	operation: () => Promise<Response | undefined>
): Promise<Response | undefined> {
	const cookies = event.cookies;
	const originalSet = cookies.set;
	const originalDelete = cookies.delete;
	const pending = new Map<string, string>();
	const record = (name: string, value: string, options: Parameters<Cookies['set']>[2]) => {
		const key = JSON.stringify([name, options?.domain ?? '', options?.path ?? '/']);
		pending.set(key, cookies.serialize(name, value, options ?? { path: '/' }));
	};
	// Kit 3 makes event.cookies readonly. Wrap its mutable methods instead of
	// replacing the jar, retaining any additional methods supplied by Kit.
	cookies.set = (name, value, options) => {
		originalSet.call(cookies, name, value, options);
		record(name, value, options);
	};
	cookies.delete = (name, options) => {
		originalDelete.call(cookies, name, options);
		record(name, '', { ...options, maxAge: 0 });
	};
	try {
		const response = await operation();
		if (!response || pending.size === 0) return response;
		// Cloning headers also supports responses with an immutable header guard.
		const headers = new Headers(response.headers);
		for (const value of pending.values()) headers.append('set-cookie', value);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	} finally {
		cookies.set = originalSet;
		cookies.delete = originalDelete;
	}
}
