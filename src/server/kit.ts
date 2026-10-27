// Handle moved from @sveltejs/kit to @sveltejs/kit/hooks in Kit 3.
// sequence accepts the hook type on both supported majors.
export type Handle = Parameters<typeof import('@sveltejs/kit/hooks').sequence>[0];
