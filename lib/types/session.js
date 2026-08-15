/**
 * Durable, scope-aware conversation sessions. One conversation facet — the
 * whole chat, one topic thread, or one sender inside a chat — owns exactly one
 * agent session whose id is derived from that facet alone, so a restarted
 * process reaches the conversation's stored session instead of starting it over
 * and a topic group no longer funnels every thread into one agent.
 * @module dsh-lark-bridge/session
 */
/**
 * Marks a session id as this channel's, in the host agent registry and in the
 * on-disk session log. Stable: changing it orphans every stored conversation.
 */
const SESSION_PREFIX = 'feishu-';
/** Separator between a conversation key's facets; absent from Feishu open ids. */
const FACET_SEPARATOR = ':';
/**
 * Render a handled failure as one operator-readable detail.
 * @param error - the rejection value, which need not be an `Error`.
 * @returns the message, or the stringified value for a non-error rejection.
 */
function failureDetail(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Derive the stable conversation key one session owns. Pure: the same
 * conversation facet yields the same key in every process.
 * @param scope - the facet a session is bound to.
 * @param msg - normalized inbound chat message.
 * @returns the conversation key.
 * @throws {Error} when `scope` is outside {@link SessionScope}.
 */
export function conversationKey(scope, msg) {
    switch (scope) {
        case 'chat':
            return msg.chatId;
        case 'chat-thread':
            // Only a topic group splits into threads; an ordinary group carries none,
            // and there the whole chat is the finest facet available.
            return msg.threadId === undefined
                ? msg.chatId
                : `${msg.chatId}${FACET_SEPARATOR}${msg.threadId}`;
        case 'chat-sender':
            return `${msg.chatId}${FACET_SEPARATOR}${msg.senderId}`;
        default: {
            const unhandled = scope;
            throw new Error(`dsh-lark-bridge: unknown session scope ${String(unhandled)}`);
        }
    }
}
/**
 * Brand a conversation key as the session id that owns it. Concatenation only,
 * so the mapping is injective by construction: two conversations can never
 * share one session, and one conversation resolves to the same durable session
 * on every boot.
 * @param key - a conversation key from {@link conversationKey}.
 * @returns the session id to look up, resume, or create.
 */
export function sessionIdFor(key) {
    return `${SESSION_PREFIX}${key}`;
}
/**
 * Get, resume, or create the agent bound to one conversation key, deduplicated
 * per key so a burst of messages cannot race two sessions into existence.
 * Bindings live until {@link ConversationSessions.close}, which disposes every
 * agent this store owns.
 */
export class ConversationSessions {
    scope;
    ladder;
    /** Resolved sessions by conversation key. */
    opened = new Map();
    /** Conversation key per live session id, in binding order. */
    keys = new Map();
    /** Acquisitions still walking the ladder, joined by concurrent messages. */
    opening = new Map();
    closed = false;
    /**
     * @param scope - the conversation facet every session is keyed by.
     * @param ladder - the host operations to walk.
     */
    constructor(scope, ladder) {
        this.scope = scope;
        this.ladder = ladder;
    }
    /** Session ids currently bound, in insertion order. */
    get sessionIds() {
        return [...this.keys.keys()];
    }
    /**
     * The conversation key a live session id serves.
     * @param sessionId - a session id, as carried by a host session event.
     * @returns the key, or undefined when this store does not drive the session.
     */
    keyOf(sessionId) {
        return this.keys.get(sessionId);
    }
    /**
     * Resolve the agent for one inbound message.
     * @param msg - normalized inbound chat message.
     * @returns the bound session, the same object for every later message of its key.
     * @throws {Error} when this store is closed, or when no ladder rung yielded an agent.
     */
    async acquire(msg) {
        if (this.closed)
            throw new Error('dsh-lark-bridge: sessions are closed');
        const key = conversationKey(this.scope, msg);
        const bound = this.opened.get(key);
        if (bound !== undefined)
            return bound;
        let opening = this.opening.get(key);
        if (opening === undefined) {
            opening = this.bind(key);
            this.opening.set(key, opening);
            // A failed acquisition clears the slot so the next message retries.
            opening.catch(() => { this.opening.delete(key); });
        }
        return opening;
    }
    /**
     * Stop accepting new work and dispose every owned agent. The bindings are
     * dropped before the first await, so a second call disposes nothing twice.
     * @returns once every owned disposal has settled.
     * @throws {AggregateError} carrying every disposal rejection.
     */
    async close() {
        this.closed = true;
        const owned = [...this.opened.values()].filter(session => session.owned);
        this.opened.clear();
        this.keys.clear();
        this.opening.clear();
        const settled = await Promise.allSettled(owned.map(session => session.handle.dispose()));
        const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length > 0)
            throw new AggregateError(failures, 'dsh-lark-bridge: session disposal failed');
    }
    /**
     * Walk the ladder for one key and publish the result under it.
     * @param key - the conversation key being bound.
     * @returns the bound session.
     * @throws {Error} when the ladder yielded nothing, or when the store closed
     * mid-walk — the disposal sweep has already run, so the agent it produced is
     * taken down here instead of outliving its owner.
     */
    async bind(key) {
        const opened = await this.reach(key);
        this.opening.delete(key);
        if (this.closed) {
            if (opened.owned) {
                await opened.handle.dispose().catch((error) => {
                    this.ladder.report(`dsh-lark-bridge: disposing the late session for ${key} failed: ${failureDetail(error)}`);
                });
            }
            throw new Error(`dsh-lark-bridge: sessions closed while opening ${key}`);
        }
        this.opened.set(key, opened);
        this.keys.set(opened.handle.agent.session.id, key);
        return opened;
    }
    /**
     * Reach the agent for one key: an already live one, else the stored session,
     * else a fresh one.
     * @param key - the conversation key.
     * @returns the first rung that yielded an agent, with its ownership.
     * @throws when creation — the last rung — also fails.
     */
    async reach(key) {
        const sessionId = sessionIdFor(key);
        const live = this.ladder.lookup(sessionId);
        // Whoever created a live agent still owns taking it down.
        if (live !== undefined)
            return { handle: live, owned: false };
        try {
            return { handle: await this.ladder.resume(sessionId), owned: true };
        }
        catch (error) {
            // The registry offers no existence probe, so a rejection is the only
            // signal that this conversation was never served here — and an unreadable
            // log looks exactly the same. Reporting it keeps a corrupt session log
            // from passing silently as first contact.
            this.ladder.report(`dsh-lark-bridge: resuming session for ${key} failed, starting a new one: ${failureDetail(error)}`);
        }
        return { handle: await this.ladder.create(sessionId), owned: true };
    }
}
//# sourceMappingURL=session.js.map