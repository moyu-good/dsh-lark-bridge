/**
 * Serializable configuration, schema, and direct-call defaults.
 * @module dsh-lark-bridge/config
 */
import z from '@deepseek-ai/schemastery';
/**
 * Human-interaction tools whose answer cannot reach a chat: both ask through
 * `ctx.userQuestions`, whose single provider belongs to whichever UI registered
 * it first. Denied per chat agent so the model asks in the chat instead.
 */
// ask_user_question and exit_plan_mode are enabled by default: on a chat
// profile (bundles without the web-app api-proxy) the bridge registers the
// single user-questions provider and renders the model's question — and the
// plan-mode exit review — as a Feishu card. Deployments that still run the
// web profile (api-proxy owns the provider slot) should deny both via
// denyTools so the model asks in prose instead of blocking.
const DEFAULT_DENY_TOOLS = [];
/** Loader-visible configuration schema and defaults. */
export const Config = z.object({
    appId: z.string(),
    appSecret: z.string().role('secret'),
    domain: z.string(),
    cwd: z.string(),
    provider: z.string(),
    model: z.string(),
    preset: z.string(),
    sessionScope: z.union(['chat', 'chat-thread', 'chat-sender']).default('chat'),
    locale: z.union(['auto', 'zh', 'en']).default('auto'),
    output: z.union(['cot', 'stream']).default('cot'),
    showProcess: z.boolean().default(true),
    attachImages: z.boolean().default(false),
    hideProcessWhenDone: z.boolean().default(false),
    syncSlashCommands: z.boolean().default(true),
    chronicleEndpoint: z.string().default(''),
    briefingFile: z.string().default(''),
    autoSaveFiles: z.boolean().default(true),
    modelCatalog: z.array(z.string()).default([]),
    chronicleSource: z.string().default('lark-bridge'),
    onboarding: z.boolean().default(true),
    denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),
    requireMention: z.boolean().default(true),
    reactionFeedback: z.boolean().default(true),
    senderAllowlist: z.array(String),
    groupAllowlist: z.array(String),
    approvers: z.array(String),
    autoResumeGoals: z.boolean().default(false),
    restartCommand: z.string().default(''),
    approvalReminderMs: z.number().min(0).default(0),
    controlPort: z.number().min(0).default(0),
    outbound: z.object({
        allowedFileDirs: z.array(String),
    }),
    tokenPressure: z.object({
        enabled: z.boolean(),
        intervalMs: z.number().min(60_000),
        threshold: z.number().min(1),
    }),
});
/**
 * Resolve the panel/help language. Explicit `zh`/`en` wins; `auto` (and
 * absent) follows the platform domain — the international Lark console lives
 * at `open.larksuite.com`, the domestic Feishu one at `open.feishu.cn`.
 * @param config - serialized configuration.
 * @returns the resolved language.
 */
export function resolveLocale(config) {
    if (config.locale === 'zh' || config.locale === 'en')
        return config.locale;
    return config.domain?.includes('larksuite') === true ? 'en' : 'zh';
}
/**
 * Resolve the same defaults for direct callers that bypass Cordis Loader.
 * @param config - Serialized configuration with the required credentials.
 * @returns Configuration with all schema defaults applied.
 */
export function resolveConfig(config) {
    return {
        ...config,
        locale: resolveLocale(config),
        sessionScope: config.sessionScope ?? 'chat',
        output: config.output ?? 'cot',
        showProcess: config.showProcess ?? true,
        attachImages: config.attachImages ?? false,
        hideProcessWhenDone: config.hideProcessWhenDone ?? false,
        syncSlashCommands: config.syncSlashCommands ?? true,
        chronicleEndpoint: config.chronicleEndpoint ?? '',
        controlPort: config.controlPort ?? 0,
        chronicleSource: config.chronicleSource ?? 'lark-bridge',
        briefingFile: config.briefingFile ?? '',
        autoSaveFiles: config.autoSaveFiles ?? true,
        modelCatalog: config.modelCatalog ?? [],
        onboarding: config.onboarding ?? true,
        denyTools: config.denyTools ?? [...DEFAULT_DENY_TOOLS],
        requireMention: config.requireMention ?? true,
        reactionFeedback: config.reactionFeedback ?? true,
        senderAllowlist: config.senderAllowlist ?? [],
        groupAllowlist: config.groupAllowlist ?? [],
        approvers: config.approvers ?? [],
        autoResumeGoals: config.autoResumeGoals ?? false,
        restartCommand: config.restartCommand ?? '',
        approvalReminderMs: config.approvalReminderMs ?? 0,
        outbound: config.outbound,
        tokenPressure: {
            enabled: config.tokenPressure?.enabled ?? true,
            intervalMs: config.tokenPressure?.intervalMs ?? 600_000,
            threshold: config.tokenPressure?.threshold ?? 120_000,
        },
    };
}
//# sourceMappingURL=config.js.map