/**
 * Lark/Feishu IM bot channel for DeepSeek Harness: each chat drives its own
 * agent, committed assistant output returns as chat messages, and approval
 * questions become interactive cards.
 * @module dsh-lark-bridge
 */
/** Cordis plugin name; keep this stable after publishing. */
export declare const name = "dsh-lark-bridge";
/** Services that must exist before the plugin is applied. */
export declare const inject: string[];
export { Config } from './config.ts';
export type { ResolvedConfig } from './config.ts';
export { apply } from './runtime.ts';
export type { ChannelConfig } from './runtime.ts';
export type { ChannelPort } from './bridge.ts';
export type { LarkCredentials, RegisterAppPort } from './onboarding.ts';
//# sourceMappingURL=index.d.ts.map