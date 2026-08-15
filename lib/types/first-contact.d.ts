/**
 * First-contact guide: when a brand-new chat session is created, send a short
 * guide so a user who has never seen this bot knows what it is, what it can
 * do, and what its permission posture is. Existing sessions (resumed across
 * restarts) never get a second copy — the message fires only on `create`,
 * not on `resume`.
 *
 * The guide is written from real first-use failures: a user who typed
 * `/permission` with no argument saw a list and thought it was a menu to
 * answer, and a user who never clicked an approval card watched the bot hang
 * waiting for it. Both are covered explicitly below.
 * @module dsh-lark-bridge/first-contact
 */
/** The sandbox/permission mode the deployment runs under. */
export type PermissionPosture = 'workspace-write' | 'danger-full-access' | 'read-only' | string;
/**
 * Derive the permission posture from the same environment knob dsh-base reads
 * (`DSH_PERMISSION_MODE`, default `workspace-write`), so the guide always
 * matches what the session actually enforces.
 * @param env - process environment (injectable for tests).
 * @returns the posture name, defaulting to `workspace-write`.
 */
export declare function permissionPosture(env?: NodeJS.ProcessEnv): PermissionPosture;
/**
 * One sentence describing what the current posture means to the human in the
 * chat.
 */
export declare function postureLine(posture: PermissionPosture): string;
/**
 * The commands every user needs on day one, with the exact invocation that
 * works. Written to prevent the two real first-use failures: `/permission`
 * without an argument (a status line, not a menu) and an unclicked approval
 * card (the bot waits on it forever).
 */
export declare function commandGuide(posture: PermissionPosture): string;
/**
 * Render the first-contact guide for a brand-new session.
 * @param posture - the deployment's permission posture.
 * @returns the markdown message to send into the chat.
 */
export declare function onboardingText(posture: PermissionPosture): string;
/** The first-contact message, as a plain object for `port.send({ markdown })`. */
export declare function onboardingMessage(env?: NodeJS.ProcessEnv): {
    markdown: string;
};
//# sourceMappingURL=first-contact.d.ts.map