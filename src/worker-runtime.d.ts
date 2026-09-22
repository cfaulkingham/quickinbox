// Keep Worker globals out of the browser's DOM types in this full-stack app.
declare module 'cloudflare:workers' {
	export const DurableObject: typeof import('@cloudflare/workers-types').CloudflareWorkersModule.DurableObject;
}
type DurableObjectNamespace<
	T extends
		import('@cloudflare/workers-types').Rpc.DurableObjectBranded | undefined =
		undefined
> = import('@cloudflare/workers-types').DurableObjectNamespace<T>;
