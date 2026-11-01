/**
 * Wall-clock rendering shared by everything that shows a time.
 *
 * Two very different readers need the same instant rendered the same way: the
 * human reading a card or a thinking process, and the model reading its own
 * input. Keeping one formatter keeps "22:31:07" from meaning two things in one
 * conversation — and keeps the two call sites from drifting apart the way
 * copies do.
 *
 * This module deliberately depends on nothing in the plugin: `cot.ts` and
 * `bridge.ts` both use it, and `bridge.ts` already imports `cot.ts`, so a
 * formatter living in either would close an import cycle.
 * @module dsh-lark-bridge/clock
 */
/**
 * Render one instant as the chat's local wall clock: `2026-11-01 01:42:33 (+08:00)`.
 *
 * 飞书给的 `createTime` 是毫秒时间戳，跟着服务器走；人说的是本地时间。一律
 * 按本机时区转，并在行里带上偏移（`+08:00`），跨时区看日志时也不会误读。
 *
 * 精确到秒是有意为之：同一分钟里会有好几条消息（一次重启、一次追问），
 * 只到分钟就分不出先后，而"先说了什么"往往正是要判断的东西。
 * @param at - epoch milliseconds, or undefined when the transport supplied none.
 * @returns the stamp, or undefined when there is nothing to render.
 */
export declare function messageTimeStamp(at: number | undefined): string | undefined;
/**
 * Render one instant as a bare clock time: `22:31:07`.
 *
 * What belongs in a thinking-process title. The date and the offset are the
 * same for every line of one run, so repeating them on each tool call would
 * be noise; the second is the whole point, because it is what lets a reader
 * line a step up against the message that asked for it.
 * @param at - epoch milliseconds.
 * @returns the clock time, or undefined when there is nothing to render.
 */
export declare function clockTime(at: number | undefined): string | undefined;
/**
 * Render a duration the way a reader scans it: `850ms`, `18.2s`, `4 分 12 秒`.
 *
 * A tool call that took eight milliseconds and one that took eight minutes mean
 * very different things, and a single unit hides that: seconds would round the
 * first to `0s`. Sub-second work therefore keeps its milliseconds, and long work
 * keeps its minutes — the digit count is what makes the difference visible.
 * @param ms - elapsed milliseconds.
 * @returns the duration, or '' when it is not a usable number.
 */
export declare function duration(ms: number | undefined): string;
/**
 * Render how long ago an instant was, in the words a person would use.
 *
 * The point of the number is not precision but scale: "8 小时前" and "3 分钟前"
 * call for different behaviour from a model that is picking up a thread. So
 * the form goes coarse as the gap grows — a day-old gap in hours says nothing
 * a reader needs, and "几天前" says the one thing they do.
 * @param ms - the gap in milliseconds, already >= 0.
 * @returns the phrase, or '' when it is not a usable number.
 */
export declare function elapsedPhrase(ms: number | undefined): string;
//# sourceMappingURL=clock.d.ts.map