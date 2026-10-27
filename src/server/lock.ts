import type { ResolvedConfig } from './config.js';

export type RequestLock = <T>(name: string, operation: () => Promise<T>) => Promise<T>;
const pending = new Map<string, Promise<unknown>>();
/** Serializes SDK refreshes, authorization commits, and logout in this process. Not a distributed lock. */
export const localRequestLock: RequestLock = async (name, operation) => {
	const previous = pending.get(name);
	const current = (async () => {
		if (previous) await previous.catch(() => {});
		return operation();
	})();
	pending.set(name, current);
	try {
		return await current;
	} finally {
		if (pending.get(name) === current) pending.delete(name);
	}
};
export function clientRequestLock(config: ResolvedConfig): RequestLock {
	const prefix = config.origin
		? config.origin + config.metadataPath
		: `loopback:${config.devPort}${config.redirectPath}`;
	return (name, operation) => config.requestLock(`${prefix}:${name}`, operation);
}
