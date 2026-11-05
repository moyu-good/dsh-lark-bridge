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
import { type RotationStore } from './session-rotation.ts';
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
/**
 * Told once, when a conversation stops running on a session.
 *
 * The channel keys per-session state by session id — renderers, the
 * token-pressure bookkeeping, the last assistant id — and had no way to learn
 * that a session had been retired. So `/new` left the previous session's
 * binding in place and the ten-minute pressure sweep kept pricing it: the
 * previous conversation's token total was posted into the brand-new chat as if
 * the fresh session were already that heavy. Retirement is a fact this store
 * owns, so it says so rather than letting every consumer infer it.
 */
export type SessionRetireHook = (sessionId: string, key: string) => void;
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
 *
 * A conversation whose stored session exists but cannot be opened is moved to
 * a fresh session instead of being left unreachable — see {@link reach}.
 */
export declare class ConversationSessions {
    private readonly scope;
    private readonly ladder;
    private readonly rotation?;
    private readonly onRetire?;
    /** Resolved sessions by conversation key. */
    private readonly opened;
    /** Conversation key per live session id, in binding order. */
    private readonly keys;
    /** Acquisitions still walking the ladder, joined by concurrent messages. */
    private readonly opening;
    /**
     * Conversation key → the session id it moved to, for a rotation record that
     * never reached disk. This is what keeps a move a move after a failed write.
     */
    private readonly revived;
    private closed;
    /**
     * @param scope - the conversation facet every session is keyed by.
     * @param ladder - the host operations to walk.
     */
    /** Rotations in flight, per conversation: a message landing mid-rotate
     * must wait for it, or it would bind the session being disposed. */
    private readonly rotating;
    /**
     * @param scope - the conversation facet every session is keyed by.
     * @param ladder - the host operations to walk.
     * @param rotation - where a rotated id is recorded, when the host supplies one.
     * @param onRetire - told once per session that stops serving its conversation.
     */
    constructor(scope: SessionScope, ladder: SessionLadder, rotation?: RotationStore | undefined, onRetire?: SessionRetireHook | undefined);
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
     * @throws {Error} when this store is closed, or when no ladder rung yielded an
     * agent — including a stored session this build cannot open, whose message is
     * the reason the chat should read (the conversation has then already been
     * moved off that session, so the next message works).
     */
    acquire(msg: NormalizedMessage): Promise<OpenedSession>;
    /**
     * Move one conversation to a fresh session: the engine behind `/new`. The
     * previous session stays stored — it remains visible to `/sessions` and can
     * be looked up by id — while this store rebinds the key to a newly created
     * session and, when it owns the old agent, takes that agent down.
     * @param msg - the message that asked for the rotation.
     * @returns the fresh session, already bound to the conversation key.
     * @throws when this store is closed, or when creating the fresh session
     * fails — the previous binding then survives untouched.
     */
    rotate(msg: NormalizedMessage): Promise<OpenedSession & {
        readonly persisted: boolean;
    }>;
    /**
     * 把一条对话切到本聊天已有的某个历史会话：`/resume` 的执行体。
     *
     * 和 {@link rotate} 共用同一套 rebind 与旧 agent 处置，区别只在会话从哪来：
     * `/new` 新建一个，这里把磁盘上已经存在的那个重新打开。所以切换之后
     * `/sessions`、`/session` 以及重启后的恢复看到的都是同一份映射，不会出现
     * 「切过去了但重启又跳回来」。
     *
     * 目标必须属于本对话：会话 id 是 `feishu-<key>`，分叉再挂一个 `:r<stamp><rand>`。
     * 前缀对不上就说明那是别的聊天（或别的线程）的会话，放行等于让一个群读到
     * 另一个群的对话，所以这里直接拒绝。
     *
     * @param msg - 要求切换的那条消息（决定 conversation key）。
     * @param targetSessionId - 要切过去的历史会话 id。
     * @returns 切过去之后的会话，以及这次切换有没有写进轮换记录。
     * @throws 目标不属于本对话、会话打不开、或本 store 已关闭时。
     */
    attach(msg: NormalizedMessage, targetSessionId: string): Promise<OpenedSession & {
        readonly persisted: boolean;
    }>;
    /**
     * The body of {@link rotate}, serialized per conversation by its caller.
     * @param key - the conversation key to rotate.
     * @returns the fresh session plus whether the mapping reached disk.
     */
    private performRotate;
    /**
     * The body of {@link attach}, serialized per conversation by its caller.
     * @param key - the conversation key to move.
     * @param targetSessionId - the stored session to open and bind.
     * @returns the bound session plus whether the mapping reached disk.
     */
    private performAttach;
    /**
     * Drop one conversation's binding and dispose the agent this store owns.
     *
     * Every way a session leaves the store goes through here — `/new`,
     * `/resume`, and the close sweep — so retirement is reported once per
     * session, in one shape, and no caller can drop a binding while forgetting
     * the dispose (or the notice) that has to follow it.
     * @param key - the conversation key the session served.
     * @param session - the binding being dropped.
     * @param cause - what retired it, for the report when disposal fails.
     * @returns the disposal rejection, if any; the caller decides how loud it is.
     */
    private retire;
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
     * Point one conversation at a different session id: in memory always, on
     * disk when the rotation store accepts it. The memory copy is what makes a
     * failed record a restart-time risk instead of an in-process one — the very
     * next message must not look at the id this process just left.
     * @param key - the conversation key.
     * @param sessionId - the id the conversation now lives on.
     * @returns whether the mapping reached disk.
     */
    private rebind;
    /**
     * The session id one conversation currently lives on.
     * @param key - the conversation key.
     * @returns the moved id, else the original derived home.
     */
    private currentSessionId;
    /**
     * Move one conversation off a stored session this build cannot open, and say
     * what actually broke. The stored log is never renamed or edited: it stays
     * addressable by id (`/sessions`), so the escape costs the conversation its
     * old session, not its history on disk.
     * @param key - the conversation key whose archive is unreadable.
     * @param sessionId - the unreadable session id.
     * @param failure - the recognised class of refusal.
     * @param error - the rejection that named it.
     * @returns the error to raise at the caller, carrying the chat-facing notice.
     */
    private quarantine;
    /**
     * Reach the agent for one key: an already live one, else the stored session,
     * else a fresh one.
     *
     * A resume rejection means one of two very different things, and the
     * registry offers no existence probe to tell them apart: the conversation
     * was never served here (create on that id is right), or it was served and
     * its stored log cannot be read (create on that id can only answer
     * `already exists`, which buries the damage — that is the deadlock issue #6
     * reports, where every later message, `/new` included, replays the
     * collision). The two are told apart by what the rejection IS, and only the
     * second class moves the conversation off its archive.
     * @param key - the conversation key.
     * @returns the first rung that yielded an agent, with its ownership.
     * @throws when a stored session cannot be opened (the error's message is the
     * chat-facing reason) or when creation — the last rung — fails.
     */
    private reach;
}
//# sourceMappingURL=session.d.ts.map