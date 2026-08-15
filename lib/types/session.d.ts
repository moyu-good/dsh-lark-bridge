/**
 * Durable, scope-aware conversation sessions. One conversation facet — the
 * whole chat, one topic thread, or one sender inside a chat — owns exactly one
 * agent session whose id is derived from that facet alone, so a restarted
 * process reaches the conversation's stored session instead of starting it over
 * and a topic group no longer funnels every thread into one agent.
 * @module dsh-lark-bridge/session
 */
import type { NormalizedMessage } from '@larksuite/channel';
import type { HostAgentHandle } from './host.ts';
/** Which conversation facet owns one agent session. */
export type SessionScope = 'chat' | 'chat-thread' | 'chat-sender';
/**
 * Derive the stable conversation key one session owns. Pure: the same
 * conversation facet yields the same key in every process.
 * @param scope - the facet a session is bound to.
 * @param msg - normalized inbound chat message.
 * @returns the conversation key.
 * @throws {Error} when `scope` is outside {@link SessionScope}.
 */
export declare function conversationKey(scope: SessionScope, msg: NormalizedMessage): string;
/**
 * Brand a conversation key as the session id that owns it. Concatenation only,
 * so the mapping is injective by construction: two conversations can never
 * share one session, and one conversation resolves to the same durable session
 * on every boot.
 * @param key - a conversation key from {@link conversationKey}.
 * @returns the session id to look up, resume, or create.
 */
export declare function sessionIdFor(key: string): string;
/** One agent this channel drives, and whether disposing it is this channel's job. */
export interface OpenedSession {
    readonly handle: HostAgentHandle;
    /** False when the agent was already live under another owner. */
    readonly owned: boolean;
}
/**
 * Host operations the ladder needs, as plain functions: the host `agents`
 * registry satisfies them through the bridge, while tests substitute an
 * in-memory object and need no Cordis mount.
 */
export interface SessionLadder {
    /**
     * Return the live agent for this id, if the host already has one.
     * @param sessionId - the branded session id.
     * @returns the live handle, or undefined when nothing runs on that id.
     */
    lookup(sessionId: string): HostAgentHandle | undefined;
    /**
     * Load a persisted session as a live agent.
     * @param sessionId - the branded session id.
     * @returns the resumed handle.
     * @throws when no session is stored under the id, or its log cannot be read.
     */
    resume(sessionId: string): Promise<HostAgentHandle>;
    /**
     * Create a fresh agent on this id.
     * @param sessionId - the branded session id.
     * @returns the created handle.
     * @throws when the agent cannot be composed.
     */
    create(sessionId: string): Promise<HostAgentHandle>;
    /**
     * Report a failure that is handled rather than propagated. The line is
     * operator-facing and self-describing.
     * @param line - the complete report line.
     */
    report(line: string): void;
}
/**
 * Get, resume, or create the agent bound to one conversation key, deduplicated
 * per key so a burst of messages cannot race two sessions into existence.
 * Bindings live until {@link ConversationSessions.close}, which disposes every
 * agent this store owns.
 */
export declare class ConversationSessions {
    private readonly scope;
    private readonly ladder;
    /** Resolved sessions by conversation key. */
    private readonly opened;
    /** Conversation key per live session id, in binding order. */
    private readonly keys;
    /** Acquisitions still walking the ladder, joined by concurrent messages. */
    private readonly opening;
    private closed;
    /**
     * @param scope - the conversation facet every session is keyed by.
     * @param ladder - the host operations to walk.
     */
    constructor(scope: SessionScope, ladder: SessionLadder);
    /** Session ids currently bound, in insertion order. */
    get sessionIds(): string[];
    /**
     * The conversation key a live session id serves.
     * @param sessionId - a session id, as carried by a host session event.
     * @returns the key, or undefined when this store does not drive the session.
     */
    keyOf(sessionId: string): string | undefined;
    /**
     * Resolve the agent for one inbound message.
     * @param msg - normalized inbound chat message.
     * @returns the bound session, the same object for every later message of its key.
     * @throws {Error} when this store is closed, or when no ladder rung yielded an agent.
     */
    acquire(msg: NormalizedMessage): Promise<OpenedSession>;
    /**
     * Stop accepting new work and dispose every owned agent. The bindings are
     * dropped before the first await, so a second call disposes nothing twice.
     * @returns once every owned disposal has settled.
     * @throws {AggregateError} carrying every disposal rejection.
     */
    close(): Promise<void>;
    /**
     * Walk the ladder for one key and publish the result under it.
     * @param key - the conversation key being bound.
     * @returns the bound session.
     * @throws {Error} when the ladder yielded nothing, or when the store closed
     * mid-walk — the disposal sweep has already run, so the agent it produced is
     * taken down here instead of outliving its owner.
     */
    private bind;
    /**
     * Reach the agent for one key: an already live one, else the stored session,
     * else a fresh one.
     * @param key - the conversation key.
     * @returns the first rung that yielded an agent, with its ownership.
     * @throws when creation — the last rung — also fails.
     */
    private reach;
}
//# sourceMappingURL=session.d.ts.map