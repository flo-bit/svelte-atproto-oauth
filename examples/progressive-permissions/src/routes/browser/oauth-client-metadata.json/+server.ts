import { json } from '@sveltejs/kit';
import { auth } from '$lib/auth.browser';
export const GET = () => json(auth.metadata);
