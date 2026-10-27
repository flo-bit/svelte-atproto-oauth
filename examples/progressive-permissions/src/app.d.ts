import type { OAuthSession, Client, Did } from '@svelte-atproto/oauth/server';
declare global {
	namespace App {
		interface Locals {
			session: OAuthSession | null;
			client: Client | null;
			did: Did | null;
		}
	}
}
export {};
