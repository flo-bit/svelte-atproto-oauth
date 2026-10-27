import { fail, redirect } from '@sveltejs/kit';
import { auth } from '$lib/auth.server';
import { blobScope, collection, declaredScope, repoScope } from '$lib/scopes';
import { recordProbe, updateProbe, serviceAuthProbe, uploadProbe } from '$lib/probes';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, request }) => ({
	declaredScope,
	// Presence only, from the incoming header (before SvelteKit flushes its cookie jar).
	hasDidCookie: /(?:^|;\s*)did=/.test(request.headers.get('cookie') ?? ''),
	hasScopeCookie: /(?:^|;\s*)scope=/.test(request.headers.get('cookie') ?? ''),
	permissions: await auth.api.getPermissions(),
	error: url.searchParams.get('error'),
	canWrite: await auth.api.can({ type: 'repo', collection, action: 'create' }),
	canUpload: await auth.api.can({ type: 'blob', mimeType: 'image/png' })
});
export const actions: Actions = {
	login: async ({ request }) => {
		const fd = await request.formData();
		const { url } = await auth.api.startLogin({
			handle: String(fd.get('handle') || '') || undefined,
			scope: fd.getAll('scope').map(String),
			returnTo: '/'
		});
		redirect(303, url);
	},
	upgrade: async ({ request }) => {
		const fd = await request.formData();
		const scope = fd.getAll('scope').map(String);
		const { url } = await auth.api.requestPermissions({ scope, returnTo: '/' });
		if (url) redirect(303, url);
		return {
			message: 'Concrete requested scopes were already granted.',
			snapshot: await auth.api.getPermissions()
		};
	},
	refresh: async () => {
		try {
			return {
				message: 'Forced token refresh completed.',
				snapshot: await auth.api.getPermissions({ refresh: true })
			};
		} catch {
			return fail(503, {
				message: 'Refresh failed; inspect session recovery without logging tokens.'
			});
		}
	},
	probeServiceAuth: async ({ request, locals }) => {
		const variant = String((await request.formData()).get('variant') || '');
		if (!locals.client || !['allowed', 'wrongMethod', 'wrongAudience'].includes(variant))
			return fail(400, { message: 'Sign in and choose a service-auth probe.' });
		try {
			return { operation: await serviceAuthProbe(locals.client, variant as 'allowed' | 'wrongMethod' | 'wrongAudience') };
		} catch {
			return fail(502, { message: 'Service-auth probe failed. No token is displayed or forwarded.' });
		}
	},
	probeRecord: async ({ request, locals }) => {
		const fd = await request.formData();
		if (!locals.client || !locals.did || fd.get('confirm') !== 'yes')
			return fail(400, { message: 'Sign in and explicitly confirm the public test write.' });
		try {
			return { operation: await recordProbe(locals.client, locals.did) };
		} catch {
			return fail(502, {
				message: 'Probe failed. Check your repository for an uncleaned test record.'
			});
		}
	},
	probeUpdate: async ({ request, locals }) => {
		const fd = await request.formData();
		const rkey = String(fd.get('rkey') || '');
		const cid = String(fd.get('cid') || '');
		if (!locals.client || !locals.did || fd.get('confirm') !== 'yes' ||
			!/^[a-zA-Z0-9._~:-]{1,512}$/.test(rkey) || rkey === '.' || rkey === '..' ||
			!/^[a-zA-Z0-9]{1,512}$/.test(cid))
			return fail(400, { message: 'Confirm the update and supply this test record key/CID.' });
		try {
			return { operation: await updateProbe(locals.client, locals.did, rkey, cid) };
		} catch {
			return fail(502, { message: 'Update failed. The original test record still needs cleanup.' });
		}
	},
	probeUpload: async ({ request, locals }) => {
		const fd = await request.formData();
		const file = fd.get('image');
		if (!locals.client || fd.get('confirm') !== 'yes' || !(file instanceof File))
			return fail(400, { message: 'Sign in, choose an image, and confirm the upload.' });
		try {
			return { operation: await uploadProbe(locals.client, file) };
		} catch {
			return fail(502, { message: 'Upload failed or image exceeded 1 MiB.' });
		}
	},
	cleanup: async ({ request, locals }) => {
		const fd = await request.formData();
		if (!locals.client || !locals.did || fd.get('confirm') !== 'yes')
			return fail(400, { message: 'Confirm cleanup.' });
		const rkey = String(fd.get('rkey') || '');
		if (!/^[a-zA-Z0-9._~:-]{1,512}$/.test(rkey) || rkey === '.' || rkey === '..')
			return fail(400, { message: 'Invalid record key.' });
		try {
			const result = await locals.client.post('com.atproto.repo.deleteRecord', {
				input: { repo: locals.did, collection, rkey }
			});
			return { operation: { ok: result.ok, status: result.status, phase: 'manual cleanup' } };
		} catch {
			return fail(502, { message: 'Cleanup failed.' });
		}
	},
	logout: async () => {
		await auth.api.logout();
		redirect(303, '/');
	}
};
