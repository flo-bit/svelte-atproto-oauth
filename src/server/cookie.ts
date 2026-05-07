import type { Cookies } from '@sveltejs/kit';

const SEPARATOR = '.';

const keyCache = new WeakMap<{ secret: string }, CryptoKey>();
const secretRefs = new Map<string, { secret: string }>();

async function getKey(secret: string): Promise<CryptoKey> {
	let ref = secretRefs.get(secret);
	if (!ref) {
		ref = { secret };
		secretRefs.set(secret, ref);
	}
	const cached = keyCache.get(ref);
	if (cached) return cached;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
	keyCache.set(ref, key);
	return key;
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
	const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
	const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function getSignedCookie(
	cookies: Cookies,
	name: string,
	secret: string
): Promise<string | null> {
	const signed = cookies.get(name);
	if (!signed) return null;

	const idx = signed.lastIndexOf(SEPARATOR);
	if (idx === -1) return null;

	const value = signed.slice(0, idx);
	const sig = signed.slice(idx + 1);

	let sigBytes: Uint8Array;
	try {
		sigBytes = fromBase64Url(sig);
	} catch {
		return null;
	}

	const key = await getKey(secret);
	const ok = await crypto.subtle.verify(
		'HMAC',
		key,
		sigBytes,
		new TextEncoder().encode(value)
	);
	return ok ? value : null;
}

export async function setSignedCookie(
	cookies: Cookies,
	name: string,
	value: string,
	secret: string,
	options: Parameters<Cookies['set']>[2]
): Promise<void> {
	const key = await getKey(secret);
	const sig = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
	);
	cookies.set(name, `${value}${SEPARATOR}${toBase64Url(sig)}`, options);
}
