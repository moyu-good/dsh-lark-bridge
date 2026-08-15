/**
 * First-boot credential acquisition through the official Lark QR device-code
 * flow (`registerApp`): a scannable code is shown on the console, the scanning
 * user confirms app creation in Feishu (event subscription is configured by
 * that flow), and the resulting credentials are handed back for persistence and
 * connection.
 *
 * A code expires after a window the platform states when it issues one. Nobody
 * scanning inside that window is the ordinary case — an operator installs the
 * plugin, the process starts, and they get to it later — so an expired code is
 * re-issued rather than reported as a failure. Every other rejection stops: a
 * refused authorization or a rejected request needs a human decision, and a new
 * code would not supply one.
 * @module dsh-lark-bridge/onboarding
 */
import type { Context } from '@deepseek-ai/cordis';
/** One Lark app credential pair produced by registration or configuration. */
export interface LarkCredentials {
    appId: string;
    appSecret: string;
}
/** What a completed scan establishes: the credentials, plus who registered them. */
export interface OnboardedApp extends LarkCredentials {
    /**
     * Open id of the user who scanned, reported so an operator who later wants to
     * narrow `senderAllowlist` or `approvers` has it to hand. It authorizes
     * nothing by itself: who may reach the bot is the app's visibility scope.
     */
    registeredBy?: string;
}
/** The registration request this plugin sends through {@link RegisterAppPort}. */
export interface RegisterAppRequest {
    /** Caller tag carried on the QR URL as `source/<name>`. */
    source: string;
    /**
     * An existing app to authorize instead of creating one, when the deployment
     * configured its id but not its secret. The confirm page asks the user to
     * re-authorize that app explicitly.
     */
    appId?: string;
    /** Pre-filled name/description shown on the app-creation page. */
    appPreset: {
        name: string;
        desc: string;
    };
    /** Aborting withdraws the pending scan. */
    signal: AbortSignal;
    /** Called once the QR URL is ready to show. */
    onQRCodeReady(info: {
        url: string;
        expireIn: number;
    }): void;
}
/**
 * The QR-registration surface the onboarding flow drives. The official
 * `registerApp` from `@larksuite/channel` satisfies it; tests substitute a fake.
 */
export type RegisterAppPort = (options: RegisterAppRequest) => Promise<{
    client_id: string;
    client_secret: string;
    /** The scanning user; their open id is this channel's owner by construction. */
    user_info?: {
        open_id?: string;
    };
}>;
/** What {@link beginOnboarding} needs to run and to report. */
export interface OnboardingRun {
    /** Scoped plugin context; owns the abort lifetime and logging. */
    readonly ctx: Context;
    /** The QR-registration surface to drive. */
    readonly register: RegisterAppPort;
    /** Operator console line (the default profile composes no logger printer). */
    readonly notify: (line: string) => void;
    /** Store the credentials durably; resolves false when no store exists. */
    readonly persist: (app: OnboardedApp) => Promise<boolean>;
    /** Continue with live credentials (connect the channel). */
    readonly onCredentials: (app: OnboardedApp) => void;
    /** An existing app to re-authorize, when the deployment configured an id but no secret. */
    readonly appId?: string | undefined;
    /** Overrides {@link REISSUE_FLOOR_MS}, so a test need not wait out a real one. */
    readonly reissueFloorMs?: number;
}
/**
 * Start the QR onboarding flow as a fiber-owned effect. The pending scan is
 * withdrawn on disposal; a completed scan persists first, then hands the
 * credentials to `onCredentials` unless the fiber already unwound. An expired
 * code is replaced by a fresh one for as long as this fiber lives.
 * @param run - the surfaces to drive and the sinks to report through.
 */
export declare function beginOnboarding(run: OnboardingRun): void;
//# sourceMappingURL=onboarding.d.ts.map