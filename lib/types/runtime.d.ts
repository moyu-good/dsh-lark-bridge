/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module dsh-lark-bridge/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
import type { ResolvedConfig } from './config.ts';
import { type ChannelPort } from './bridge.ts';
import type { LarkCredentials, RegisterAppPort } from './onboarding.ts';
import type { Authorization } from './authorization.ts';
/** Resolved configuration whose credentials are present; the transport can be built. */
export type ChannelConfig = ResolvedConfig & LarkCredentials;
/**
 * Create the production Lark transport from resolved configuration.
 * @param config - resolved plugin configuration with credentials.
 * @returns the real `@larksuite/channel` client behind the bridge's port surface.
 */
export declare function createLarkChannelPort(config: ChannelConfig, authorization: Authorization): ChannelPort;
/** Substitutable production boundaries; tests replace them with fakes. */
export declare const internals: {
    createPort: (config: ChannelConfig, authorization: Authorization) => ChannelPort;
    registerApp: RegisterAppPort;
    /** Operator console line; the default profile composes no logger printer. */
    notify: (line: string) => void;
    /** Shortest gap between two issued QR codes; absent keeps the onboarding default. */
    reissueFloorMs?: number;
};
/**
 * Apply the plugin to its Cordis context. With credentials configured (entry
 * config or a stored settings section) the transport connects directly;
 * without them the official QR registration flow runs first and persists the
 * scanned credentials through the host `settings` service when one is composed.
 * @param ctx - Scoped plugin context; requires the `agents` service.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=runtime.d.ts.map