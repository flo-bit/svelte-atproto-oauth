#!/usr/bin/env node
import { generateClientAssertionKey } from '@atcute/oauth-node-client';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const cwd = process.cwd();

async function generateSecret(): Promise<string> {
	return randomBytes(32).toString('base64url');
}

async function generateKey(): Promise<string> {
	const jwk = await generateClientAssertionKey('main-key');
	return JSON.stringify(jwk);
}

function getValue(content: string, key: string): string | undefined {
	const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
	if (!m) return undefined;
	return m[1].trim().replace(/^["']|["']$/g, '');
}

function upsertVar(input: string, key: string, value: string): string {
	const line = `${key}=${value}`;
	const re = new RegExp(`^${key}=.*$`, 'm');
	if (re.test(input)) return input.replace(re, line);
	const suffix = input.length === 0 || input.endsWith('\n') ? '' : '\n';
	return `${input}${suffix}${line}\n`;
}

async function setup() {
	const envPath = resolve(cwd, '.env');
	const examplePath = resolve(cwd, '.env.example');

	if (!existsSync(envPath)) {
		if (existsSync(examplePath)) {
			await copyFile(examplePath, envPath);
			console.log('created .env from .env.example');
		} else {
			await writeFile(envPath, '');
			console.log('created empty .env');
		}
	}

	let content = await readFile(envPath, 'utf8');
	let changed = false;

	const cookieSecret = getValue(content, 'COOKIE_SECRET');
	if (!cookieSecret) {
		content = upsertVar(content, 'COOKIE_SECRET', await generateSecret());
		console.log('  ✓ COOKIE_SECRET');
		changed = true;
	} else {
		console.log('  · COOKIE_SECRET (already set, leaving as-is)');
	}

	const clientKey = getValue(content, 'CLIENT_ASSERTION_KEY');
	if (!clientKey) {
		content = upsertVar(content, 'CLIENT_ASSERTION_KEY', await generateKey());
		console.log('  ✓ CLIENT_ASSERTION_KEY');
		changed = true;
	} else {
		console.log('  · CLIENT_ASSERTION_KEY (already set, leaving as-is)');
	}

	if (changed) {
		await writeFile(envPath, content);
		console.log(`updated ${envPath}`);
	} else {
		console.log('nothing to do');
	}
}

function usage() {
	console.error(`Usage: atproto-oauth <command>

Commands:
  setup    Generate COOKIE_SECRET and CLIENT_ASSERTION_KEY in .env
           (creates .env from .env.example if missing; only fills empty values)
  keygen   Print a fresh CLIENT_ASSERTION_KEY (JWK JSON) to stdout
  secret   Print a fresh 32-byte base64url secret to stdout

Pipe \`keygen\` / \`secret\` into your secrets manager:
  atproto-oauth secret | wrangler secret put COOKIE_SECRET
  atproto-oauth keygen | wrangler secret put CLIENT_ASSERTION_KEY`);
}

const cmd = process.argv[2];

(async () => {
	try {
		switch (cmd) {
			case 'setup':
				await setup();
				break;
			case 'keygen':
				process.stdout.write(await generateKey());
				break;
			case 'secret':
				process.stdout.write(await generateSecret());
				break;
			case undefined:
			case 'help':
			case '--help':
			case '-h':
				usage();
				process.exit(cmd === undefined ? 1 : 0);
				break;
			default:
				console.error(`unknown command: ${cmd}\n`);
				usage();
				process.exit(1);
		}
	} catch (e) {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	}
})();
