import type { Handle, RequestEvent } from '@sveltejs/kit';
import { building } from '$app/environment';
import type { ResolvedConfig } from './config.js';
import { restoreSession } from './session.js';
import { createHandlers, type Handlers } from './handlers.js';

export function createHandle(config: ResolvedConfig): Handle {
	const handlers = createHandlers(config);

	return async ({ event, resolve }) => {
		// Skip OAuth routing during prerender / build. The OAuth client needs
		// real env wiring; constructing it during build would crash.
		if (!building) {
			const intercepted = matchHandler(event, config, handlers);
			if (intercepted) {
				const result = await intercepted;
				return result as Response;
			}

			const restored = await restoreSession(event, config);
			// Loose cast — the user's `App.Locals` declaration controls the surface.
			const locals = event.locals as unknown as Record<string, unknown>;
			locals.session = restored.session;
			locals.client = restored.client;
			locals.did = restored.did;
		}

		return resolve(event);
	};
}

function matchHandler(
	event: RequestEvent,
	config: ResolvedConfig,
	handlers: Handlers
): ReturnType<Handlers[keyof Handlers]> | undefined {
	const path = event.url.pathname;
	const method = event.request.method;

	if (method === 'GET') {
		if (path === config.metadataPath) return handlers.metadata(event);
		if (path === config.jwksPath) return handlers.jwks(event);
		if (path === config.redirectPath) return handlers.callback(event);
	}
	if (method === 'POST') {
		if (path === config.loginPath) return handlers.login(event);
		if (path === config.logoutPath) return handlers.logout(event);
	}
	return undefined;
}
