/**
 * Durable, scope-aware conversation sessions. One conversation facet — the
 * whole chat, one topic thread, or one sender inside a chat — owns exactly one
 * agent session whose id is derived from that facet alone, so a restarted
 * process reaches the conversation's stored session instead of starting it over
 * and a topic group no longer funnels every thread into one agent.
 * @module dsh-lark-bridge/session
 */
import { appendFileSync } from 'node:fs';
import { rotatedSessionId } from "./session-rotation.js";
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
 * Error names the host's session-persistence seam gives a stored session that
 * is THERE but cannot be opened. Matched by name, never by import: this
 * package builds without the host's persistence packages (the same reason
 * `host.ts` keeps structural copies), so `instanceof` is unavailable — while
 * `name` is a string literal each host class sets in its constructor, which
 * survives bundling and realm boundaries alike.
 */
const CORRUPT_LOG_NAME = 'SessionPersistenceCorruptionError';
const UNREADABLE_FORMAT_NAME = 'SessionFormatUnsupportedError';
const SESSION_EXISTS_NAME = 'SessionAlreadyExistsError';
const SESSION_ABSENT_NAME = 'SessionPersistenceNotFoundError';
/**
 * Message fragments that name those same refusals for a rejection whose class
 * was lost on the way up. Each is phrasing only these refusals produce.
 */
const CORRUPT_LOG_PHRASES = ['stored log is corrupt', 'corrupt session log', 'failed validation:'];
const UNREADABLE_FORMAT_PHRASES = ['unknown to this harness', 'upgrade the harness', 'log format v'];
/**
 * The host refuses to LIST its sessions when one id turns up under two project
 * directories: `/switch` (or `/ws use`) points a chat at a new cwd, and the
 * session derived for that chat is then created there while the original copy
 * stays in the old cwd. Nothing about the log is damaged — the same id simply
 * exists twice — but the host's listing throws, so every boot reports it and
 * no conversation on that id can be opened.
 */
const DUPLICATE_LOG_PHRASES = ['appears in multiple project directories'];
const DUPLICATE_LOG_CLASS = 'duplicate';
/**
 * Every class name and message reachable from one rejection, outermost first.
 * The host wraps a parse failure in the error it classifies (an
 * `AggregateError` carries several), so the record that failed — and the line
 * number that names it — only exists one link down.
 * @param error - the rejection value.
 * @returns the names and messages found, in breadth-first order.
 */
function errorChain(error) {
    const names = [];
    const messages = [];
    const seen = new Set();
    const queue = [error];
    while (queue.length > 0 && seen.size < 8) {
        const current = queue.shift();
        if (current === undefined || current === null || seen.has(current))
            continue;
        seen.add(current);
        if (typeof current === 'string') {
            messages.push(current);
        }
        else if (current instanceof Error) {
            names.push(current.name);
            messages.push(current.message);
            const { cause, errors } = current;
            if (cause !== undefined && cause !== null)
                queue.push(cause);
            if (Array.isArray(errors))
                queue.push(...errors);
        }
    }
    return { names, messages };
}
/**
 * Classify one rejection that proves a stored session exists.
 * @param error - the rejection value.
 * @returns the failure class, or undefined when the rejection says nothing
 * about a stored session — a conversation never served here, a permission
 * error, a cancellation.
 */
function classifyArchive(error) {
    const { names, messages } = errorChain(error);
    const text = messages.join('\n');
    if (names.includes(CORRUPT_LOG_NAME) || CORRUPT_LOG_PHRASES.some(phrase => text.includes(phrase)))
        return 'corrupt';
    if (names.includes(UNREADABLE_FORMAT_NAME) || UNREADABLE_FORMAT_PHRASES.some(phrase => text.includes(phrase)))
        return 'format';
    if (DUPLICATE_LOG_PHRASES.some(phrase => text.includes(phrase)))
        return DUPLICATE_LOG_CLASS;
    return undefined;
}
/**
 * Whether one rejection is the host's "no stored session under this id".
 * @param error - the rejection value.
 * @returns true when nothing is stored there.
 */
function isAbsentSession(error) {
    const { names, messages } = errorChain(error);
    return names.includes(SESSION_ABSENT_NAME) || messages.some(message => message.endsWith('not found'));
}
/**
 * Whether one rejection is the host's "this id is taken".
 * @param error - the rejection value.
 * @returns true when a stored session already owns the id.
 */
function isExistingSession(error) {
    const { names, messages } = errorChain(error);
    return names.includes(SESSION_EXISTS_NAME) || messages.some(message => message.includes('already exists'));
}
/**
 * The one line a chat reads when its stored session cannot be opened: what
 * broke, where, and what this conversation does about it. The failing record
 * is read from the innermost link, which names the row; the outer links only
 * repeat the session id and a raw-log path the human cannot act on.
 * @param failure - the recognised class of refusal.
 * @param error - the rejection that named it.
 * @returns one Chinese paragraph, ready to be shown as the chat's error.
 */
function archiveNotice(failure, error) {
    const { messages } = errorChain(error);
    const line = /line (\d+)/.exec(messages.join(' '))?.[1];
    let detail = (messages.at(-1) ?? '')
        .replace(/\(raw log: [^)]*\)/g, '')
        .replace(/^session "[^"]*"[:：]?\s*/, '')
        .replace(/^corrupt session log:\s*/, '')
        .replace(/^stored (session|log)[^:]*:\s*/, '')
        .trim();
    // The line number is reported on its own, so drop the wrapper repeating it.
    if (line !== undefined)
        detail = detail.replace(new RegExp(`^.*?line ${line}[:：]\\s*`), '');
    if (detail.length > 180)
        detail = `${detail.slice(0, 179)}…`;
    if (failure === 'duplicate') {
        return '这个聊天换过工作目录，同一个会话编号在两处各存了一份，宿主不肯列出来。'
            + '已经换到一个新会话继续，旧的两份原样保留、没动过；把刚才的话再发一次就行。';
    }
    const why = failure === 'corrupt'
        ? '会话存档损坏'
        : failure === 'format'
            ? '会话存档是当前版本读不了的格式，可能由更新版本的 harness 写成'
            : '会话存档存在但打不开';
    const reason = detail === '' ? '' : `（${line === undefined ? '' : `第 ${line} 行：`}${detail}）`;
    return `${why}${reason}。旧存档原样保留、没动过；下一条消息会自动开一个新会话，请把刚才的话再发一次。`;
}
/**
 * Persist one resume rejection where an operator can still read it after the
 * chat has forgotten it. Diagnostics must never mask the original failure.
 * @param key - the conversation key whose session failed to resume.
 * @param error - the rejection value.
 */
function recordResumeFailure(key, error) {
    try {
        appendFileSync('/tmp/dsh-session-crash.log', `[${new Date().toISOString()}] resume ${key}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n`);
    }
    catch { /* diagnostics must never mask the original failure */ }
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
 *
 * A conversation whose stored session exists but cannot be opened is moved to
 * a fresh session instead of being left unreachable — see {@link reach}.
 */
export class ConversationSessions {
    scope;
    ladder;
    rotation;
    onRetire;
    /** Resolved sessions by conversation key. */
    opened = new Map();
    /** Conversation key per live session id, in binding order. */
    keys = new Map();
    /** Acquisitions still walking the ladder, joined by concurrent messages. */
    opening = new Map();
    /**
     * Conversation key → the session id it moved to, for a rotation record that
     * never reached disk. This is what keeps a move a move after a failed write.
     */
    revived = new Map();
    closed = false;
    /**
     * @param scope - the conversation facet every session is keyed by.
     * @param ladder - the host operations to walk.
     */
    /** Rotations in flight, per conversation: a message landing mid-rotate
     * must wait for it, or it would bind the session being disposed. */
    rotating = new Map();
    /**
     * @param scope - the conversation facet every session is keyed by.
     * @param ladder - the host operations to walk.
     * @param rotation - where a rotated id is recorded, when the host supplies one.
     * @param onRetire - told once per session that stops serving its conversation.
     */
    constructor(scope, ladder, rotation, onRetire) {
        this.scope = scope;
        this.ladder = ladder;
        this.rotation = rotation;
        this.onRetire = onRetire;
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
     * @throws {Error} when this store is closed, or when no ladder rung yielded an
     * agent — including a stored session this build cannot open, whose message is
     * the reason the chat should read (the conversation has then already been
     * moved off that session, so the next message works).
     */
    async acquire(msg) {
        if (this.closed)
            throw new Error('dsh-lark-bridge: sessions are closed');
        const key = conversationKey(this.scope, msg);
        // A rotation in flight owns this conversation: a message that lands while
        // /new is still creating its session must wait for the rebind, or it
        // would start a turn on the session the rotation is about to dispose.
        const inFlight = this.rotating.get(key);
        if (inFlight !== undefined)
            await inFlight.catch(() => { });
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
     * Move one conversation to a fresh session: the engine behind `/new`. The
     * previous session stays stored — it remains visible to `/sessions` and can
     * be looked up by id — while this store rebinds the key to a newly created
     * session and, when it owns the old agent, takes that agent down.
     * @param msg - the message that asked for the rotation.
     * @returns the fresh session, already bound to the conversation key.
     * @throws when this store is closed, or when creating the fresh session
     * fails — the previous binding then survives untouched.
     */
    async rotate(msg) {
        if (this.closed)
            throw new Error('dsh-lark-bridge: sessions are closed');
        const key = conversationKey(this.scope, msg);
        // One rotation at a time per conversation: two overlapping /new calls
        // used to leave the store and the process disagreeing about the current
        // session (and leak the second agent).
        if (this.rotating.has(key))
            throw new Error('上一次开新会话还在进行中，稍等片刻再发 /new。');
        const task = this.performRotate(key);
        this.rotating.set(key, task);
        try {
            return await task;
        }
        finally {
            this.rotating.delete(key);
        }
    }
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
    async attach(msg, targetSessionId) {
        if (this.closed)
            throw new Error('dsh-lark-bridge: sessions are closed');
        const key = conversationKey(this.scope, msg);
        const home = sessionIdFor(key);
        if (targetSessionId !== home && !targetSessionId.startsWith(`${home}${FACET_SEPARATOR}`)) {
            throw new Error('目标会话不属于本对话，拒绝切换。');
        }
        // 与 /new 共用同一把锁：两个切换并发会把 store 和进程对「当前是哪个会话」
        // 的判断撕开，还会漏掉一个没人处置的 agent。
        if (this.rotating.has(key))
            throw new Error('上一次会话切换还在进行中，稍等片刻再发 /resume。');
        const task = this.performAttach(key, targetSessionId);
        this.rotating.set(key, task);
        try {
            return await task;
        }
        finally {
            this.rotating.delete(key);
        }
    }
    /**
     * The body of {@link rotate}, serialized per conversation by its caller.
     * @param key - the conversation key to rotate.
     * @returns the fresh session plus whether the mapping reached disk.
     */
    async performRotate(key) {
        if (this.closed)
            throw new Error('dsh-lark-bridge: sessions are closed');
        const newId = rotatedSessionId(sessionIdFor(key));
        // Create before rebinding: a failed create must leave the conversation on
        // its previous session rather than stranding it without one.
        const handle = await this.ladder.create(newId);
        if (this.closed) {
            // close() swept before this create settled; the fresh agent would be a
            // zombie nobody owns. Take it down and refuse the rotation.
            await handle.dispose().catch((error) => {
                this.ladder.report(`dsh-lark-bridge: disposing the late rotation for ${key} failed: ${failureDetail(error)}`);
            });
            throw new Error(`dsh-lark-bridge: sessions closed while rotating ${key}`);
        }
        // A failed record still rotates this process; the caller decides how to
        // warn the human about the restart-time fallback.
        const persisted = this.rebind(key, newId);
        const previous = this.opened.get(key);
        if (previous !== undefined) {
            await this.retire(key, previous, 'pre-rotation session');
        }
        const opened = { handle, owned: true };
        this.opened.set(key, opened);
        this.keys.set(handle.agent.session.id, key);
        return { ...opened, persisted };
    }
    /**
     * The body of {@link attach}, serialized per conversation by its caller.
     * @param key - the conversation key to move.
     * @param targetSessionId - the stored session to open and bind.
     * @returns the bound session plus whether the mapping reached disk.
     */
    async performAttach(key, targetSessionId) {
        const previous = this.opened.get(key);
        // 已经在这个会话上：不重建 agent，也不重写映射——`/resume` 点到自己时
        // 应当是一句「就是它」，而不是一次多余的销毁与重开。
        if (previous !== undefined && previous.handle.agent.session.id === targetSessionId) {
            return { ...previous, persisted: true };
        }
        // 目标可能已经被别的 owner 拉起来了（同一个 id 同时只能有一个 agent）。
        // 那种情况不归本 store 处置，借用即可。
        const live = this.ladder.lookup(targetSessionId);
        const handle = live ?? await this.ladder.resume(targetSessionId);
        const owned = live === undefined;
        if (this.closed) {
            // close() 在 resume 落地前就扫过了；刚拉起来的 agent 没人认领，就地拆掉。
            if (owned) {
                await handle.dispose().catch((error) => {
                    this.ladder.report(`dsh-lark-bridge: disposing the late resume for ${key} failed: ${failureDetail(error)}`);
                });
            }
            throw new Error(`dsh-lark-bridge: sessions closed while attaching ${key}`);
        }
        // 先记映射再换内存：映射写失败仍要完成这次切换（调用方负责告诉人重启后会退回去），
        // 但反过来——内存换了、映射没写——会让本进程和下一条消息看到不同的会话。
        const persisted = this.rebind(key, targetSessionId);
        if (previous !== undefined) {
            await this.retire(key, previous, 'pre-resume session');
        }
        const opened = { handle, owned };
        this.opened.set(key, opened);
        this.keys.set(handle.agent.session.id, key);
        return { ...opened, persisted };
    }
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
    async retire(key, session, cause) {
        const sessionId = session.handle.agent.session.id;
        this.opened.delete(key);
        this.keys.delete(sessionId);
        // Before the dispose: the hook is bookkeeping, and a channel that throws
        // must not leave an owned agent running with nothing routing to it.
        try {
            this.onRetire?.(sessionId, key);
        }
        catch (error) {
            this.ladder.report(`dsh-lark-bridge: retire hook for ${sessionId} failed: ${failureDetail(error)}`);
        }
        if (!session.owned)
            return undefined;
        try {
            await session.handle.dispose();
            return undefined;
        }
        catch (error) {
            this.ladder.report(`dsh-lark-bridge: disposing the ${cause} for ${key} failed: ${failureDetail(error)}`);
            return error;
        }
    }
    /**
     * Stop accepting new work and dispose every owned agent. The bindings are
     * dropped before the first await, so a second call disposes nothing twice.
     * @returns once every owned disposal has settled.
     * @throws {AggregateError} carrying every disposal rejection.
     */
    async close() {
        this.closed = true;
        const bound = [...this.opened.entries()];
        this.opened.clear();
        this.keys.clear();
        this.opening.clear();
        const failures = (await Promise.all(bound.map(async ([key, session]) => this.retire(key, session, 'session')))).filter(failure => failure !== undefined);
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
        // A rotation may have rebound this key while the walk was in flight; its
        // binding is newer and wins — take this late one down instead of
        // clobbering it (the clobber used to strand the rotation: stale routing
        // plus a leaked agent).
        const current = this.opened.get(key);
        if (current !== undefined) {
            if (opened.owned) {
                await opened.handle.dispose().catch((error) => {
                    this.ladder.report(`dsh-lark-bridge: disposing the superseded session for ${key} failed: ${failureDetail(error)}`);
                });
            }
            return current;
        }
        this.opened.set(key, opened);
        this.keys.set(opened.handle.agent.session.id, key);
        return opened;
    }
    /**
     * Point one conversation at a different session id: in memory always, on
     * disk when the rotation store accepts it. The memory copy is what makes a
     * failed record a restart-time risk instead of an in-process one — the very
     * next message must not look at the id this process just left.
     * @param key - the conversation key.
     * @param sessionId - the id the conversation now lives on.
     * @returns whether the mapping reached disk.
     */
    rebind(key, sessionId) {
        this.revived.set(key, sessionId);
        return this.rotation?.record(key, sessionId) ?? true;
    }
    /**
     * The session id one conversation currently lives on.
     * @param key - the conversation key.
     * @returns the moved id, else the original derived home.
     */
    currentSessionId(key) {
        // Memory first: it is never older than the file, and a fresh process starts
        // with it empty, so the persisted store still wins across restarts.
        return this.revived.get(key) ?? this.rotation?.current(key) ?? sessionIdFor(key);
    }
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
    quarantine(key, sessionId, failure, error) {
        const fresh = rotatedSessionId(sessionIdFor(key));
        const persisted = this.rebind(key, fresh);
        this.ladder.report(`dsh-lark-bridge: session ${sessionId} cannot be opened (${failure}); conversation ${key} moves to ${fresh}${persisted ? '' : ' — rotation not recorded, so a restart falls back to the unreadable id'}: ${failureDetail(error)}`);
        return new Error(archiveNotice(failure, error));
    }
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
    async reach(key) {
        // A conversation may have been rotated by `/new` or moved off a damaged
        // archive: the persisted store is authoritative across restarts, the
        // derived id is the original home.
        const sessionId = this.currentSessionId(key);
        const live = this.ladder.lookup(sessionId);
        // Whoever created a live agent still owns taking it down.
        if (live !== undefined)
            return { handle: live, owned: false };
        let resumeError;
        try {
            return { handle: await this.ladder.resume(sessionId), owned: true };
        }
        catch (error) {
            resumeError = error;
            // A resume failure is normally a benign "never served here", but when the
            // follow-up create fails too, the chat shows only its message — so
            // persist this side's stack for the operator before moving on.
            recordResumeFailure(key, error);
            const failure = classifyArchive(error);
            if (failure !== undefined)
                throw this.quarantine(key, sessionId, failure, error);
            this.ladder.report(`dsh-lark-bridge: resuming session for ${key} failed, starting a new one: ${failureDetail(error)}`);
        }
        try {
            return { handle: await this.ladder.create(sessionId), owned: true };
        }
        catch (error) {
            // A duplicated id is neither `already exists` (that answer means the
            // archive is right here and resumable) nor a failure worth surfacing:
            // the id is taken in ANOTHER project directory, so resuming it here
            // cannot work and every later message would replay the same refusal.
            // Move the conversation off the id exactly as a damaged archive would —
            // the stray copy stays untouched and addressable.
            if (classifyArchive(error) === DUPLICATE_LOG_CLASS) {
                throw this.quarantine(key, sessionId, DUPLICATE_LOG_CLASS, error);
            }
            // Any other create failure is the truth as it stands.
            if (!isExistingSession(error))
                throw error;
            // `already exists` is the one answer that proves an archive is there. If
            // resume had said the session was absent, it appeared between the two
            // rungs — another owner created it — so take that agent instead of
            // moving a healthy conversation off its session.
            if (isAbsentSession(resumeError)) {
                const retried = await this.ladder.resume(sessionId).then(handle => ({ handle }), (retryError) => ({ retryError }));
                if ('handle' in retried)
                    return { handle: retried.handle, owned: true };
                resumeError = retried.retryError;
                recordResumeFailure(key, resumeError);
            }
            // Either it appeared and is still unreadable, or nothing else can be
            // learnt from this id: report what the resume rejection actually said.
            throw this.quarantine(key, sessionId, classifyArchive(resumeError) ?? 'unreadable', resumeError);
        }
    }
}
//# sourceMappingURL=session.js.map