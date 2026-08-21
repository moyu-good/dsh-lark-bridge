/**
 * Bilingual command descriptions for the slash panel and `/help`.
 *
 * The host commands (dsh: goal, compact, feedback, …) ship English
 * descriptions; the bridge's own commands were written Chinese-first. Both
 * surfaces — the Feishu `/` panel and the `/help` listing — present the same
 * commands, so one table keeps them in step and lets a deployment pick its
 * language: the international Lark console (`open.larksuite.com`) gets
 * English, the domestic Feishu one (`open.feishu.cn`) gets Chinese, and
 * `locale: zh|en` in the profile forces either.
 * @module dsh-lark-bridge/i18n
 */
/**
 * Bridge-owned commands and the dsh host commands a chat profile composes
 * (goal, compact, feedback). Anything the roster adds without an entry here
 * falls back to its own description, verbatim.
 */
export const COMMAND_DESCRIPTIONS = {
    // Bridge-owned commands.
    stop: { zh: '停止当前任务', en: 'Stop the current task' },
    preset: { zh: '查看/切换模式（标准/PTC/极简/创造）', en: 'View or switch mode (standard/PTC/minimal/cordis)' },
    sessions: { zh: '查看本聊天的会话历史', en: 'View this chat’s session history' },
    tools: { zh: '查看/禁用/恢复工具', en: 'View, deny, or allow tools' },
    schedules: { zh: '查看本聊天的定时提醒', en: 'View this chat’s scheduled reminders' },
    jobs: { zh: '查看本会话的后台任务', en: 'View this session’s background jobs' },
    context: { zh: '查看上下文 token 压力', en: 'View context token pressure' },
    skills: { zh: '查看可用 skills / 查看某个 skill', en: 'List skills / inspect one skill' },
    model: { zh: '查看/切换默认模型', en: 'View or switch the default model' },
    audit: { zh: '查看本会话的操作审计', en: 'View this session’s operation audit' },
    config: { zh: '查看桥的当前配置', en: 'View the bridge’s current configuration' },
    help: { zh: '显示可用命令', en: 'Show available commands' },
    // dsh host commands a chat profile composes.
    goal: { zh: '查看/设置目标', en: 'Set or view the goal' },
    compact: { zh: '压缩较早的对话历史', en: 'Compact older conversation history' },
    feedback: { zh: '提交本次会话反馈', en: 'Record feedback about this session' },
    plan: { zh: '进入/退出计划模式', en: 'Enter or leave plan mode' },
    // Commonly encountered host commands, in case other bundles add them.
    clear: { zh: '清空当前上下文', en: 'Clear the current context' },
    new: { zh: '新开会话', en: 'Start a new session' },
    settings: { zh: '查看/修改设置', en: 'View or change settings' },
    permission: { zh: '查看权限模式', en: 'View permission mode' },
    schedule: { zh: '管理定时提醒', en: 'Manage scheduled reminders' },
    sessions_alt: { zh: '查看会话', en: 'View sessions' },
};
/**
 * Resolve one command's description for a locale.
 * @param name - the command name (without slash).
 * @param locale - the target language.
 * @param fallback - the host's own description, used when this table has no
 * entry for the command.
 * @returns the description to show.
 */
export function describeCommand(name, locale, fallback) {
    const entry = COMMAND_DESCRIPTIONS[name];
    if (entry === undefined)
        return fallback;
    return locale === 'en' ? entry.en : entry.zh;
}
/** Heading for the `/help` listing. */
export function helpHeading(locale) {
    return locale === 'en' ? '**Available commands**' : '**可用命令**';
}
//# sourceMappingURL=i18n.js.map