import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
export default defineConfig(({ mode }) => ({
  plugins: [sveltekit()],
  server: { port: Number(loadEnv(mode, process.cwd(), 'PUBLIC_').PUBLIC_DEV_PORT || '5173') }
}));
