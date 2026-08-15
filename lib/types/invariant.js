/**
 * Package-owned invariant companion for `dsh-lark-bridge`.
 * @module dsh-lark-bridge/invariant
 */
const PACKAGE_NAME = 'dsh-lark-bridge';
/** Cordis companion plugin name. */
export const name = 'dsh-lark-bridge-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: the bridge's chat→agent bindings and pending approval
 * cards are process-local ephemera keyed by host-owned ids; every durable
 * relation they touch (`user/message` events, the approval ask/outcome audit
 * pair) is owned and asserted by the host session and approval packages.
 */
const install = () => { };
/**
 * Resolve the host registry through Cordis's named service lookup. Keeping this
 * narrow local contract lets this package build without host source files; a
 * composed DSH profile still supplies the real `invariants` service.
 * @param ctx - Cordis context carrying the host service.
 * @returns the host invariant registry.
 * @throws {Error} when the companion is loaded without its host service.
 */
function getInvariantRegistry(ctx) {
    const registry = ctx.get('invariants');
    if (registry === undefined) {
        throw new Error(`invariant companion requires the "invariants" service for ${PACKAGE_NAME}`);
    }
    return registry;
}
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(getInvariantRegistry(ctx).register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map