// Kit 3 retains this runtime alias (with a deprecation warning), but no
// longer declares its types. Keep using it inside the library so the same
// package also runs on older Kit 2 versions without $app/env. Generated
// applications use their own Kit major's preferred environment module.
declare module '$app/environment' {
	export const dev: boolean;
	export const building: boolean;
}
