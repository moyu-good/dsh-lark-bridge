/**
 * The interactive account-switcher card for `/bot account`.
 *
 * Text commands make the operator paste names; a card makes switching two
 * taps: every saved account renders with 使用 / 忘记 buttons, and the click
 * value rides back through the cardAction event. The value payload is
 * namespaced (`kind`) so foreign card actions parse to undefined, and every
 * human-readable string rides `plain_text` so nothing can inject card markup
 * (the same rule as the question cards).
 * @module dsh-lark-bridge/account-card
 */
/** The button value namespace — every account-card button carries it. */
export declare const ACCOUNT_ACTION = "bot-account";
/** One roster row on the card. */
export interface AccountCardEntry {
    readonly name: string;
    readonly maskedAppId: string;
    readonly savedAt?: string | undefined;
    readonly active: boolean;
}
/** The parsed click payload of one account-card button. */
export interface AccountCardAction {
    readonly act: 'use' | 'forget';
    readonly name: string;
}
/**
 * Build the account-switcher card. Cap the roster at eight entries — beyond
 * that the card is a scroll pit and `/bot account save` curation is the
 * better fix.
 */
export declare function buildAccountCard(data: {
    entries: readonly AccountCardEntry[];
    hint?: string | undefined;
}): object;
/**
 * Narrow an arbitrary card-action value to this card's payload. Foreign
 * values (approval clicks, question answers, goal cards) parse to undefined.
 */
export declare function accountCardValue(value: unknown): AccountCardAction | undefined;
//# sourceMappingURL=account-card.d.ts.map