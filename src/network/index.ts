import {
	CompositeDidDocumentResolver, CompositeHandleResolver, DohJsonHandleResolver,
	LocalActorResolver, PlcDidDocumentResolver, WebDidDocumentResolver, WellKnownHandleResolver,
	type ActorResolver, type DidDocumentResolver, type HandleResolver
} from '@atcute/identity-resolver';

export type { ActorResolver, DidDocumentResolver, HandleResolver } from '@atcute/identity-resolver';
export type NetworkEndpoint = 'plc' | 'doh' | 'slingshot' | 'ufo' | 'constellation' | 'appview' | 'cdn';
const defaults: Record<NetworkEndpoint, string> = {
	plc: 'https://plc.directory',
	doh: 'https://mozilla.cloudflare-dns.com/dns-query',
	slingshot: 'https://slingshot.microcosm.blue',
	ufo: 'https://ufos-api.microcosm.blue',
	constellation: 'https://constellation.microcosm.blue',
	appview: 'https://public.api.bsky.app',
	cdn: 'https://cdn.bsky.app'
};

export interface IdentityOptions {
	/** PLC directory base URL. */
	plc?: string;
	doh?: string;
	/** Complete resolver override; failures never fall back to the default actor resolver. */
	actorResolver?: ActorResolver;
	handleResolver?: HandleResolver;
	didDocumentResolver?: DidDocumentResolver;
	/** Custom transport for identity resolution and server/helper requests. */
	fetch?: typeof globalThis.fetch;
	network?: AtprotoNetwork;
}
interface CommonNetworkOptions extends Omit<IdentityOptions, 'network'> {
	slingshot?: string | false;
	ufo?: string | false;
	constellation?: string | false;
	appview?: string | false;
	cdn?: string | false;
}
export type NetworkOptions = CommonNetworkOptions & (
	| { mode?: 'production'; namespace?: string; allowedOrigins?: never; sandbox?: never }
	| {
		mode: 'isolated';
		/** Separate cache/browser-storage namespace. Do not share with production. */
		namespace: string;
		/** Exact permitted origins, including PDS and AS origins discovered from metadata. */
		allowedOrigins: readonly string[];
		/** Test-only transport/protocol exceptions. Not accepted in production mode. */
		sandbox?: { fetch?: typeof globalThis.fetch; httpOrigins?: readonly string[] };
	}
);

export interface AtprotoNetwork {
	readonly isolated: boolean;
	readonly fetch: typeof globalThis.fetch;
	readonly identity: Readonly<Omit<IdentityOptions, 'network'>>;
	endpoint(name: NetworkEndpoint, override?: string | false): string | false;
	assertUrl(url: string | URL): void;
	cacheKey(key: string): string;
}

/** Explicit network profile, not a DNS/IP-level SSRF firewall. Custom transports must honor redirects. */
export function createAtprotoNetwork(options: NetworkOptions): AtprotoNetwork {
	if (options.mode !== undefined && options.mode !== 'production' && options.mode !== 'isolated')
		throw new TypeError('Unknown network mode');
	const isolated = options.mode === 'isolated';
	if (!isolated && ('sandbox' in options || 'allowedOrigins' in options))
		throw new TypeError('Sandbox exceptions and origin restrictions require isolated mode');
	if (isolated && (!options.namespace?.trim() || !options.allowedOrigins?.length))
		throw new TypeError('Isolated networks require a namespace and allowedOrigins');
	const config = { ...options };
	const origins = new Set(isolated ? options.allowedOrigins.map(origin) : []);
	const httpOrigins = new Set(isolated ? options.sandbox?.httpOrigins?.map(origin) : []);
	for (const value of httpOrigins) if (!origins.has(value))
		throw new TypeError('Sandbox HTTP exceptions must also be in allowedOrigins');
	const assertUrl = (value: string | URL) => {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
			throw new TypeError('Invalid network endpoint');
		if (isolated && (!origins.has(url.origin) || (url.protocol === 'http:' && !httpOrigins.has(url.origin))))
			throw new Error('Endpoint is outside the configured isolated network');
	};
	const transport = isolated ? options.sandbox?.fetch ?? options.fetch ?? globalThis.fetch : options.fetch ?? globalThis.fetch;
	const fetchThis: typeof globalThis.fetch = isolated
		? async (input, init) => {
			assertUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
			const response = await transport(input, { ...init, redirect: 'error', credentials: 'omit' });
			if (response.redirected || (response.status >= 300 && response.status < 400))
				throw new Error('Redirects are forbidden for the isolated network');
			if (response.url) assertUrl(response.url);
			return response;
		}
		: transport;
	const network: AtprotoNetwork = Object.freeze({
		isolated,
		fetch: fetchThis,
		identity: Object.freeze({
			plc: config.plc, doh: config.doh, actorResolver: config.actorResolver,
			handleResolver: config.handleResolver, didDocumentResolver: config.didDocumentResolver
		}),
		assertUrl,
		cacheKey: (key: string) => config.namespace ? `atproto-network:${config.namespace}:${key}` : key,
		endpoint(name: NetworkEndpoint, override?: string | false) {
			const value = override ?? config[name];
			if (value === undefined && isolated) throw new Error(`Configure ${name} explicitly for the isolated network`);
			if (value === false) return false;
			const endpoint = value ?? defaults[name];
			assertUrl(endpoint);
			return endpoint.replace(/\/+$/, '');
		}
	});
	if (isolated && !config.actorResolver) {
		if (!config.handleResolver) network.endpoint('doh');
		if (!config.didDocumentResolver) network.endpoint('plc');
	}
	for (const name of Object.keys(defaults) as NetworkEndpoint[]) {
		if (config[name] !== undefined) network.endpoint(name);
	}
	return network;
}

function origin(value: string): string {
	const url = new URL(value);
	if (url.href !== `${url.origin}/` || url.username || url.password || !['http:', 'https:'].includes(url.protocol))
		throw new TypeError('allowedOrigins must contain HTTP(S) origins without paths');
	return url.origin;
}

export function endpoint(options: { network?: AtprotoNetwork }, name: NetworkEndpoint, override?: string | false): string | false {
	return options.network ? options.network.endpoint(name, override) : override ?? defaults[name];
}
export function requiredEndpoint(options: { network?: AtprotoNetwork }, name: NetworkEndpoint, override?: string | false): string {
	const value = endpoint(options, name, override);
	if (value === false) throw new Error(`${name} is disabled for this network`);
	return value;
}
export function networkFetch(options: Pick<IdentityOptions, 'network' | 'fetch'>): typeof globalThis.fetch {
	if (options.network && options.fetch) throw new TypeError('Configure custom fetch on the network profile, not per call');
	return options.network?.fetch ?? options.fetch ?? globalThis.fetch;
}
export function networkCacheKey(options: { network?: AtprotoNetwork }, key: string, kind?: string): string {
	return options.network?.cacheKey(kind ? `${kind}:${key}` : key) ?? key;
}

export function createHandleResolver(options: IdentityOptions = {}): HandleResolver {
	const supplied = options.handleResolver ?? options.network?.identity.handleResolver;
	if (supplied) return supplied;
	const dns = new DohJsonHandleResolver({
		dohUrl: requiredEndpoint(options, 'doh', options.doh ?? options.network?.identity.doh),
		fetch: networkFetch(options)
	});
	// A private DNS miss must not trigger a production well-known lookup.
	if (options.network?.isolated) return dns;
	return new CompositeHandleResolver({ methods: {
		dns, http: new WellKnownHandleResolver({ fetch: networkFetch(options) })
	} });
}
export function createDidDocumentResolver(options: IdentityOptions = {}): DidDocumentResolver {
	return options.didDocumentResolver ?? options.network?.identity.didDocumentResolver ?? new CompositeDidDocumentResolver({ methods: {
		plc: new PlcDidDocumentResolver({
			apiUrl: requiredEndpoint(options, 'plc', options.plc ?? options.network?.identity.plc),
			fetch: networkFetch(options)
		}),
		web: new WebDidDocumentResolver({ fetch: networkFetch(options) })
	} });
}
export function createActorResolver(options: IdentityOptions = {}): ActorResolver {
	const resolver = options.actorResolver ?? options.network?.identity.actorResolver ?? new LocalActorResolver({
		handleResolver: createHandleResolver(options), didDocumentResolver: createDidDocumentResolver(options)
	});
	if (!options.network?.isolated) return resolver;
	const network = options.network;
	return { async resolve(actor, opts) {
		const identity = await resolver.resolve(actor, opts);
		network.assertUrl(identity.pds);
		return identity;
	} };
}
