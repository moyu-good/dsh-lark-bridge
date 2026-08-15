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
/** The supported display languages. */
export type Locale = 'zh' | 'en';
/** One command's description in both languages. */
export interface BilingualText {
    readonly zh: string;
    readonly en: string;
}
/**
 * Bridge-owned commands and the dsh host commands a chat profile composes
 * (goal, compact, feedback). Anything the roster adds without an entry here
 * falls back to its own description, verbatim.
 */
export declare const COMMAND_DESCRIPTIONS: Record<string, BilingualText>;
/**
 * Resolve one command's description for a locale.
 * @param name - the command name (without slash).
 * @param locale - the target language.
 * @param fallback - the host's own description, used when this table has no
 * entry for the command.
 * @returns the description to show.
 */
export declare function describeCommand(name: string, locale: Locale, fallback: string): string;
/** Heading for the `/help` listing. */
export declare function helpHeading(locale: Locale): string;
//# sourceMappingURL=i18n.d.ts.map