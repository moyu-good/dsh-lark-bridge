/**
 * Who may drive this channel's agents and answer their approval questions.
 *
 * The platform owns the outer boundary. An app's visibility scope decides who
 * in the tenant can reach the bot at all — for direct messages that IS the
 * authorization decision, made in the developer console — and a group is a room
 * someone deliberately put the bot in. This plugin therefore narrows rather
 * than gates: every list here is empty by default and only restricts when a
 * deployment fills it in.
 * @module dsh-lark-bridge/authorization
 */
/**
 * Resolve the narrowing rules from configuration.
 * @param config - resolved plugin configuration.
 * @returns the channel's authorization rules.
 */
export function resolveAuthorization(config) {
    return {
        directSenders: new Set(config.senderAllowlist),
        groups: new Set(config.groupAllowlist),
        approvers: new Set(config.approvers),
    };
}
/**
 * State the channel's reach once, for the operator, at startup — who it will
 * serve is a fact worth seeing next to the fact that it runs a shell.
 * @param authorization - the channel's authorization rules.
 * @returns one console line describing that reach.
 */
export function describeAuthorization(authorization) {
    const direct = authorization.directSenders.size === 0
        ? 'direct messages: anyone the app is visible to (narrow with senderAllowlist)'
        : `direct messages: ${[...authorization.directSenders].join(', ')}`;
    const groups = authorization.groups.size === 0
        ? 'groups: any group the bot is added to, when @-mentioned'
        : `groups: ${[...authorization.groups].join(', ')}`;
    const approvers = authorization.approvers.size === 0
        ? 'approvals: anyone who may drive that chat'
        : `approvals: ${[...authorization.approvers].join(', ')}`;
    return `dsh-lark-bridge: ${direct}; ${groups}; ${approvers}`;
}
/**
 * Whether one inbound message may drive this channel.
 * @param authorization - the channel's authorization rules.
 * @param subject - the message's sender, chat, and chat kind.
 * @returns the refusal reason for the operator log, or undefined when allowed.
 */
export function refuseMessage(authorization, subject) {
    if (subject.chatType === 'p2p') {
        if (authorization.directSenders.size === 0)
            return undefined;
        return authorization.directSenders.has(subject.senderId)
            ? undefined
            : `sender ${subject.senderId} is not in senderAllowlist`;
    }
    // Group members are not gated individually: someone chose to put the bot in
    // this room, and `requireMention` already decides what counts as addressing it.
    if (authorization.groups.size > 0 && !authorization.groups.has(subject.chatId)) {
        return `group ${subject.chatId} is not in groupAllowlist`;
    }
    return undefined;
}
/**
 * Whether one card click may settle an approval. With no configured approvers,
 * whoever may drive that chat may also answer it — in a group that is the room.
 * Narrow it with `approvers` when an escalation should need a named human.
 * @param authorization - the channel's authorization rules.
 * @param click - the clicking operator, and the chat the click came from.
 * @param pending - the chat the approval card was published to, and its kind.
 * @returns the refusal reason, or undefined when the click counts.
 */
export function refuseApprovalClick(authorization, click, pending) {
    // The card carries its own correlation id, so a click from elsewhere did not
    // come from the card this question published.
    if (click.chatId !== pending.chatId) {
        return `click from chat ${click.chatId} does not match the card's chat ${pending.chatId}`;
    }
    if (click.operatorId === undefined)
        return 'the click carries no operator id';
    if (authorization.approvers.size > 0) {
        return authorization.approvers.has(click.operatorId)
            ? undefined
            : `operator ${click.operatorId} is not in approvers`;
    }
    return refuseMessage(authorization, {
        senderId: click.operatorId,
        chatId: pending.chatId,
        chatType: pending.chatType,
    });
}
//# sourceMappingURL=authorization.js.map