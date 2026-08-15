/**
 * Startup entry for dsh-lark-bridge — the CLI boot composition registers the
 * plugin so `dsh web` / headless deployments can load it from a profile's
 * cordis.patch.yml. The plugin itself is self-contained; this file exists to
 * satisfy the dsh package entry convention (index/invariant/startup).
 */
export { name, Config, apply } from './index.ts';
//# sourceMappingURL=startup.d.ts.map