import { resolveConfig, type AtprotoAuthConfig } from './config.js';
import { createHandle } from './handle.js';
import { createHandlers, type Handlers } from './handlers.js';
import { createApi, type Api, type CurrentSession } from './api.js';
import type { Handle } from '@sveltejs/kit';

export interface AtprotoAuth {
	/** Mount in `hooks.server.ts`: `export const handle = atproto.handle;` */
	handle: Handle;

	/**
	 * Raw request handlers, in case you want to mount them as real routes
	 * instead of relying on `handle`'s path interception. Each is a
	 * SvelteKit `RequestHandler`.
	 */
	handlers: Handlers;

	/**
	 * Imperative methods callable from server actions / remote functions
	 * (e.g. `await atproto.api.startLogin({ handle })` inside a form action).
	 */
	api: Api;
}

export function createAtprotoAuth(config: AtprotoAuthConfig): AtprotoAuth {
	const resolved = resolveConfig(config);
	return {
		handle: createHandle(resolved),
		handlers: createHandlers(resolved),
		api: createApi(resolved)
	};
}

export type { AtprotoAuthConfig, CurrentSession, Handlers, Api };
export type { SessionsStore, StatesStore, AnyStore } from './config.js';
export type { Store, StoredSession, StoredState, OAuthSession } from '@atcute/oauth-node-client';
export type { Did } from '@atcute/lexicons';
export type { Client } from '@atcute/client';
