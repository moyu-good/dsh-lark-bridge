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
/**
 * Default elision budgets, sized for a session someone is working in.
 *
 * The earlier fixed values (3 lines / 240 chars for a result, 120 chars per
 * argument, 700 for a job tail) were tuned for a chat read in passing, and lost
 * exactly the lines that answer "why did it fail": the last lines of a build
 * log, the middle of a command. The caps still exist — a 10k-line log must not
 * turn one card into a wall — they are just far enough out to keep the useful
 * part. `userMessageChars` stays under the 4096-character event bound.
 */
export const DEFAULT_LIMITS = {
    toolResultLines: 10,
    toolResultChars: 1600,
    toolArgChars: 400,
    userMessageChars: 3000,
    quoteChars: 6000,
    jobTailChars: 2500,
    approvalArgChars: 1000,
    skillPreviewChars: 2000,
    // 「这条是不是我要找的那条」，一个片段 60 字常常答不出来——刚好停在
    // 有信息量的那一段之前。给到一整句到两句话的长度。
    searchSnippetChars: 200,
    sessionPromptChars: 120,
    schedulePromptChars: 120,
};
/**
 * Apply defaults to a configured set of elision budgets.
 * @param config - the configured budgets, when any.
 * @returns every budget, with defaults filled in.
 */
export function resolveLimits(config) {
    return {
        toolResultLines: config?.toolResultLines ?? DEFAULT_LIMITS.toolResultLines,
        toolResultChars: config?.toolResultChars ?? DEFAULT_LIMITS.toolResultChars,
        toolArgChars: config?.toolArgChars ?? DEFAULT_LIMITS.toolArgChars,
        userMessageChars: config?.userMessageChars ?? DEFAULT_LIMITS.userMessageChars,
        quoteChars: config?.quoteChars ?? DEFAULT_LIMITS.quoteChars,
        jobTailChars: config?.jobTailChars ?? DEFAULT_LIMITS.jobTailChars,
        approvalArgChars: config?.approvalArgChars ?? DEFAULT_LIMITS.approvalArgChars,
        skillPreviewChars: config?.skillPreviewChars ?? DEFAULT_LIMITS.skillPreviewChars,
        searchSnippetChars: config?.searchSnippetChars ?? DEFAULT_LIMITS.searchSnippetChars,
        sessionPromptChars: config?.sessionPromptChars ?? DEFAULT_LIMITS.sessionPromptChars,
        schedulePromptChars: config?.schedulePromptChars ?? DEFAULT_LIMITS.schedulePromptChars,
    };
}
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
    busyPolicy: z.union(['queue', 'steer', 'inject']).default('queue'),
    showProcess: z.boolean().default(true),
    attachImages: z.boolean().default(false),
    hideProcessWhenDone: z.boolean().default(false),
    showMessageTime: z.boolean().default(true),
    syncSlashCommands: z.boolean().default(true),
    chronicleEndpoint: z.string().default(''),
    briefingFile: z.string().default(''),
    autoSaveFiles: z.boolean().default(true),
    presentBridge: z.boolean().default(true),
    announceSubagents: z.boolean().default(true),
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
    limits: z.object({
        toolResultLines: z.number().min(1),
        toolResultChars: z.number().min(1),
        toolArgChars: z.number().min(1),
        userMessageChars: z.number().min(1),
        quoteChars: z.number().min(1),
        jobTailChars: z.number().min(1),
        approvalArgChars: z.number().min(1),
        skillPreviewChars: z.number().min(1),
        searchSnippetChars: z.number().min(1),
        sessionPromptChars: z.number().min(1),
        schedulePromptChars: z.number().min(1),
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
        busyPolicy: config.busyPolicy ?? 'queue',
        showProcess: config.showProcess ?? true,
        attachImages: config.attachImages ?? false,
        hideProcessWhenDone: config.hideProcessWhenDone ?? false,
        showMessageTime: config.showMessageTime ?? true,
        syncSlashCommands: config.syncSlashCommands ?? true,
        chronicleEndpoint: config.chronicleEndpoint ?? '',
        controlPort: config.controlPort ?? 0,
        chronicleSource: config.chronicleSource ?? 'lark-bridge',
        briefingFile: config.briefingFile ?? '',
        autoSaveFiles: config.autoSaveFiles ?? true,
        presentBridge: config.presentBridge ?? true,
        announceSubagents: config.announceSubagents ?? true,
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
        limits: resolveLimits(config.limits),
    };
}
//# sourceMappingURL=config.js.map