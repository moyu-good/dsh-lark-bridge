/**
 * 会话尾部预览：`/resume` 列表里「上次做到哪」那一行。
 *
 * 切回一个历史会话时，飞书聊天窗口看不到那段对话——旧会话的消息从没在这个
 * 群里出现过。只回一句「已切到会话 xxx」等于把人扔进黑盒：他不知道这是哪个
 * 会话、上次停在哪、还有什么事没完。所以预览要给出**最后一句你说的话**和
 * **最后一句我回的话**，这两句比任何摘要都好认。
 *
 * 数据全部来自会话日志本身，不触发模型推理：切会话是低频操作，但让它烧一次
 * token 既慢又会往会话里写一条「总结」，污染真实历史。
 *
 * 日志格式是「一个 zstd 帧压多行 JSONL、帧与帧首尾相接」。要读尾部就得先扫
 * 帧边界（只解析帧头与块头，不解压），再从后往前解压到找齐两条消息为止。
 * 实测 9.5 MB 的会话扫帧 2 ms、提取 1 ms。
 *
 * @module dsh-lark-bridge/session-preview
 */
/** 一次会话尾部预览。 */
export interface SessionPreview {
    /** 最后一句真人说的话，已剥掉发送者信封并压平。 */
    readonly lastUser?: string;
    /** 最后一句带正文的回复，已压平。 */
    readonly lastAssistant?: string;
    /** 最后一个事件的时间（epoch 毫秒）。 */
    readonly lastActivity?: number;
}
/** {@link readSessionPreview} 的可调项。 */
export interface PreviewOptions {
    /** 最多从尾部往前解压多少帧，默认 400。 */
    readonly maxFrames?: number;
    /** 每条预览最多保留多少字符，默认 120。 */
    readonly maxChars?: number;
}
/** 一个 zstd 帧在缓冲区里的 `[start, end)` 偏移。 */
interface FrameSpan {
    readonly start: number;
    readonly end: number;
}
/**
 * 扫出缓冲区里每个 zstd 帧的边界。
 *
 * 只读帧头与块头，跳过块数据，所以几 MB 的文件是毫秒级。首帧从偏移 0 开始
 * 之后帧首尾相接，但压缩数据里可能偶然出现魔数，所以对不上魔数时逐字节
 * 前移重新对齐，而不是直接放弃。
 * @param buffer - 整个会话日志文件。
 * @returns 帧边界，按出现顺序。
 */
export declare function scanFrames(buffer: Buffer): FrameSpan[];
/**
 * 会话 id 在磁盘上的目录名：冒号被写成 `~003A`。
 *
 * 目录名是文件系统事实，不跟着界面上的脱敏走；用 id 直接推导比读目录内容快，
 * 也不会因为某个会话的 header 读不出来就找不到文件。
 * @param sessionId - 会话 id。
 * @returns 目录名。
 */
export declare function sessionDirName(sessionId: string): string;
/**
 * 找到某个会话的日志文件。
 *
 * 会话按「工作目录编码 / 会话 id 编码」两层存放，工作目录那一层无法从 id
 * 推导（同一个 id 可能出现在换过目录的对话里），所以逐层探一遍。目录数在
 * 百级，每次 stat 一次，几毫秒。
 * @param sessionId - 会话 id。
 * @param home - harness home 覆盖，测试用。
 * @returns 日志文件的绝对路径，找不到时为 undefined。
 */
export declare function findSessionFile(sessionId: string, home?: string): Promise<string | undefined>;
/**
 * 剥掉消息开头的发送者信封。
 *
 * 桥写进会话的用户消息带前缀，两种形状：`发送者: [时间 · …]` 独占第一行，
 * 正文从第二行开始；或者 `发送者: 正文` 挤在一行。两种都要剥，否则预览
 * 显示的是 `{{PERSON_…}}: [2026-11-04 15:07:36 …]` 这种没人想看的东西。
 * 正文自己以「注意: …」开头的不能被误剥，所以冒号前含中文就不动。
 * @param text - 原始消息文本。
 * @returns 正文。
 */
export declare function stripEnvelope(text: string): string;
/**
 * 把一段消息压成一行预览。
 * @param text - 原始文本。
 * @param maxChars - 最多保留多少字符。
 * @returns 压平并截断后的文本。
 */
export declare function condense(text: string, maxChars: number): string;
/**
 * 读一个会话的尾部预览。
 *
 * 从最后一帧往前解压，直到拿齐「最后一句你说的话」和「最后一句我回的话」。
 * 读不到（文件不在、超限、损坏、格式不认识）都返回 undefined —— 预览是
 * 锦上添花，不能让它把 `/resume` 弄挂。
 * @param file - 会话日志文件路径。
 * @param options - 帧数与字符数上限。
 * @returns 预览，或 undefined。
 */
export declare function readSessionPreview(file: string, options?: PreviewOptions): Promise<SessionPreview | undefined>;
/**
 * 一次性拿多个会话的预览，逐个读、按顺序返回。
 *
 * 不并发读是为了让内存峰值等于「最大单个会话」而不是「所有会话之和」——
 * 列表最多也就十来个，串行的几十毫秒换一个不会爆的内存曲线是划算的。
 * @param sessionIds - 会话 id 列表。
 * @param options - 透传给 {@link readSessionPreview}。
 * @returns 与入参等长的数组，读不到的为 undefined。
 */
export declare function readPreviews(sessionIds: readonly string[], options?: PreviewOptions & {
    readonly home?: string;
}): Promise<readonly (SessionPreview | undefined)[]>;
/**
 * 默认的 harness home，与 `rotationHome` 同源但独立导出，方便调用方只依赖本模块。
 * @returns 目录路径。
 */
export declare function previewHome(): string;
export {};
//# sourceMappingURL=session-preview.d.ts.map