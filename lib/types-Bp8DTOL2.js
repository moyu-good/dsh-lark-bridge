import z from "@deepseek-ai/schemastery";
import os from "node:os";
import { createLarkChannel, registerApp } from "@larksuite/channel";
import { randomUUID } from "node:crypto";
import path, { join, resolve } from "node:path";
import fs, { promises, readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import fsp from "node:fs/promises";
import http from "node:http";
import qrcode from "qrcode-terminal";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region lib/types/config.js
/**
* Serializable configuration, schema, and direct-call defaults.
* @module dsh-lark-bridge/config
*/
/**
* Human-interaction tools whose answer cannot reach a chat: both ask through
* `ctx.userQuestions`, whose single provider belongs to whichever UI registered
* it first. Denied per chat agent so the model asks in the chat instead.
*/
const DEFAULT_DENY_TOOLS = [];
/** Loader-visible configuration schema and defaults. */
const Config = z.object({
	appId: z.string(),
	appSecret: z.string().role("secret"),
	domain: z.string(),
	cwd: z.string(),
	provider: z.string(),
	model: z.string(),
	preset: z.string(),
	sessionScope: z.union([
		"chat",
		"chat-thread",
		"chat-sender"
	]).default("chat"),
	locale: z.union([
		"auto",
		"zh",
		"en"
	]).default("auto"),
	output: z.union(["cot", "stream"]).default("cot"),
	showProcess: z.boolean().default(true),
	attachImages: z.boolean().default(false),
	hideProcessWhenDone: z.boolean().default(false),
	syncSlashCommands: z.boolean().default(true),
	chronicleEndpoint: z.string().default(""),
	briefingFile: z.string().default(""),
	autoSaveFiles: z.boolean().default(true),
	modelCatalog: z.array(z.string()).default([]),
	chronicleSource: z.string().default("lark-bridge"),
	onboarding: z.boolean().default(true),
	denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),
	requireMention: z.boolean().default(true),
	reactionFeedback: z.boolean().default(true),
	senderAllowlist: z.array(String),
	groupAllowlist: z.array(String),
	approvers: z.array(String),
	autoResumeGoals: z.boolean().default(false),
	restartCommand: z.string().default(""),
	approvalReminderMs: z.number().min(0).default(0),
	controlPort: z.number().min(0).default(0),
	outbound: z.object({ allowedFileDirs: z.array(String) }),
	tokenPressure: z.object({
		enabled: z.boolean(),
		intervalMs: z.number().min(6e4),
		threshold: z.number().min(1)
	})
});
/**
* Resolve the panel/help language. Explicit `zh`/`en` wins; `auto` (and
* absent) follows the platform domain — the international Lark console lives
* at `open.larksuite.com`, the domestic Feishu one at `open.feishu.cn`.
* @param config - serialized configuration.
* @returns the resolved language.
*/
function resolveLocale(config) {
	if (config.locale === "zh" || config.locale === "en") return config.locale;
	return config.domain?.includes("larksuite") === true ? "en" : "zh";
}
/**
* Resolve the same defaults for direct callers that bypass Cordis Loader.
* @param config - Serialized configuration with the required credentials.
* @returns Configuration with all schema defaults applied.
*/
function resolveConfig(config) {
	return {
		...config,
		locale: resolveLocale(config),
		sessionScope: config.sessionScope ?? "chat",
		output: config.output ?? "cot",
		showProcess: config.showProcess ?? true,
		attachImages: config.attachImages ?? false,
		hideProcessWhenDone: config.hideProcessWhenDone ?? false,
		syncSlashCommands: config.syncSlashCommands ?? true,
		chronicleEndpoint: config.chronicleEndpoint ?? "",
		controlPort: config.controlPort ?? 0,
		chronicleSource: config.chronicleSource ?? "lark-bridge",
		briefingFile: config.briefingFile ?? "",
		autoSaveFiles: config.autoSaveFiles ?? true,
		modelCatalog: config.modelCatalog ?? [],
		onboarding: config.onboarding ?? true,
		denyTools: config.denyTools ?? [...DEFAULT_DENY_TOOLS],
		requireMention: config.requireMention ?? true,
		reactionFeedback: config.reactionFeedback ?? true,
		senderAllowlist: config.senderAllowlist ?? [],
		groupAllowlist: config.groupAllowlist ?? [],
		approvers: config.approvers ?? [],
		autoResumeGoals: config.autoResumeGoals ?? false,
		restartCommand: config.restartCommand ?? "",
		approvalReminderMs: config.approvalReminderMs ?? 0,
		outbound: config.outbound,
		tokenPressure: {
			enabled: config.tokenPressure?.enabled ?? true,
			intervalMs: config.tokenPressure?.intervalMs ?? 6e5,
			threshold: config.tokenPressure?.threshold ?? 12e4
		}
	};
}
//#endregion
//#region lib/types/host.js
/**
* Narrow local contracts for the DSH host services and events this plugin
* consumes. Keeping these structural copies (instead of importing host source
* packages) lets the package build self-contained; a composed DSH profile
* supplies the real implementations at runtime. Field shapes mirror
* `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, and
* `@deepseek-ai/dsh-user-approval` as of dsh main 2026-08-20 (was 0.0.1-rc.2).
* P1 alignment: cancel signature, GoalChange clear-tombstone, and Cordis event
* guards expanded for perfect-plugin roadmap.
* @module dsh-lark-bridge/host
*/
/**
* Narrow a session event to the assembled assistant message for one step.
* @param event - any session event.
* @returns whether `event.data` carries {@link AssistantMessageData}.
*/
function isAssistantMessageEvent(event) {
	return event.type === "assistant/message";
}
/**
* Narrow a session event to a closed turn boundary.
* @param event - any session event.
* @returns whether `event.data` carries {@link TurnEndData}.
*/
function isTurnEndEvent(event) {
	return event.type === "turn/end";
}
/**
* Narrow a session event to the opening of one step.
* @param event - any session event.
* @returns whether `event.data` carries {@link StepStartData}.
*/
function isStepStartEvent(event) {
	return event.type === "step/start";
}
/**
* Narrow a session event to one todo-list replacement.
* @param event - any session event.
* @returns whether `event.data` carries {@link TodoWriteData}.
*/
function isTodoWriteEvent(event) {
	return event.type === "todo/write";
}
/**
* Narrow a session event to one goal snapshot mutation.
* @param event - any session event.
* @returns whether `event.data` carries {@link GoalChangeData}.
*/
function isGoalChangeEvent(event) {
	return event.type === "goal/change";
}
/** Narrow a session event to one workflow run opening. */
function isWorkflowRunStartEvent(event) {
	return event.type === "tool-workflow/run-start";
}
/** Narrow a session event to one workflow member publication. */
function isWorkflowAgentStartEvent(event) {
	return event.type === "tool-workflow/agent-start";
}
/** Narrow a session event to one workflow member settlement. */
function isWorkflowAgentEndEvent(event) {
	return event.type === "tool-workflow/agent-end";
}
/** Narrow a session event to one workflow run closing. */
function isWorkflowRunEndEvent(event) {
	return event.type === "tool-workflow/run-end";
}
/** Narrow a session event to a compaction lock opening. */
function isCompactionStartEvent(event) {
	return event.type === "compaction/start";
}
/** Narrow a session event to a compaction lock releasing. */
function isCompactionEndEvent(event) {
	return event.type === "compaction/end";
}
/** Narrow a session event to a compaction summary (what replaced old history). */
function isCompactionSummaryEvent(event) {
	return event.type === "compaction/summary";
}
/** Narrow a session event to a model-free prune of old history. */
function isCompactionPruneEvent(event) {
	return event.type === "compaction/prune";
}
/** Narrow a session event to one subagent descriptor. */
function isSubagentDescriptorEvent(event) {
	return event.type === "subagent/descriptor";
}
/** Narrow a session event to one schedule mutation. */
function isScheduleChangeEvent(event) {
	return event.type === "schedule/change";
}
/** Narrow a session event to one DeepSeek search request. */
function isWebSearchRequestEvent(event) {
	return event.type === "web/deepseek-search-llm-request";
}
/** Narrow a session event to one scheduled model-call retry. */
function isLlmRetryEvent(event) {
	return event.type === "llm/retry";
}
/**
* Narrow a session event to one raw assistant stream chunk.
* @param event - any session event.
* @returns whether `event.data` carries {@link AssistantChunkData}.
*/
/**
* Narrow a Cordis event to agent lifecycle status.
*/
function isAssistantChunkEvent(event) {
	return event.type === "assistant/chunk";
}
/**
* Narrow a session event to one completed tool call's result.
* @param event - any session event.
* @returns whether `event.data` carries {@link ToolResultData}.
*/
function isToolResultEvent(event) {
	return event.type === "tool/result";
}
/**
* The call one result answers, and the text it produced.
* @param data - the completed result payload.
* @returns the call id and its joined text output.
*/
function toolResultText(data) {
	const block = data.message.content[0];
	const text = (block?.content ?? []).filter((inner) => inner.type === "text" && inner.text !== void 0).map((inner) => inner.text).join("");
	return {
		callId: block?.toolCallId ?? data.message.source?.callId,
		text
	};
}
/**
* Narrow a session event to one model-requested tool invocation.
* @param event - any session event.
* @returns whether `event.data` carries {@link ToolCallData}.
*/
function isToolCallEvent(event) {
	return event.type === "tool/call";
}
/**
* Join the text blocks of a committed assistant message.
* @param data - the committed message payload.
* @returns the concatenated text, empty when the step produced none.
*/
function assistantText(data) {
	return data.message.content.filter((block) => block.type === "text" && block.text !== void 0 && block.text !== "").map((block) => block.text).join("");
}
/**
* Render a failed turn's reason as one operator-readable line.
* @param data - the closed turn payload.
* @returns the error detail, empty when the turn did not fail.
*/
function turnErrorDetail(data) {
	if (data.reason.kind !== "error") return "";
	const error = data.reason.error;
	return error === void 0 ? "" : `${error.code ?? "error"}: ${error.message ?? ""}`.trimEnd();
}
//#endregion
//#region lib/types/outbound.js
/**
* Outbound rendering: how one owned chat's session events become chat output.
* Two renderers share the {@link OutboundRenderer} surface — a plain-message
* renderer that sends one markdown message per completed step, and a streaming
* renderer that keeps one typewriter card per turn.
* @module dsh-lark-bridge/outbound
*/
/**
* Off-protocol tool-call markup a model may emit as plain text instead of
* using the structured tool-call API — DeepSeek's native `DSML` form, whose
* delimiters use fullwidth vertical bars. Model text is an untrusted boundary,
* so this presentation guard removes the whole block; an unterminated opener
* (a truncated stream) cuts to the end of the text.
*/
const TOOL_CALL_MARKUP = /<｜｜DSML｜｜tool_calls>[\s\S]*?(?:<\/｜｜DSML｜｜tool_calls>|$)/g;
/** Appended once when {@link stripToolCallMarkup} removed a block, so a swallowed attempt is not read as a finished thought. */
const MARKUP_NOTICE = "\n\n⚠️ 模型输出了未被识别的工具调用标记，已省略——通常意味着本次请求没有可用工具。";
/**
* Remove off-protocol tool-call markup from model text.
* @param text - committed assistant text, exactly as the model produced it.
* @returns the text without markup blocks, plus one notice when any was removed.
*/
/** Render a unified-diff block when a tool call edits a file.
*  Recognises str_replace_editor's old_str/new_str pattern. */
function tryRenderDiff(name, argsJson) {
	if (!name.includes("str_replace") && !name.includes("edit")) return void 0;
	try {
		const args = JSON.parse(argsJson);
		const oldStr = args.old_str ?? args.old_string;
		const newStr = args.new_str ?? args.new_string;
		if (typeof oldStr !== "string" || typeof newStr !== "string") return void 0;
		const del = oldStr.split("\n").map((l) => `- ${l}`);
		const add = newStr.split("\n").map((l) => `+ ${l}`);
		return [
			"```diff",
			...del,
			...add,
			"```"
		].join("\n");
	} catch {
		return;
	}
}
function stripToolCallMarkup(text) {
	if (!TOOL_CALL_MARKUP.test(text)) return text;
	TOOL_CALL_MARKUP.lastIndex = 0;
	return `${text.replace(TOOL_CALL_MARKUP, "").trimEnd()}${MARKUP_NOTICE}`;
}
/**
* Render one tool invocation as an activity line.
* @param label - what this call does, from {@link DescribeCall}.
* @returns the markdown line inserted into a streaming card.
*/
function activityLine(label) {
	return `\n\n🔧 ${label}\n`;
}
/** Final content for a card whose turn ended without producing anything. */
const IDLE_TURN_NOTE = "（本轮没有产生输出）";
/**
* Guidance appended when a failure will repeat on every later turn.
*
* A route that rejects image content rejects the whole request, and by then the
* image is in the session log — which every later request resends, compaction
* included. So the turn does not just fail: the conversation does, and saying
* only the error code leaves someone retrying it forever.
*/
const POISONED_HISTORY_HINT = "\n\n此会话历史中已包含模型无法处理的内容，之后每轮都会以同样原因失败。需要换一个会话才能继续。";
/**
* Render a failed turn as one chat line.
* @param detail - the rendered failure detail, possibly empty.
* @returns the operator-facing failure line.
*/
function failureLine(detail) {
	const line = `⚠️ 本轮任务失败 ${detail}`.trimEnd();
	return detail.startsWith("UNSUPPORTED_CONTENT") ? `${line}${POISONED_HISTORY_HINT}` : line;
}
/**
* Derive the send options one reply target implies. A target inside a topic
* thread also needs `replyInThread`, or the reply leaves the thread and lands
* in the chat's main channel.
* @param target - the aimed reply target, or undefined for plain chat sends.
* @returns the options every outbound call of that reply carries, or undefined to send with none.
*/
function replyOptions(target) {
	if (target === void 0) return void 0;
	return {
		replyTo: target.messageId,
		...target.threadId === void 0 ? {} : { replyInThread: true }
	};
}
/**
* Renderer that sends one plain markdown message per completed step. Needs no
* card permissions; tool activity stays off the chat because each line would
* cost its own message.
* @param port - outbound transport.
* @param chatId - the owned chat.
* @param onFailure - report an outbound failure.
* @returns the renderer.
*/
function createMessageRenderer(port, chatId, onFailure) {
	/** Options carried by every send while a reply target is aimed. */
	let aimed;
	const send = (input) => {
		port.send(chatId, input, aimed).catch(onFailure);
	};
	return {
		handle(event) {
			if (isAssistantMessageEvent(event)) {
				const text = stripToolCallMarkup(assistantText(event.data));
				if (text !== "") send({ markdown: text });
				return;
			}
			if (isTurnEndEvent(event) && event.data.reason.kind === "error") send({ text: failureLine(turnErrorDetail(event.data)) });
		},
		close: () => Promise.resolve(),
		aim(target) {
			aimed = replyOptions(target);
		}
	};
}
/**
* Open one streaming card. Ops queue while the SDK producer drains them, so
* event handlers never block. When the transport rejects the stream — a
* deployment without card permissions, for example — the accumulated text is
* sent once as a plain markdown message instead, so the answer still arrives.
* @param port - outbound transport.
* @param chatId - the owned chat.
* @param opts - reply options fixed when the card opens; the fallback reuses
* them, so a card and the message standing in for it land in the same place.
* @param onFailure - report the stream failure that triggered the fallback.
* @returns the handle its owner drives and settles.
*/
function openStream(port, chatId, opts, onFailure) {
	const ops = [];
	/** Everything the card should hold, for the plain-message fallback. */
	let full = "";
	let done = false;
	let wake;
	const release = () => {
		const resume = wake;
		wake = void 0;
		resume?.();
	};
	const settled = port.stream(chatId, { markdown: async (controller) => {
		for (;;) {
			const op = ops.shift();
			if (op === void 0) {
				if (done) return;
				await new Promise((resolve) => {
					wake = resolve;
				});
				continue;
			}
			if (op.kind === "append") await controller.append(op.text);
			else await controller.setContent(op.text);
		}
	} }, opts).then(() => true, (error) => {
		onFailure(error);
		return false;
	});
	return {
		append(text) {
			full += text;
			ops.push({
				kind: "append",
				text
			});
			release();
		},
		set(text) {
			full = text;
			ops.push({
				kind: "set",
				text
			});
			release();
		},
		async finish() {
			done = true;
			release();
			if (await settled) return;
			if (full === "") return;
			await port.send(chatId, { markdown: full }, opts).catch(onFailure);
		}
	};
}
/**
* Renderer that keeps one streaming typewriter card per turn.
*
* The card is created at the step boundary, because opening it costs two
* sequential transport round trips and a fast model would otherwise finish its
* answer inside that window — every delta would arrive buffered and the whole
* reply would land at once. Text then streams as it is produced, tool activity
* appears inline, reasoning streams until the answer replaces it, and each
* committed step corrects the card when the model's raw text carried markup the
* chat must not show.
* @param port - outbound transport.
* @param chatId - the owned chat.
* @param options - presentation choices and failure reporting.
* @returns the renderer.
*/
function createStreamRenderer(port, chatId, options) {
	const { showProcess, presentCall, onFailure } = options;
	let live;
	/** Options carried by every card opened, and every send made, while a reply target is aimed. */
	let aimed;
	/** Settlements of turns already closed, awaited by {@link OutboundRenderer.close}. */
	const closing = /* @__PURE__ */ new Set();
	const track = (settling) => {
		closing.add(settling);
		settling.finally(() => closing.delete(settling));
	};
	/** The card's authoritative content: everything committed, plus this step's text. */
	const render = (turn) => turn.segments.join("") + turn.liveText;
	/**
	* Drop the reasoning currently on the card, which is what makes the answer
	* replace the thinking rather than follow it.
	* @param turn - the live turn whose reasoning is pending.
	* @returns whether the card now diverges from {@link render} and must be rewritten.
	*/
	const settleReasoning = (turn) => {
		if (turn.pendingReasoning === "") return false;
		turn.pendingReasoning = "";
		return true;
	};
	/** The card for `turn`, opened lazily so a turn with no content sends nothing. */
	const ensure = (turn) => {
		if (live !== void 0 && live.turn === turn) return live;
		if (live !== void 0) track(live.handle.finish());
		live = {
			turn,
			handle: openStream(port, chatId, aimed, onFailure),
			segments: [],
			liveText: "",
			pendingReasoning: "",
			dirty: false,
			produced: false
		};
		return live;
	};
	return {
		handle(event) {
			if (isStepStartEvent(event)) {
				ensure(event.data.turn);
				return;
			}
			if (isAssistantChunkEvent(event)) {
				const { chunk } = event.data;
				if (chunk.text === void 0 || chunk.text === "") return;
				if (chunk.type === "reasoning-delta") {
					if (!showProcess) return;
					const turn = ensure(event.data.turn);
					turn.pendingReasoning += chunk.text;
					turn.handle.append(chunk.text);
					return;
				}
				if (chunk.type !== "text-delta") return;
				const turn = ensure(event.data.turn);
				turn.produced = true;
				turn.liveText += chunk.text;
				if (settleReasoning(turn)) turn.handle.set(render(turn));
				else turn.handle.append(chunk.text);
				return;
			}
			if (isAssistantMessageEvent(event)) {
				const raw = assistantText(event.data);
				const clean = stripToolCallMarkup(raw);
				const turn = ensure(event.data.turn);
				turn.produced = true;
				if (settleReasoning(turn)) turn.dirty = true;
				turn.segments.push(clean);
				turn.liveText = "";
				if (clean !== raw) turn.dirty = true;
				return;
			}
			if (isToolCallEvent(event)) {
				if (!showProcess) return;
				const turn = ensure(event.data.turn);
				turn.produced = true;
				const diffBlock = tryRenderDiff(event.data.name, event.data.arguments);
				if (diffBlock !== void 0) {
					turn.segments.push(diffBlock);
					turn.dirty = true;
				}
				const line = activityLine(presentCall(event.data.name, event.data.arguments).title);
				const rewrite = settleReasoning(turn);
				turn.segments.push(line);
				if (rewrite) turn.handle.set(render(turn));
				else turn.handle.append(line);
				return;
			}
			if (isTurnEndEvent(event)) {
				const failure = event.data.reason.kind === "error" ? failureLine(turnErrorDetail(event.data)) : "";
				if (live === void 0 || live.turn !== event.data.turn) {
					if (failure !== "") port.send(chatId, { text: failure }, aimed).catch(onFailure);
					return;
				}
				const turn = live;
				live = void 0;
				if (settleReasoning(turn)) turn.dirty = true;
				if (failure !== "") {
					turn.segments.push(`\n\n${failure}`);
					turn.dirty = true;
				}
				if (!turn.produced && failure === "" && turn.segments.length === 0) {
					turn.segments.push(IDLE_TURN_NOTE);
					turn.dirty = true;
				}
				if (turn.dirty) turn.handle.set(render(turn));
				track(turn.handle.finish());
			}
		},
		async close() {
			const pending = [...closing];
			if (live !== void 0) {
				const turn = live;
				live = void 0;
				pending.push(turn.handle.finish());
			}
			await Promise.allSettled(pending);
		},
		aim(target) {
			aimed = replyOptions(target);
		}
	};
}
//#endregion
//#region lib/types/cot.js
/**
* The thinking process as a native CoT message.
*
* Feishu carries an agent's process as its own message, driven by AG-UI events,
* and renders it the way the platform's own agents look: reasoning streams into
* a thinking area, each tool call gets an icon and a title, each result gets a
* code block. That vocabulary lines up with the host's session events almost
* one to one, so this renderer translates rather than draws — and the final
* answer goes where the platform says it belongs, in an ordinary message.
* @module dsh-lark-bridge/cot
*/
/** How many events one write call may carry, per the API's own bound. */
const MAX_EVENTS_PER_WRITE = 50;
/** How long one event's JSON may be, per the API's own bound. */
const MAX_EVENT_CONTENT_CHARS = 4096;
/**
* Tool-call kinds the host reports, mapped to the platform's icon vocabulary.
* A kind with no counterpart falls through to the platform default rather than
* guessing at a shape the icon set does not carry.
*/
const TOOL_ICONS = {
	read: "read",
	edit: "write",
	delete: "write",
	move: "write",
	search: "search",
	fetch: "search",
	execute: "bash"
};
/** Tool names that spawn or drive subagents; their calls deserve a distinct label. */
const SUBAGENT_TOOLS = /* @__PURE__ */ new Set([
	"subagent",
	"subagent_report",
	"subagent_control",
	"send_message",
	"interrupt_agent",
	"list_agents"
]);
/** Prefix a subagent call's title so the chat reads it as a delegation, not a local tool. */
function subagentTitle(name, title) {
	return SUBAGENT_TOOLS.has(name) ? `🧑💻 ${title}` : title;
}
/**
* The last timestamp handed out, so the next one is strictly greater.
*
* The client ORDERS events by this value, and a run emits many within one
* millisecond — a burst of reasoning deltas sharing a timestamp is free to be
* reordered, which is how one sentence arrives interleaved with the next.
*/
let lastTimestamp = 0;
/**
* Encode one AG-UI event, bounding its payload and stamping it after every
* event already handed out.
* @param eventType - the AG-UI event name.
* @param content - the event's own fields.
* @returns the event ready to write.
*/
function cotEvent(eventType, content) {
	const encoded = JSON.stringify(content);
	lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
	return {
		event_type: eventType,
		content: encoded.length <= MAX_EVENT_CONTENT_CHARS ? encoded : JSON.stringify({
			...content,
			truncated: true,
			delta: void 0
		}),
		timestamp: String(lastTimestamp)
	};
}
/** Bound a value a tool produced before it rides an event. */
function boundResult(text) {
	return text.length <= 1500 ? text : `${text.slice(0, 1499)}…`;
}
/**
* Renderer that shows the process as a native CoT message and leaves the answer
* to `answer`. Falling back is the caller's job: when {@link CotPort.createCot}
* rejects, this renderer reports it and the turn still answers, because the
* answer never depended on the thinking process existing.
* @param port - the CoT operations.
* @param chatId - the owned chat.
* @param options - what to show, and where the answer goes.
* @returns the renderer.
*/
function createCotRenderer(port, chatId, options) {
	const { showProcess, hidden, presentCall, onFailure, answer } = options;
	let live;
	let aimed;
	/**
	* The turn's latest committed text, held because only the LAST one is the
	* answer. An agent narrates between tool calls — "let me look at the packages
	* first" — and every one of those commits would otherwise become its own
	* chat message, which is a wall of replies to a single question. Held at the
	* renderer, not on a run: the answer does not depend on a process existing.
	*/
	let held;
	const closing = /* @__PURE__ */ new Set();
	/** Drain one run's queue, respecting the API's per-call event bound. */
	const drain = async (run) => {
		const handle = await run.opening;
		if (handle === void 0) {
			run.pending.length = 0;
			return;
		}
		while (run.pending.length > 0) {
			const batch = run.pending.splice(0, MAX_EVENTS_PER_WRITE);
			await port.writeCotEvents(handle, batch).catch(onFailure);
		}
	};
	const enqueue = (run, ...events) => {
		run.pending.push(...events);
		run.draining = run.draining.then(() => drain(run)).catch(onFailure);
	};
	/** The run for `turn`, opening one when the turn is new. */
	const ensure = (turn) => {
		if (live !== void 0 && live.turn === turn) return live;
		if (live !== void 0) closeRun(live);
		live = {
			turn,
			opening: port.createCot(chatId, {
				...aimed === void 0 ? {} : { replyTo: aimed.messageId },
				hidden
			}).catch((error) => {
				onFailure(error);
			}),
			pending: [],
			draining: Promise.resolve(),
			reasoningOpen: false,
			finished: false
		};
		enqueue(live, cotEvent("RUN_STARTED", {
			threadId: chatId,
			runId: `turn-${turn}`
		}));
		return live;
	};
	/** Finish one run, closing whatever it left open. */
	const closeRun = (run, failure) => {
		if (run.finished) return;
		run.finished = true;
		if (run.reasoningOpen) {
			enqueue(run, cotEvent("REASONING_MESSAGE_END", { messageId: `reasoning-${run.turn}` }));
			run.reasoningOpen = false;
		}
		enqueue(run, failure === void 0 ? cotEvent("RUN_FINISHED", {
			threadId: chatId,
			runId: `turn-${run.turn}`,
			status: "done"
		}) : cotEvent("RUN_ERROR", {
			message: failure,
			code: "TURN_FAILED"
		}));
		const settled = run.draining;
		closing.add(settled);
		settled.finally(() => closing.delete(settled));
	};
	return {
		aim(target) {
			aimed = target;
			answer.aim(target);
		},
		handle(event) {
			if (isAssistantMessageEvent(event)) {
				if (stripToolCallMarkup(assistantText(event.data)) === "") return;
				const superseded = held?.turn === event.data.turn ? held.event : void 0;
				held = {
					turn: event.data.turn,
					event
				};
				if (superseded === void 0 || !showProcess || !isAssistantMessageEvent(superseded)) return;
				const run = ensure(event.data.turn);
				const messageId = `text-${run.turn}-${run.pending.length}`;
				enqueue(run, cotEvent("TEXT_MESSAGE_START", {
					messageId,
					role: "assistant"
				}), cotEvent("TEXT_MESSAGE_CONTENT", {
					messageId,
					delta: stripToolCallMarkup(assistantText(superseded.data))
				}), cotEvent("TEXT_MESSAGE_END", { messageId }));
				return;
			}
			if (isTurnEndEvent(event)) answer.handle(event);
			if (isStepStartEvent(event)) {
				if (!showProcess) return;
				ensure(event.data.turn);
				return;
			}
			if (isAssistantChunkEvent(event)) {
				const { chunk } = event.data;
				if (!showProcess) return;
				if (chunk.type === "reasoning-delta") {
					if (chunk.text === void 0 || chunk.text === "") return;
					const run = ensure(event.data.turn);
					const messageId = `reasoning-${run.turn}`;
					if (!run.reasoningOpen) {
						run.reasoningOpen = true;
						enqueue(run, cotEvent("REASONING_MESSAGE_START", {
							messageId,
							role: "reasoning"
						}));
					}
					enqueue(run, cotEvent("REASONING_MESSAGE_CONTENT", {
						messageId,
						delta: chunk.text
					}));
					return;
				}
				if (chunk.type === "block-end" && chunk.block?.type === "reasoning") {
					const text = chunk.block.text ?? "";
					if (text === "") return;
					const run = ensure(event.data.turn);
					const messageId = `reasoning-${run.turn}`;
					if (run.reasoningOpen) {
						run.reasoningOpen = false;
						enqueue(run, cotEvent("REASONING_MESSAGE_END", { messageId }));
					}
					enqueue(run, cotEvent("REASONING_MESSAGE_START", {
						messageId,
						role: "reasoning"
					}));
					enqueue(run, cotEvent("REASONING_MESSAGE_CONTENT", {
						messageId,
						delta: text
					}));
					enqueue(run, cotEvent("REASONING_MESSAGE_END", { messageId }));
					return;
				}
				return;
			}
			if (isToolCallEvent(event)) {
				if (!showProcess) return;
				const run = ensure(event.data.turn);
				const shown = presentCall(event.data.name, event.data.arguments);
				const toolCallId = event.data.callId;
				if (run.reasoningOpen) {
					run.reasoningOpen = false;
					enqueue(run, cotEvent("REASONING_MESSAGE_END", { messageId: `reasoning-${run.turn}` }));
				}
				enqueue(run, cotEvent("TOOL_CALL_START", {
					toolCallId,
					icon: TOOL_ICONS[shown.kind ?? ""] ?? "default",
					title: subagentTitle(event.data.name, shown.title),
					toolCallName: event.data.name
				}), cotEvent("TOOL_CALL_ARGS", {
					toolCallId,
					delta: event.data.arguments
				}), cotEvent("TOOL_CALL_END", { toolCallId }));
				return;
			}
			if (isToolResultEvent(event)) {
				if (!showProcess) return;
				const { callId, text } = toolResultText(event.data);
				if (callId === void 0) return;
				const run = ensure(event.data.turn);
				enqueue(run, cotEvent("TOOL_CALL_RESULT", {
					messageId: `result-${callId}`,
					toolCallId: callId,
					role: "tool",
					content: {
						type: "code",
						code: boundResult(text)
					},
					...event.data.error === void 0 ? {} : { error: event.data.error.code }
				}));
				return;
			}
			if (isTurnEndEvent(event)) {
				if (held?.turn === event.data.turn) {
					answer.handle(held.event);
					held = void 0;
				}
				if (live === void 0 || live.turn !== event.data.turn) return;
				const run = live;
				live = void 0;
				const detail = turnErrorDetail(event.data);
				closeRun(run, detail === "" ? void 0 : detail);
			}
		},
		async close() {
			if (held !== void 0) {
				answer.handle(held.event);
				held = void 0;
			}
			if (live !== void 0) {
				const run = live;
				live = void 0;
				closeRun(run);
			}
			await Promise.allSettled([...closing, answer.close()]);
		}
	};
}
//#endregion
//#region lib/types/authorization.js
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
function resolveAuthorization(config) {
	return {
		directSenders: new Set(config.senderAllowlist),
		groups: new Set(config.groupAllowlist),
		approvers: new Set(config.approvers)
	};
}
/**
* State the channel's reach once, for the operator, at startup — who it will
* serve is a fact worth seeing next to the fact that it runs a shell.
* @param authorization - the channel's authorization rules.
* @returns one console line describing that reach.
*/
function describeAuthorization(authorization) {
	return `dsh-lark-bridge: ${authorization.directSenders.size === 0 ? "direct messages: anyone the app is visible to (narrow with senderAllowlist)" : `direct messages: ${[...authorization.directSenders].join(", ")}`}; ${authorization.groups.size === 0 ? "groups: any group the bot is added to, when @-mentioned" : `groups: ${[...authorization.groups].join(", ")}`}; ${authorization.approvers.size === 0 ? "approvals: anyone who may drive that chat" : `approvals: ${[...authorization.approvers].join(", ")}`}`;
}
/**
* Whether one inbound message may drive this channel.
* @param authorization - the channel's authorization rules.
* @param subject - the message's sender, chat, and chat kind.
* @returns the refusal reason for the operator log, or undefined when allowed.
*/
function refuseMessage(authorization, subject) {
	if (subject.chatType === "p2p") {
		if (authorization.directSenders.size === 0) return void 0;
		return authorization.directSenders.has(subject.senderId) ? void 0 : `sender ${subject.senderId} is not in senderAllowlist`;
	}
	if (authorization.groups.size > 0 && !authorization.groups.has(subject.chatId)) return `group ${subject.chatId} is not in groupAllowlist`;
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
function refuseApprovalClick(authorization, click, pending) {
	if (click.chatId !== pending.chatId) return `click from chat ${click.chatId} does not match the card's chat ${pending.chatId}`;
	if (click.operatorId === void 0) return "the click carries no operator id";
	if (authorization.approvers.size > 0) return authorization.approvers.has(click.operatorId) ? void 0 : `operator ${click.operatorId} is not in approvers`;
	return refuseMessage(authorization, {
		senderId: click.operatorId,
		chatId: pending.chatId,
		chatType: pending.chatType
	});
}
//#endregion
//#region lib/types/chronicle.js
/**
* Fire-and-forget posting of accepted inbound messages to an external
* chronicle ledger. Contract: the ledger is best-effort by design — a down or
* slow endpoint must never delay, fail, or otherwise influence message
* handling. The bridge does not await, retry, or queue: one POST attempt with
* a short timeout, failures logged on the operator console.
*/
const postChronicle = (endpoint, payload, log = () => {}) => {
	if (!endpoint) return;
	try {
		fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(3e3),
			keepalive: true
		}).then((r) => {
			if (!r.ok) log(`dsh-lark-bridge: chronicle post failed: HTTP ${r.status}`);
		}).catch((e) => log(`dsh-lark-bridge: chronicle post failed: ${String(e)}`));
	} catch (e) {
		log(`dsh-lark-bridge: chronicle post failed: ${String(e)}`);
	}
};
//#endregion
//#region lib/types/briefing.js
/**
* Session-start briefing injection: prepend a situation file's contents to
* the FIRST user message of each session (per process lifetime). This gives
* every chat agent ambient situational awareness — who the user is, what is
* in flight across the fleet — without trusting model cooperation to fetch it.
*
* Contract: read errors are logged and degrade to "no briefing"; the file is
* small and re-read per injection so external refreshers are picked up live.
*/
const briefedSessions = /* @__PURE__ */ new Set();
function briefingPrefix(file, sessionId, log) {
	if (!file) return "";
	const key = `${file}\u0000${sessionId}`;
	if (briefedSessions.has(key)) return "";
	briefedSessions.add(key);
	try {
		const text = readFileSync(file, "utf-8").trim();
		if (text === "") return "";
		return `[System briefing — auto-injected context]\n${text}\n[/System briefing]\n\n`;
	} catch (e) {
		log(`dsh-lark-bridge: briefing read failed: ${String(e)}`);
		return "";
	}
}
//#endregion
//#region lib/types/subagent-card.js
/**
* Tracks subagent children for one chat session and renders them as a single
* updatable Feishu interactive card. One card shows ALL live children; each
* status change re-renders the card in place.
* @module dsh-lark-bridge/subagent-card
*/
function createTracker() {
	return { entries: /* @__PURE__ */ new Map() };
}
function addEntry(state, id, descriptor) {
	state.entries.set(id, {
		id,
		label: descriptor.label ?? `child-${state.entries.size + 1}`,
		mode: descriptor.mode === "continuable" ? "continuable" : "one-shot",
		status: "running"
	});
}
function statusMark(s) {
	switch (s) {
		case "completed": return "✅";
		case "aborted": return "⏹️";
		case "error": return "❌";
		case "max-tokens": return "⛔";
		default: return "⏳";
	}
}
function render(state) {
	const rows = [];
	for (const [, e] of state.entries) {
		const mark = statusMark(e.status);
		rows.push(` ${mark} **${e.label}** — ${e.status}`);
	}
	return {
		config: { wide_screen_mode: true },
		header: {
			template: "purple",
			title: {
				tag: "plain_text",
				content: "🧑‍💻 多代理执行面板"
			}
		},
		elements: [{
			tag: "div",
			text: {
				tag: "lark_md",
				content: rows.length > 0 ? rows.join("\n") : "（无子任务）"
			}
		}]
	};
}
//#endregion
//#region lib/types/i18n.js
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
/**
* Bridge-owned commands and the dsh host commands a chat profile composes
* (goal, compact, feedback). Anything the roster adds without an entry here
* falls back to its own description, verbatim.
*/
const COMMAND_DESCRIPTIONS = {
	stop: {
		zh: "停止当前任务",
		en: "Stop the current task"
	},
	restart: {
		zh: "重启服务进程（需部署侧配置）",
		en: "Restart the host process (deployment-configured)"
	},
	preset: {
		zh: "查看/切换模式（标准/PTC/极简/创造）",
		en: "View or switch mode (standard/PTC/minimal/cordis)"
	},
	sessions: {
		zh: "查看本聊天的会话历史",
		en: "View this chat’s session history"
	},
	tools: {
		zh: "查看/禁用/恢复工具",
		en: "View, deny, or allow tools"
	},
	schedules: {
		zh: "查看本聊天的定时提醒",
		en: "View this chat’s scheduled reminders"
	},
	jobs: {
		zh: "查看本会话的后台任务",
		en: "View this session’s background jobs"
	},
	context: {
		zh: "查看上下文 token 压力",
		en: "View context token pressure"
	},
	skills: {
		zh: "查看可用 skills / 查看某个 skill",
		en: "List skills / inspect one skill"
	},
	model: {
		zh: "查看/切换默认模型",
		en: "View or switch the default model"
	},
	ws: {
		zh: "查看已注册的工作区目录",
		en: "List registered workspaces"
	},
	plugins: {
		zh: "查看已部署的插件及运行状态",
		en: "List deployed plugins and status"
	},
	audit: {
		zh: "查看本会话的操作审计",
		en: "View this session’s operation audit"
	},
	config: {
		zh: "查看桥的当前配置",
		en: "View the bridge’s current configuration"
	},
	bot: {
		zh: "双端状态/设置/插件同步",
		en: "Dual-end status, settings, and plugin sync"
	},
	help: {
		zh: "显示可用命令",
		en: "Show available commands"
	},
	goal: {
		zh: "查看/设置目标",
		en: "Set or view the goal"
	},
	compact: {
		zh: "压缩较早的对话历史",
		en: "Compact older conversation history"
	},
	feedback: {
		zh: "提交本次会话反馈",
		en: "Record feedback about this session"
	},
	plan: {
		zh: "进入/退出计划模式",
		en: "Enter or leave plan mode"
	},
	clear: {
		zh: "清空当前上下文",
		en: "Clear the current context"
	},
	new: {
		zh: "新开会话",
		en: "Start a new session"
	},
	settings: {
		zh: "查看/修改设置",
		en: "View or change settings"
	},
	permission: {
		zh: "查看权限模式",
		en: "View permission mode"
	},
	schedule: {
		zh: "管理定时提醒",
		en: "Manage scheduled reminders"
	},
	sessions_alt: {
		zh: "查看会话",
		en: "View sessions"
	}
};
/**
* Resolve one command's description for a locale.
* @param name - the command name (without slash).
* @param locale - the target language.
* @param fallback - the host's own description, used when this table has no
* entry for the command.
* @returns the description to show.
*/
function describeCommand(name, locale, fallback) {
	const entry = COMMAND_DESCRIPTIONS[name];
	if (entry === void 0) return fallback;
	return locale === "en" ? entry.en : entry.zh;
}
/** Heading for the `/help` listing. */
function helpHeading(locale) {
	return locale === "en" ? "**Available commands**" : "**可用命令**";
}
//#endregion
//#region lib/types/sync/settings-store.js
/**
* Cross-profile settings single source for the bridge.
*
* DSH Desktop 2.0.0 keeps a separate `desktop` profile from the `web` profile
* (upstream dsh-desktop#93): sessions and themes already live in the shared
* `~/.dsh` home, but per-profile configuration does not. This store puts the
* bridge's own bot settings into that shared home so both forms read one
* truth, while the host-injected profile configuration stays the boot-time
* base that the shared file overlays.
*
* Two hosts must never corrupt each other (upstream deepseek-harness#1485
* showed concurrent writers destroying shared state), so every write is:
* backup → atomic tmp+rename, and cross-process contention goes through an
* O_EXCL lockfile with stale-lock takeover.
* @module dsh-lark-bridge/sync/settings-store
*/
/** Fields the shared store is allowed to carry. Keep in step with `Config`. */
const SHARED_KEYS = [
	"appId",
	"appSecret",
	"domain",
	"locale",
	"cwd",
	"provider",
	"model"
];
const DIR_NAME = "dsh-lark-bridge";
const FILE_NAME$1 = "settings.json";
const LOCK_NAME = "settings.lock";
const LOCK_STALE_MS = 1e4;
/** Absolute path of the shared sync directory (`$DSH_HOME/dsh-lark-bridge`). */
function syncDir(home) {
	const base = process.env.DSH_SYNC_HOME ?? home ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
	return path.join(base, DIR_NAME);
}
/** Absolute path of the shared settings file. */
function settingsFile(home) {
	return path.join(syncDir(home), FILE_NAME$1);
}
/**
* Read the shared settings document, or `{}` when absent/corrupt. A corrupt
* file is quarantined (renamed `.corrupt-<ts>`) rather than trusted or
* silently discarded — the operator can diff it after the fact.
*/
async function readSettings(home) {
	const file = settingsFile(home);
	let raw;
	try {
		raw = await fsp.readFile(file, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		return parsed;
	} catch {
		await fsp.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
		return {};
	}
}
/**
* Atomically replace the shared document. Writes go tmp+rename so a reader on
* the other host never sees a torn file; the previous document is kept as a
* timestamped backup for last-writer-wins archaeology.
*/
async function writeSettings(settings, home) {
	const dir = syncDir(home);
	await fsp.mkdir(dir, { recursive: true });
	const file = settingsFile(home);
	const clean = {};
	for (const key of SHARED_KEYS) {
		const value = settings[key];
		if (typeof value === "string" && value !== "") clean[key] = value;
	}
	const payload = `${JSON.stringify(clean, null, 2)}\n`;
	await fsp.copyFile(file, `${file}.bak-${Date.now()}`).catch(() => {});
	const tmp = path.join(dir, `.${FILE_NAME$1}.${process.pid}.tmp`);
	await fsp.writeFile(tmp, payload, { mode: 384 });
	await fsp.rename(tmp, file);
}
/**
* Acquire the directory lock, run `body`, release. Cross-process contention
* resolves by stale takeover: a lock older than {@link LOCK_STALE_MS} belongs
* to a dead writer and is taken over. Same-process re-entry rejects — callers
* serialize their own workflows.
*/
async function withLock(home, body) {
	const dir = syncDir(home);
	await fsp.mkdir(dir, { recursive: true });
	const lock = path.join(dir, LOCK_NAME);
	for (;;) try {
		const fd = fs.openSync(lock, "wx");
		fs.writeSync(fd, JSON.stringify({
			pid: process.pid,
			at: Date.now()
		}));
		fs.closeSync(fd);
		break;
	} catch (err) {
		if (err.code !== "EEXIST") throw err;
		const stat = await fsp.stat(lock).catch(() => null);
		if (stat === null) continue;
		if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
			await fsp.unlink(lock).catch(() => {});
			continue;
		}
		await sleep(50);
	}
	try {
		return await body();
	} finally {
		await fsp.unlink(lock).catch(() => {});
	}
}
/**
* Read-modify-write the shared document under the lock. The mutator receives
* the current document and returns the replacement; `undefined` means "leave
* the file alone".
*/
async function updateSettings(home, mutate) {
	return withLock(home, async () => {
		const current = await readSettings(home);
		const next = mutate(current);
		if (next !== void 0) await writeSettings(next, home);
		return next === void 0 ? current : next;
	});
}
/**
* Mask a credential for any UI or log surface: keep the last four characters,
* never the secret itself. Short values collapse entirely.
*/
function maskSecret(value) {
	if (value === void 0 || value === "") return "";
	if (value.length <= 4) return "****";
	return `****${value.slice(-4)}`;
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region lib/types/sync/peers.js
/**
* Peer discovery between bridge instances running in different profile forms
* (web vs desktop). Each instance heartbeats into a shared peers document in
* the `~/.dsh` home; entries expire by TTL, so a dead end simply stops
* appearing. Synchronization actions always target one named peer.
* @module dsh-lark-bridge/sync/peers
*/
/** How long a peer entry stays visible without a fresh heartbeat. */
const PEER_TTL_MS = 3e4;
const FILE_NAME = "peers.json";
function peersFile(home) {
	return path.join(syncDir(home), FILE_NAME);
}
/** This instance's identity, as it should appear to the other end. */
function selfEntry(form, profile, bridgeVersion, port, token, manifest) {
	return {
		profile,
		form,
		...port === void 0 ? {} : { port },
		pid: process.pid,
		bridgeVersion,
		...token === void 0 ? {} : { token },
		...manifest === void 0 ? {} : { manifest },
		host: os.hostname(),
		ts: Date.now()
	};
}
async function readDocument(home) {
	try {
		const parsed = JSON.parse(await fsp.readFile(peersFile(home), "utf8"));
		if (!Array.isArray(parsed.peers)) return { peers: [] };
		return parsed;
	} catch {
		return { peers: [] };
	}
}
async function writeDocument(home, doc) {
	const dir = syncDir(home);
	await fsp.mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.tmp`);
	await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 384 });
	await fsp.rename(tmp, peersFile(home));
}
/**
* Publish this instance's heartbeat and return the other live peers. Both
* sides of the file go through the directory lock so a heartbeat from the
* other host cannot erase ours mid-read; expired entries are pruned on every
* pass.
*/
async function heartbeat(mine, home) {
	return withLock(home, async () => {
		const doc = await readDocument(home);
		const now = Date.now();
		const isSelf = (peer) => peer.profile === mine.profile && peer.pid === mine.pid && peer.host === mine.host;
		const others = doc.peers.filter((peer) => !isSelf(peer)).filter((peer) => now - peer.ts <= PEER_TTL_MS);
		await writeDocument(home, { peers: [...others, {
			...mine,
			ts: now
		}] });
		return others;
	});
}
/**
* Read the currently-live peers without heartbeating. Expired entries are
* pruned as a side effect. Pass the caller's `self` identity (pid + host) to
* take itself out of the listing.
*/
async function listPeers(home, self) {
	return withLock(home, async () => {
		const doc = await readDocument(home);
		const now = Date.now();
		const isSelf = (peer) => self !== void 0 && peer.profile === self.profile && peer.pid === self.pid && peer.host === self.host;
		const alive = doc.peers.filter((peer) => now - peer.ts <= PEER_TTL_MS).filter((peer) => !isSelf(peer));
		if (alive.length !== doc.peers.length) await writeDocument(home, { peers: alive });
		return alive;
	});
}
//#endregion
//#region lib/types/sync/profile-manifest.js
/**
* Read a dsh profile's plugin manifest. A profile's manifest is its
* `package.json`: `dependencies` are the installed plugin packages and
* `dsh.profile.bundles` the active bundle list — exactly the unit the two
* profile forms (web vs desktop) drift apart on (upstream dsh-desktop#93).
* @module dsh-lark-bridge/sync/profile-manifest
*/
var profile_manifest_exports = /* @__PURE__ */ __exportAll({
	diffManifests: () => diffManifests,
	profilesDir: () => profilesDir,
	readProfileManifest: () => readProfileManifest
});
/** Where dsh keeps profiles inside the harness home. */
function profilesDir(harnessHome) {
	return path.join(harnessHome, "profiles");
}
/**
* Read one profile's manifest. Missing profile (e.g. desktop not installed on
* this host) resolves `null` — a legitimate state the sync surface presents
* as "the other end has no such profile yet", not an error.
*/
async function readProfileManifest(harnessHome, profile) {
	const file = path.join(profilesDir(harnessHome), profile, "package.json");
	let raw;
	try {
		raw = await fsp.readFile(file, "utf8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const stat = await fsp.stat(file).catch(() => null);
	return {
		profile,
		dependencies: parsed.dependencies ?? {},
		bundles: parsed.dsh?.profile?.bundles ?? [],
		mtimeMs: stat?.mtimeMs ?? 0
	};
}
/**
* Diff two manifests from the perspective of "here" adopting "there".
* Bridge-internal packages (cordis runtime, the bridge itself) are excluded:
* they are per-profile machinery, not community plugins a sync should move.
*/
function diffManifests(here, there, options) {
	const exclude = new Set(options?.exclude ?? []);
	const toInstall = [];
	for (const [name, version] of Object.entries(there.dependencies)) {
		if (exclude.has(name)) continue;
		const local = here.dependencies[name];
		if (local === void 0 || local !== version) toInstall.push({
			name,
			version
		});
	}
	const hereBundles = new Set(here.bundles);
	return {
		toInstall,
		bundlesToEnable: there.bundles.filter((bundle) => !hereBundles.has(bundle))
	};
}
//#endregion
//#region lib/types/sync/plugin-sync.js
/**
* Plugin-manifest sync between profile forms — the concrete fix for upstream
* dsh-desktop#93 ("conversations survive, plugins don't"). The bridge diffs
* the two profiles' manifests and installs what is missing here, one package
* at a time, through the upstream `dsh plugin` CLI. It never writes a plugin
* tree itself: two hosts writing one tree corrupts workspace session lists
* (deepseek-harness#1485), so installation semantics stay with the CLI that
* owns the profile.
* @module dsh-lark-bridge/sync/plugin-sync
*/
/** Packages that belong to the runtime, not to a chat's plugin taste. */
const DEFAULT_EXCLUDE = [
	"@deepseek-ai/cordis",
	"@deepseek-ai/cordis-plugin-loader",
	"@deepseek-ai/schemastery"
];
/** Build the install plan adopting the peer manifest into this profile. */
function buildSyncPlan(here, there, options) {
	const diff = diffManifests(here, there, { exclude: options?.exclude ?? DEFAULT_EXCLUDE });
	const steps = [];
	for (const pkg of diff.toInstall) {
		const spec = `${pkg.name}@${pkg.version}`;
		steps.push({
			kind: "add",
			profile: here.profile,
			spec,
			command: `dsh plugin --profile ${here.profile} add ${spec}`
		});
	}
	for (const bundle of diff.bundlesToEnable) if (here.dependencies[bundle] !== void 0) steps.push({
		kind: "enable",
		profile: here.profile,
		bundle
	});
	const installing = new Set(diff.toInstall.map((pkg) => pkg.name));
	return {
		steps,
		inSync: Object.keys(here.dependencies).filter((name) => there.dependencies[name] !== void 0 && !installing.has(name) && !(options?.exclude ?? DEFAULT_EXCLUDE).includes(name))
	};
}
/**
* Execute a plan's `add` steps through the upstream CLI. `runCommand` is
* injected so tests never touch a real dsh; production passes a child-process
* runner. Enable steps are returned unexecuted — bundling an existing package
* changes agent behavior materially and belongs to an explicit human choice,
* not to a sync sweep.
*/
async function applySyncPlan(plan, runCommand) {
	const result = {
		ran: [],
		skipped: [],
		failures: []
	};
	for (const step of plan.steps) {
		if (step.kind !== "add") {
			result.skipped.push(step);
			continue;
		}
		try {
			await runCommand(step.command);
			result.ran.push(step);
		} catch (err) {
			result.failures.push({
				step,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}
	return result;
}
//#endregion
//#region lib/types/sync/control-api.js
/**
* Localhost-only control API for cross-instance sync. Each bridge instance
* serves its health, its profile manifest, and a manifest diff to the peer
* instance; every request must carry the instance's boot token as a bearer.
* The token rotates each boot and travels through the shared peers document
* (`peers.json`), which lives in the user-owned `~/.dsh` home — so the trust
* boundary is "local user", matching the threat model of a developer machine
* and the one-time-token pattern upstream introduced for the web UI in 0.1.2.
* @module dsh-lark-bridge/sync/control-api
*/
/**
* Start the control API bound to 127.0.0.1. Rejects requests lacking the
* exact bearer token; everything it serves is read-only in this iteration.
*/
function startControlApi(state, token, requestedPort) {
	const server = http.createServer((req, res) => {
		handle(req, res, state, token).catch(() => {
			res.statusCode = 500;
			res.end("{\"error\":\"internal\"}");
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(requestedPort ?? 0, "127.0.0.1", () => {
			resolve({
				port: server.address().port,
				close: () => new Promise((done) => server.close(() => done()))
			});
		});
	});
}
async function handle(req, res, state, token) {
	if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
		res.statusCode = 401;
		res.end("{\"error\":\"unauthorized\"}");
		return;
	}
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (req.method === "GET" && url.pathname === "/control/health") {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({
			profile: state.profile,
			form: state.form,
			bridgeVersion: state.bridgeVersion,
			pid: process.pid
		}));
		return;
	}
	if (req.method === "GET" && url.pathname === "/control/manifest") {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(await state.manifest()));
		return;
	}
	res.statusCode = 404;
	res.end("{\"error\":\"not_found\"}");
}
/** Fetch a peer's manifest over its control API. */
async function fetchPeerManifest(port, token, timeoutMs = 5e3) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`http://127.0.0.1:${port}/control/manifest`, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
//#endregion
//#region lib/types/sync/migrate.js
/**
* Device migration — moving a bridge installation (Feishu credentials, shared
* settings, per-profile plugin lists) from one machine to another. The
* export is a constructed JSON document, so the live state that must never
* travel (peer heartbeats, rotating control tokens, lock files,
* node_modules) is excluded by construction rather than by filtering. See
* docs/design/设计卡_设备迁移与多机.md.
* @module dsh-lark-bridge/sync/migrate
*/
/** Identifies a well-formed migration document. */
const MIGRATION_KIND = "dsh-lark-bridge-migration";
/** Settings keys that are credentials and get masked by default. */
const SECRET_KEYS = ["appSecret"];
/** Collect the export document from live local state. */
async function buildMigration(home, harnessHome, profile, form, options) {
	const settings = await readSettings(home);
	const traveled = {};
	for (const [key, value] of Object.entries(settings)) traveled[key] = SECRET_KEYS.includes(key) && !options?.includeSecrets ? maskSecret(value) : value;
	const wanted = [profile, ...(options?.profiles ?? []).filter((p) => p !== profile)];
	const profiles = {};
	for (const name of wanted) {
		const manifest = await readProfileManifest(harnessHome, name);
		profiles[name] = manifest === null ? {
			dependencies: {},
			bundles: []
		} : {
			dependencies: manifest.dependencies,
			bundles: manifest.bundles
		};
	}
	return {
		kind: MIGRATION_KIND,
		version: 1,
		exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
		from: {
			profile,
			form,
			host: os.hostname()
		},
		settings: traveled,
		profiles,
		notes: { hint: "sessions live under ~/.dsh (upstream-owned); copy that directory to carry them — this file intentionally excludes live state (peers, tokens, node_modules)" }
	};
}
/**
* Resolve the file to import: no argument means the default landing file;
* an argument must be a bare file name inside the sync directory — path
* traversal would turn a chat command into an arbitrary file read.
*/
function resolveMigrationFile(name, home) {
	const dir = syncDir(home);
	if (name === void 0 || name === "") return path.join(dir, "migrate.json");
	if (name.includes("/") || name.includes("\\") || name === "." || name === ".." || path.basename(name) !== name) throw new Error(`非法文件名 \`${name}\`——只允许 sync 目录内的裸文件名`);
	return path.join(dir, name);
}
/** Parse and validate an untrusted document. Throws with a readable reason. */
function validateMigration(parsed) {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("迁移文件不是 JSON 对象");
	const doc = parsed;
	if (doc.kind !== "dsh-lark-bridge-migration") throw new Error(`kind 不是 \`${MIGRATION_KIND}\`——这不是桥的迁移文件`);
	if (doc.version !== 1) throw new Error(`版本 ${String(doc.version)} 不受支持（当前 1）`);
	const from = doc.from;
	if (from === void 0 || typeof from.host !== "string") throw new Error("缺 from.host");
	if (typeof doc.exportedAt !== "string") throw new Error("缺 exportedAt");
	if (doc.settings === null || typeof doc.settings !== "object" || Array.isArray(doc.settings)) throw new Error("settings 段缺失或形状不对");
	if (doc.profiles === null || typeof doc.profiles !== "object" || Array.isArray(doc.profiles)) throw new Error("profiles 段缺失或形状不对");
	return doc;
}
/** Read + validate a migration document from the sync directory. */
async function readMigration(name, home) {
	const file = resolveMigrationFile(name, home);
	let raw;
	try {
		raw = await fsp.readFile(file, "utf8");
	} catch {
		throw new Error(`读不到迁移文件 \`${file}\`——先把旧机 /bot export 的产物放进来`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("迁移文件不是合法 JSON");
	}
	return validateMigration(parsed);
}
/**
* Plan what importing `imported` means for the local `profile`: packages
* missing locally (or pinned to another version) become `add` steps through
* the upstream CLI; anything already present stays untouched. Reuses the
* plugin-sync plan/apply pipeline so semantics never fork.
*/
function buildImportPlan(local, profile, imported) {
	const steps = [];
	for (const [name, spec] of Object.entries(imported.dependencies)) {
		if (local?.dependencies[name] === spec) continue;
		const pinned = spec.includes("@", 1) ? spec : `${name}@${spec}`;
		steps.push({
			kind: "add",
			profile,
			spec: pinned,
			command: `dsh plugin --profile ${profile} add ${pinned}`
		});
	}
	return {
		steps,
		inSync: Object.keys(local?.dependencies ?? {}).filter((name) => imported.dependencies[name] !== void 0 && !steps.some((step) => step.spec.startsWith(`${name}@`)))
	};
}
/**
* The cross-host reminder text, or null when importing on the same machine.
* Same-Feishu-app double delivery is the one migration mistake that bites
* immediately and confusingly, so the import reply always carries it.
*/
function crossHostWarning(file) {
	if (file.from.host === os.hostname()) return null;
	return `⚠️ 此文件来自 **${file.from.host}**。若旧机的桥仍在运行，请先停掉它——同一个飞书 appId 两台机器同时连接会导致消息双投递、双回复。`;
}
//#endregion
//#region lib/types/sync/bot-command.js
/**
* The `/bot` command: bridge identity, cross-form settings, and plugin sync —
* the chat-facing surface of the dual-end sync feature (see
* docs/design/设计卡_双端设置与同步.md). Text-first, matching the bridge's
* other control commands; every mutating subcommand echoes masked secrets.
* @module dsh-lark-bridge/sync/bot-command
*/
let activeContext;
/**
* Publish the runtime-built sync context. The bridge's command dispatcher
* reads it via {@link getSyncContext}; the module-singleton pattern matches
* `setRestartScheduler` in commands.ts.
*/
function setSyncContext(context) {
	activeContext = context;
}
/** The runtime-published sync context, when the runtime wired one. */
function getSyncContext() {
	return activeContext;
}
/** The subcommands `/bot` accepts. */
const SUBCOMMANDS = /* @__PURE__ */ new Set([
	"set",
	"unset",
	"peers",
	"sync-plugins",
	"export",
	"import"
]);
/**
* Handle `/bot [subcommand …]`. Returns the reply for the chat; every secret
* is masked before it leaves this module.
*/
async function runBotCommand(line, ctx) {
	const [sub, ...rest] = line.slice(4).trim().split(/\s+/);
	const subcommand = sub ?? "";
	if (subcommand === "") return statusReply(ctx);
	if (subcommand === "set") return setReply(ctx, rest);
	if (subcommand === "unset") return unsetReply(ctx, rest);
	if (subcommand === "peers") return peersReply(ctx);
	if (subcommand === "sync-plugins") return syncPluginsReply(ctx, rest);
	if (subcommand === "export") return exportReply(ctx, rest);
	if (subcommand === "import") return importReply(ctx, rest);
	return {
		reply: `⚠️ 未知子命令 \`${subcommand}\`。可用：${[...SUBCOMMANDS].map((s) => `\`${s}\``).join(" / ")}（无参数 = 状态面板）`,
		resolved: false
	};
}
async function statusReply(ctx) {
	const peers = await listPeers(ctx.home);
	const settings = await readSettings(ctx.home);
	const sharedKeys = Object.keys(settings);
	const peerRows = peers.length === 0 ? "（无其他端在线——对端桥未运行或未装本插件）" : peers.map((p) => {
		const age = Math.round((Date.now() - p.ts) / 1e3);
		return `- **${p.profile}**（${p.form}）v${p.bridgeVersion} @ ${p.host}${p.port === void 0 ? "" : ` :${p.port}`}（心跳 ${age}s 前）`;
	}).join("\n");
	const settingRows = sharedKeys.length === 0 ? "（共享设置为空——双端配置尚未建立）" : sharedKeys.map((key) => {
		const value = settings[key] ?? "";
		return `- ${key}: \`${key.toLowerCase().includes("secret") || key.toLowerCase().includes("appid") ? maskSecret(value) : value}\``;
	}).join("\n");
	return {
		reply: [
			`**桥 · 双端状态**`,
			`- 本端：**${ctx.profile}**（${ctx.form}）v${ctx.bridgeVersion}`,
			`- 在线对端（${PEER_TTL_MS / 1e3}s 心跳窗口）：`,
			peerRows,
			`- 共享设置（${syncDirHint()}）：`,
			settingRows,
			"",
			"子命令：`/bot set <key> <value>` / `/bot unset <key>` / `/bot peers` / `/bot sync-plugins [apply]` / `/bot export [include-secrets]` / `/bot import [file] [apply]`"
		].join("\n"),
		resolved: true
	};
}
async function setReply(ctx, rest) {
	const [key, value] = [rest[0], rest.slice(1).join(" ")];
	if (key === void 0 || value === "") return {
		reply: `⚠️ 格式：\`/bot set <key> <value>\`。可设键：${SHARED_KEYS.map((k) => `\`${k}\``).join(" / ")}`,
		resolved: false
	};
	if (!isSharedKey(key)) return {
		reply: `⚠️ \` ${key} \` 不是可共享键。可用：${SHARED_KEYS.map((k) => `\`${k}\``).join(" / ")}`,
		resolved: false
	};
	const next = await updateSettings(ctx.home, (current) => ({
		...current,
		[key]: value
	}));
	const transport = key === "appId" || key === "appSecret" || key === "domain";
	return {
		reply: [
			`✅ \`${key}\` 已写入共享设置（\`${key.toLowerCase().includes("secret") || key.toLowerCase().includes("appid") ? maskSecret(value) : value}\`）。`,
			transport ? "⚠️ 该字段影响飞书连接——两端桥在下次重启/重连后生效。" : "其他端在下次读取时自动生效。",
			`当前共 ${Object.keys(next).length} 个共享键。`
		].join("\n"),
		resolved: true
	};
}
async function unsetReply(ctx, rest) {
	const key = rest[0];
	if (key === void 0 || !isSharedKey(key)) return {
		reply: `⚠️ 格式：\`/bot unset <key>\`。可用：${SHARED_KEYS.map((k) => `\`${k}\``).join(" / ")}`,
		resolved: false
	};
	await updateSettings(ctx.home, (current) => {
		if (!(key in current)) return void 0;
		const next = { ...current };
		delete next[key];
		return next;
	});
	return {
		reply: `✅ \`${key}\` 已从共享设置移除（本端 profile 注入值将重新生效）。`,
		resolved: true
	};
}
async function peersReply(ctx) {
	const peers = await heartbeat(selfEntry(ctx.form, ctx.profile, ctx.bridgeVersion, ctx.controlPort, ctx.controlToken), ctx.home);
	if (peers.length === 0) return {
		reply: "**在线对端**：无。对端装桥并运行后，30s 内会出现在这里。",
		resolved: true
	};
	return {
		reply: `**在线对端**\n${peers.map((p) => `- **${p.profile}**（${p.form}）v${p.bridgeVersion} @ ${p.host}${p.port === void 0 ? "" : ` :${p.port}`}${p.token === void 0 ? "" : " 🔑"}`).join("\n")}`,
		resolved: true
	};
}
async function syncPluginsReply(ctx, rest) {
	const apply = rest.includes("apply");
	const peers = await heartbeat(selfEntry(ctx.form, ctx.profile, ctx.bridgeVersion, ctx.controlPort, ctx.controlToken), ctx.home);
	const peer = peers.find((p) => p.manifest !== void 0) ?? peers.find((p) => p.port !== void 0 && p.token !== void 0) ?? peers[0];
	if (peer === void 0) return {
		reply: "⚠️ 无在线对端可同步。对端桥需运行且通过心跳互见。",
		resolved: false
	};
	let there = peer.manifest === void 0 ? null : {
		...peer.manifest,
		mtimeMs: peer.ts
	};
	if (there === null) {
		if (peer.port === void 0 || peer.token === void 0) return {
			reply: `⚠️ 对端 **${peer.profile}** 既无带内清单也未暴露 control API，无法同步。`,
			resolved: false
		};
		there = await fetchPeerManifest(peer.port, peer.token);
	}
	if (there === null) return {
		reply: `⚠️ 对端 **${peer.profile}** 的 control API 不可达（:${peer.port}）。`,
		resolved: false
	};
	const here = await readProfileManifest(ctx.harnessHome ?? defaultHarnessHome(), ctx.profile);
	if (here === null) return {
		reply: `⚠️ 本端 profile \`${ctx.profile}\` 的 package.json 不存在于 ${ctx.harnessHome ?? "~/.dsh"}。`,
		resolved: false
	};
	const plan = buildSyncPlan(here, there);
	if (plan.steps.length === 0) return {
		reply: `✅ 与 **${peer.profile}** 的插件清单已一致（共享 ${plan.inSync.length} 个包）。`,
		resolved: true
	};
	const stepRows = plan.steps.map((step) => step.kind === "add" ? `- 安装 \`${step.spec}\`（\`${step.command}\`）` : `- 启用 bundle \`${step.bundle}\`（已装未启用——需人工确认）`);
	if (!apply) return {
		reply: [
			`**同步预览（dry-run）**：从 **${peer.profile}** 采纳 ${plan.steps.length} 项变更：`,
			...stepRows,
			"",
			`确认执行请发：\`/bot sync-plugins apply\``
		].join("\n"),
		resolved: true
	};
	const result = await applySyncPlan(plan, ctx.runCommand ?? defaultRunner);
	return {
		reply: [
			`**同步执行完毕**：成功 ${result.ran.length}，跳过 ${result.skipped.length}，失败 ${result.failures.length}`,
			...result.ran.map((s) => `✅ ${s.spec}`),
			...result.skipped.map((s) => `⏸ \`${s.bundle}\`（已装未启用，请人工确认）`),
			...result.failures.map((f) => `⚠️ ${f.step.spec}：${f.error}`)
		].join("\n"),
		resolved: true
	};
}
/**
* `/bot export [include-secrets]` — collect the movable state (shared
* settings + per-profile plugin lists) into a single JSON file in the sync
* directory. Credentials are masked unless explicitly included; live state
* (peers, tokens, node_modules) never enters the document by construction.
*/
async function exportReply(ctx, rest) {
	const includeSecrets = rest.includes("include-secrets");
	const harnessHome = ctx.harnessHome ?? defaultHarnessHome();
	const file = await buildMigration(ctx.home, harnessHome, ctx.profile, ctx.form, { includeSecrets });
	const target = resolveMigrationFile("migrate.json", ctx.home);
	await fsp.writeFile(target, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	const profileRows = Object.entries(file.profiles).map(([name, p]) => `- profile \`${name}\`：${Object.keys(p.dependencies).length} 个包，${p.bundles.length} 个 bundle`);
	return {
		reply: [
			`**迁移文件已导出**：\`${target}\``,
			`- 共享设置 ${Object.keys(file.settings).length} 个键${includeSecrets ? "" : "（凭证已掩码）"}`,
			...profileRows,
			"",
			includeSecrets ? "⚠️ 此文件**含明文凭证**——只经可信渠道带到新机，导入后建议删除。" : "导入端需重新 `/bot set appSecret <值>`（掩码值不会被导入）。",
			"会话历史在 `~/.dsh`（上游管理）——整目录拷贝即可带走，本文件不含。"
		].join("\n"),
		resolved: true
	};
}
/**
* `/bot import [file] [apply]` — restore from a migration file. Preview by
* default (settings to write + plugin plan + cross-host double-delivery
* warning); `apply` executes. Masked secret values are never written — the
* operator re-enters them via `/bot set`.
*/
async function importReply(ctx, rest) {
	const apply = rest.includes("apply");
	const nameArg = rest.find((token) => token !== "apply");
	let file;
	try {
		file = await readMigration(nameArg, ctx.home);
	} catch (error) {
		return {
			reply: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
			resolved: false
		};
	}
	const warning = crossHostWarning(file);
	const writable = {};
	const reenter = [];
	for (const [key, value] of Object.entries(file.settings)) {
		if (SECRET_KEYS.includes(key) && typeof value === "string" && value.startsWith("****")) {
			reenter.push(key);
			continue;
		}
		writable[key] = value;
	}
	const harnessHome = ctx.harnessHome ?? defaultHarnessHome();
	const plans = [];
	for (const [profile, traveled] of Object.entries(file.profiles)) {
		const local = await readProfileManifest(harnessHome, profile);
		plans.push({
			profile,
			plan: buildImportPlan(local, profile, traveled)
		});
	}
	const totalSteps = plans.reduce((sum, entry) => sum + entry.plan.steps.length, 0);
	if (!apply) {
		const settingRows = Object.keys(writable).map((key) => `- \`${key}\``);
		const planRows = plans.flatMap(({ profile, plan }) => plan.steps.map((step) => step.kind === "add" ? `- 安装 \`${profile}\` ← ${step.spec}` : `- 启用 bundle \`${profile}\` ← ${step.bundle}`));
		return {
			reply: [
				`**导入预览**（来自 **${file.from.host}** · ${file.exportedAt}）：`,
				`- 将写入共享设置：${settingRows.length === 0 ? "（无）" : ""}`,
				...settingRows,
				...planRows,
				...reenter.length > 0 ? [`- ⚠️ 凭证已掩码，导入后需重设：${reenter.map((key) => `\`${key}\``).join("、")}`] : [],
				...totalSteps === 0 && settingRows.length === 0 ? ["- 本机已是目标状态，无需变更"] : [],
				...warning !== null ? ["", warning] : [],
				"",
				`确认执行请发：\`/bot import apply${nameArg !== void 0 && nameArg !== "" ? ` ${nameArg}` : ""}\``
			].join("\n"),
			resolved: true
		};
	}
	if (Object.keys(writable).length > 0) await updateSettings(ctx.home, (current) => ({
		...current,
		...writable
	}));
	const runner = ctx.runCommand ?? defaultRunner;
	const lines = [`**导入执行完毕**（来自 **${file.from.host}**）：`];
	lines.push(`- ✅ 共享设置写入 ${Object.keys(writable).length} 个键`);
	for (const { profile, plan } of plans) {
		if (plan.steps.length === 0) {
			lines.push(`- ✅ profile \`${profile}\`：插件清单已一致`);
			continue;
		}
		const result = await applySyncPlan(plan, runner);
		lines.push(`- profile \`${profile}\`：成功 ${result.ran.length}，失败 ${result.failures.length}`);
		for (const step of result.ran) lines.push(`  - ✅ ${step.spec}`);
		for (const failure of result.failures) lines.push(`  - ⚠️ ${failure.step.spec}：${failure.error}`);
	}
	if (reenter.length > 0) lines.push(`- ⚠️ 请补录凭证：${reenter.map((key) => `\`/bot set ${key} <值>\``).join("、")}`);
	if (warning !== null) lines.push("", warning);
	return {
		reply: lines.join("\n"),
		resolved: true
	};
}
function isSharedKey(key) {
	return SHARED_KEYS.includes(key);
}
function syncDirHint() {
	return "`~/.dsh/dsh-lark-bridge/settings.json`";
}
function defaultHarnessHome() {
	return process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
}
/** Production runner: upstream CLI, 2-minute ceiling per package. */
const defaultRunner = (command) => new Promise((resolve, reject) => {
	exec(command, { timeout: 12e4 }, (error) => {
		if (error !== null) reject(error);
		else resolve();
	});
});
//#endregion
//#region lib/types/commands.js
/**
* Slash commands in a chat. A line beginning with `/` is a control, not a
* prompt: the host runs it WITHOUT a model turn, so routing it here is what
* keeps a `/clear` from reaching the model as prose for it to improvise on.
*
* Two commands are the channel's own rather than the host's. `/stop` cancels
* the running turn — cancellation is an agent method, not a registered command
* — and `/help` lists what this chat accepts, which no host command provides.
* @module dsh-lark-bridge/commands
*/
/** Cancel the running turn. Not a host command: cancellation is an agent method. */
const STOP_COMMAND = "stop";
/**
* Restart the host process from the chat. Only registered when the deployment
* configures {@link Config.restartCommand} — restarting a process is a
* deployment concern (systemd unit name, container runtime, process manager),
* so the bridge ships the command shape and the deployment supplies the how.
* The command runs detached after a short delay: the reply must reach the
* chat before the process that would send it goes away.
*/
const RESTART_COMMAND = "restart";
/**
* Fires the configured restart shell in a detached child that outlives this
* process, after a delay long enough for the command's reply to reach the
* chat. Exported for tests to stub; production always spawns `/bin/sh`.
*/
let scheduleRestart = (shell) => {
	import("node:child_process").then(({ spawn }) => {
		spawn("/bin/sh", ["-c", `sleep 2.5 && ${shell}`], {
			detached: true,
			stdio: "ignore"
		}).unref();
	});
};
/** List what this chat accepts. Not a host command: the list is per surface. */
const HELP_COMMAND = "help";
/** Switch the agent's preset (standard / code / minimal / cordis). */
const PRESET_COMMAND = "preset";
/** List this chat's stored sessions. */
const SESSIONS_COMMAND = "sessions";
/** View or toggle the chat's denied tools at runtime. */
const TOOLS_COMMAND = "tools";
/** List the chat's active schedules (reminders). */
const SCHEDULES_COMMAND = "schedules";
/** List this session's background jobs. */
const JOBS_COMMAND = "jobs";
/** Rate the chat's most recent assistant answer. */
const FEEDBACK_COMMAND = "feedback";
/** Show the session's current context pressure. */
const CONTEXT_COMMAND = "context";
/** Show the session's operation audit summary. */
const AUDIT_COMMAND = "audit";
/** List / inspect the workspace's discoverable skills. */
const SKILLS_COMMAND = "skills";
/** Show the chat bridge's live configuration. */
const CONFIG_COMMAND = "config";
/** View or switch the deployment's default model. */
const MODEL_COMMAND = "model";
/** List the deployed plugin tree with live status (the chat face of the web inventory). */
const PLUGINS_COMMAND = "plugins";
/** The session id prefix this channel owns. */
const SESSION_PREFIX$1 = "feishu-";
/** The four shipped preset ids, for the listing and for argument validation. */
const SHIPPED_PRESET_IDS = [
	"standard",
	"code",
	"minimal",
	"cordis"
];
/** Human names for the shipped presets, matching the deployment's preset.yml. */
const PRESET_NAMES = {
	standard: "标准模式",
	code: "PTC 模式",
	minimal: "极简模式",
	cordis: "创造模式"
};
/** Display names for presets not in the shipped set fall back to the id. */
function presetDisplayName(preset) {
	return preset.name ?? PRESET_NAMES[preset.id] ?? preset.id;
}
/** The cause recorded when a chat cancels its own turn. */
const CANCEL_CAUSE = "user";
/** Leading slash plus the command name, the only part this module parses. */
const COMMAND_LINE = /^\/([a-zA-Z][\w-]*)/;
/**
* The command one line names, if it names one.
* @param text - the message text exactly as received.
* @returns the lowercase name without its slash, or undefined for prose.
*/
function commandName(text) {
	return COMMAND_LINE.exec(text.trimStart())?.[1]?.toLowerCase();
}
/**
* Whether one inbound line addresses the channel as a command.
* @param text - the message text exactly as received.
* @returns whether it opens with a slash and names something.
*/
function isCommandLine(text) {
	return commandName(text) !== void 0;
}
/**
* Render the help listing for one agent's available commands.
* @param commands - the host command runtime, when composed.
* @param agent - the agent whose scope decides what is available.
* @returns the markdown listing.
*/
/**
* The `/help` listing, in the bridge's resolved language.
* @param commands - the host command runtime, when composed.
* @param agent - the agent whose scope decides what is available.
* @param locale - the resolved display language.
* @returns the markdown listing.
*/
function helpText(commands, agent, locale = "zh", config) {
	const own = [
		`\`/${STOP_COMMAND}\` — ${describeCommand(STOP_COMMAND, locale, "Stop the current task")}`,
		...config?.restartCommand ? [`\`/${RESTART_COMMAND}\` — ${describeCommand(RESTART_COMMAND, locale, "Restart the host process")}`] : [],
		`\`/${PRESET_COMMAND}\` — ${describeCommand(PRESET_COMMAND, locale, "View or switch mode")}`,
		`\`/${SESSIONS_COMMAND}\` — ${describeCommand(SESSIONS_COMMAND, locale, "View session history")}`,
		`\`/${TOOLS_COMMAND}\` — ${describeCommand(TOOLS_COMMAND, locale, "View, deny, or allow tools")}`,
		`\`/${SCHEDULES_COMMAND}\` — ${describeCommand(SCHEDULES_COMMAND, locale, "View scheduled reminders")}`,
		`\`/${JOBS_COMMAND}\` — ${describeCommand(JOBS_COMMAND, locale, "View background jobs")}`,
		`\`/${CONTEXT_COMMAND}\` — ${describeCommand(CONTEXT_COMMAND, locale, "View context pressure")}`,
		`\`/${SKILLS_COMMAND}\` — ${describeCommand(SKILLS_COMMAND, locale, "List / inspect discoverable skills")}`,
		`\`/${MODEL_COMMAND}\` — ${describeCommand(MODEL_COMMAND, locale, "View or switch the default model")}`,
		`\`/bot\` — ${describeCommand("bot", locale, "Bridge dual-end status, settings, plugin sync")}`,
		`\`/ws\` — ${describeCommand("ws", locale, "List registered workspaces")}`,
		`\`/${PLUGINS_COMMAND}\` — ${describeCommand(PLUGINS_COMMAND, locale, "List deployed plugins and status")}`,
		`\`/${AUDIT_COMMAND}\` — ${describeCommand(AUDIT_COMMAND, locale, "View operation audit")}`,
		`\`/${CONFIG_COMMAND}\` — ${describeCommand(CONFIG_COMMAND, locale, "View current configuration")}`,
		`\`/${HELP_COMMAND}\` — ${describeCommand(HELP_COMMAND, locale, "Show available commands")}`
	];
	const hosted = (commands?.list(agent) ?? []).map((descriptor) => `\`/${descriptor.name}\` — ${describeCommand(descriptor.name, locale, descriptor.description)}`);
	return [
		helpHeading(locale),
		...hosted,
		...own
	].join("\n");
}
/**
* Run one command line for a chat's agent.
*
* `/stop`, `/preset`, and `/help` are answered here; everything else goes to
* the host runtime, whose `undefined` means the name never resolved — reported
* as such with the listing, because silently feeding a typo to the model is
* how `/stop` became a message the bot ignored.
* @param line - the complete line, leading slash included.
* @param agent - the chat's agent.
* @param commands - the host command runtime, when composed.
* @param signal - cancellation for the host execution.
* @param presets - the agent-preset roster, when composed (for `/preset`).
* @param persistence - the session store, when composed (for `/sessions`).
* @param chatId - the conversation facet key this chat's sessions belong to.
* @param deniedTools - the live denied-tool set (for `/tools`).
* @param schedules - live schedule registry by session id (for `/schedules`).
* @param audits - live audit counters by session id (for `/audit`).
* @param config - the bridge's live configuration (for `/config`).
* @param sessionPresets - per-session preset choices (for `/preset` persistence).
* @returns what to report to the chat.
*/
async function runCommandLine(line, agent, commands, signal, presets = void 0, persistence = void 0, chatId = void 0, deniedTools = void 0, schedules = void 0, audits = void 0, config = void 0, sessionPresets = void 0, sessionQuery = void 0, jobs = void 0, feedback = void 0, lastAssistantMessageId = void 0, tokenMeter = void 0, skills = void 0, defaultModel = void 0, configModel = void 0, workspaces = void 0, currentCwd = void 0, loaderEntries = void 0, sync = void 0) {
	const trimmed = line.trimStart();
	const name = commandName(trimmed) ?? "";
	if (name === "stop") {
		agent.cancel(CANCEL_CAUSE);
		return {
			reply: "⏹ 已停止当前任务。",
			resolved: true
		};
	}
	if (name === "restart") {
		const shell = config?.restartCommand;
		if (shell === void 0 || shell === "") return {
			reply: "⚠️ 未配置 restartCommand，/restart 不可用。",
			resolved: true
		};
		scheduleRestart(shell);
		return {
			reply: "🔁 重启已排程，服务将在数秒后重启并自动恢复。",
			resolved: true
		};
	}
	if (name === "preset") return runPresetCommand(trimmed, agent, presets, sessionPresets);
	if (name === "sessions") return runSessionsCommand(agent, persistence, chatId, trimmed.slice(9).trim(), sessionQuery);
	if (name === "jobs") return runJobsCommand(agent, jobs);
	if (name === "feedback") return runFeedbackCommand(trimmed, agent, feedback, lastAssistantMessageId);
	if (name === "context") return runContextCommand(agent, tokenMeter);
	if (name === "tools") return runToolsCommand(trimmed, deniedTools);
	if (name === "schedules") return runSchedulesCommand(agent, schedules);
	if (name === "audit") return runAuditCommand(agent, audits);
	if (name === "skills") return runSkillsCommand(trimmed, skills);
	if (name === "bot") {
		if (sync === void 0) return {
			reply: "⚠️ 本部署未启用双端同步（缺少 sync 上下文）。",
			resolved: false
		};
		return runBotCommand(trimmed, sync);
	}
	if (name === "model") return runModelCommand(trimmed, defaultModel, configModel, config?.modelCatalog);
	if (name === "ws") return runWsCommand(workspaces, currentCwd);
	if (name === "plugins") return runPluginsCommand(loaderEntries);
	if (name === "config") return runConfigCommand(config);
	if (name === "help") return {
		reply: helpText(commands, agent, config?.locale ?? "zh", config),
		resolved: true
	};
	if (commands === void 0) return {
		reply: `⚠️ 本部署没有组合命令运行时，\`/${name}\` 无法执行。`,
		resolved: false
	};
	const execution = await commands.execute(agent, trimmed, signal);
	if (execution === void 0) return {
		reply: `⚠️ 未知命令 \`/${name}\`。\n\n${helpText(commands, agent, config?.locale ?? "zh")}`,
		resolved: false
	};
	const { result } = execution;
	if (result.kind === "error") return {
		reply: `⚠️ \`/${name}\` 执行失败：${result.text}`,
		resolved: true
	};
	if (name === "permission" && result.kind === "success" && typeof result.text === "string") {
		if (result.text.includes("danger-full-access")) return {
			reply: `${result.text}\n\n💡 已放开沙箱：terminal_* 等需要完整执行环境的工具现在可用（审批不再逐次询问）。`,
			resolved: true
		};
		if (result.text.includes("workspace-write")) return {
			reply: `${result.text}\n\n💡 已收紧到工作区写入：terminal_* 工具在此模式下会被拒绝（无审批通道时）。需要持久终端请再切 \`/permission danger-full-access\`。`,
			resolved: true
		};
	}
	return {
		reply: result.text ?? "",
		resolved: true
	};
}
/** The agent's scoped Cordis context, when the host agent exposes one. */
function agentScope(agent) {
	return agent.ctx;
}
/**
* Handle `/sessions`: list the stored sessions that belong to this chat.
* @param agent - the chat's agent (marks the current session).
* @param persistence - the session store, when composed.
* @param chatId - the conversation facet key; undefined lists nothing.
* @returns the reply for the chat.
*/
async function runSessionsCommand(agent, persistence, chatId, query = "", sessionQuery = void 0) {
	if (chatId === void 0) return {
		reply: "⚠️ 无法确定当前聊天。",
		resolved: false
	};
	if (query !== "") {
		if (sessionQuery === void 0) return {
			reply: `⚠️ 本部署没有组合全文检索，\`/${SESSIONS_COMMAND} <关键词>\` 不可用；不带关键词可查看历史列表。`,
			resolved: false
		};
		const owned = (await sessionQuery.searchSessions({
			query,
			limit: 8
		})).items.filter((hit) => hit.session.id.startsWith(`${SESSION_PREFIX$1}${chatId}`));
		if (owned.length === 0) return {
			reply: `**会话检索**\n没有找到与「${query}」匹配的本聊天记录。`,
			resolved: true
		};
		const rows = owned.map((hit) => {
			return `· ${hit.session.createdAt === void 0 ? "" : `${new Date(hit.session.createdAt).toLocaleString("zh-CN", { hour12: false })} `}${hit.session.id === agent.session.id ? " ← 当前" : ""}「${hit.bestMatch.snippet.length <= 60 ? hit.bestMatch.snippet : `${hit.bestMatch.snippet.slice(0, 59)}…`}」`;
		});
		return {
			reply: `**会话检索**（${owned.length} 条匹配）\n${rows.join("\n")}`,
			resolved: true
		};
	}
	if (persistence === void 0) return {
		reply: `⚠️ 本部署没有组合会话存储，\`/${SESSIONS_COMMAND}\` 不可用。`,
		resolved: false
	};
	const owned = (await persistence.list()).filter((header) => header.id.startsWith(`${SESSION_PREFIX$1}${chatId}`)).sort((a, b) => b.createdAt - a.createdAt);
	if (owned.length === 0) return {
		reply: "**会话历史**\n还没有本聊天的已保存会话。",
		resolved: true
	};
	const rows = owned.map((header) => {
		const when = new Date(header.createdAt).toLocaleString("zh-CN", { hour12: false });
		const mark = header.id === agent.session.id ? " ← 当前" : "";
		const facet = header.id.slice(`${SESSION_PREFIX$1}${chatId}`.length).replace(/^:/, "");
		return `· ${when}${mark}${facet === "" ? "" : `（${facet === header.id ? "其他" : facet}）`}`;
	});
	return {
		reply: `**会话历史**（${owned.length} 个）\n${rows.join("\n")}\n\n发消息即继续最近的会话；\`/new\` 开新会话。`,
		resolved: true
	};
}
/**
* Handle `/config`: show the bridge's live configuration, credentials redacted.
* @param config - the bridge's resolved configuration.
* @returns the reply for the chat.
*/
function runConfigCommand(config) {
	if (config === void 0) return {
		reply: `⚠️ 本部署没有提供配置快照，\`/${CONFIG_COMMAND}\` 不可用。`,
		resolved: false
	};
	const on = (value) => value ? "开" : "关";
	return {
		reply: `**当前配置**\n${[
			config.provider !== void 0 || config.model !== void 0 ? `· 模型：${config.provider ?? "默认"} / ${config.model ?? "默认"}` : "· 模型：宿主默认",
			config.preset !== void 0 ? `· 模式：${config.preset}` : "· 模式：agent-presets 默认",
			`· 语言：${config.locale === "en" ? "English" : "简体中文"}`,
			`· 输出：${config.output === "cot" ? "思考过程（cot）" : "流式卡片"}`,
			`· 会话维度：${config.sessionScope}`,
			`· 显示过程：${on(config.showProcess)}${config.hideProcessWhenDone ? "（完成后隐藏）" : ""}`,
			`· 图片传递：${on(config.attachImages)}`,
			`· 首次引导：${on(config.onboarding)}`,
			`· 同步面板：${on(config.syncSlashCommands)}`,
			`· 群内@才回应：${on(config.requireMention)}`,
			`· 反应反馈：${on(config.reactionFeedback)}`,
			`· 自动恢复目标：${on(config.autoResumeGoals)}`,
			`· 审批提醒：${config.approvalReminderMs > 0 ? `${config.approvalReminderMs / 1e3}s` : "关"}`,
			config.denyTools.length > 0 ? `· 禁用工具：${config.denyTools.join(", ")}` : "· 禁用工具：无",
			config.senderAllowlist.length > 0 ? `· 发送者白名单：${config.senderAllowlist.join(", ")}` : "· 发送者白名单：开放",
			config.groupAllowlist.length > 0 ? `· 群白名单：${config.groupAllowlist.join(", ")}` : "· 群白名单：开放",
			config.approvers.length > 0 ? `· 审批人：${config.approvers.join(", ")}` : "· 审批人：对话可答"
		].join("\n")}\n\n改配置：编辑 profile 的 cordis.patch.yml，保存后 HMR 自动生效（无需重启桥）。`,
		resolved: true
	};
}
/**
* Handle `/audit`: show the session's operation counters.
* @param agent - the chat's agent (its session id keys the counters).
* @param audits - live audit counters by session id.
* @returns the reply for the chat.
*/
function runAuditCommand(agent, audits) {
	if (audits === void 0) return {
		reply: `⚠️ 本部署没有启用审计统计，\`/${AUDIT_COMMAND}\` 不可用。`,
		resolved: false
	};
	const stats = audits.get(agent.session.id);
	if (stats === void 0) return {
		reply: "**操作审计**\n本会话尚无操作记录（进程内统计从桥启动后开始）。",
		resolved: true
	};
	const since = new Date(stats.startedAt).toLocaleString("zh-CN", { hour12: false });
	const errorRate = stats.turns > 0 ? `${Math.round(stats.turnErrors / stats.turns * 100)}%` : "0%";
	return {
		reply: `**操作审计**（自 ${since} 起）\n${[
			`· 轮次：${stats.turns}（出错 ${stats.turnErrors}，${errorRate}）`,
			`· 步骤：${stats.steps}`,
			`· 工具调用：${stats.toolCalls}`,
			`· 上下文压缩：${stats.compactions}`,
			`· 模型重试：${stats.retries}`,
			`· 子代理：${stats.subagents}`,
			`· 工作流：${stats.workflows}`,
			`· 定时提醒：${stats.schedules}`
		].join("\n")}`,
		resolved: true
	};
}
/**
* Handle `/schedules`: list the chat's active reminders.
* @param agent - the chat's agent (its session id keys the registry).
* @param schedules - live schedule registry by session id.
* @returns the reply for the chat.
*/
/**
* Handle `/jobs`: list this session's background jobs, active first.
* @param agent - the chat's agent (fences job ownership).
* @param jobs - the background-job registry, when composed.
* @returns the reply for the chat.
*/
function runJobsCommand(agent, jobs) {
	if (jobs === void 0) return {
		reply: `⚠️ 本部署没有组合后台任务运行时，\`/${JOBS_COMMAND}\` 不可用。`,
		resolved: false
	};
	const snapshots = jobs.list(agent);
	if (snapshots.length === 0) return {
		reply: `**后台任务**\n当前没有任务。让 agent 用 \`run_in_background\` 起一个（如"后台跑构建，完成后告诉我"）。`,
		resolved: true
	};
	const row = (job) => {
		const mark = job.status === "running" ? "🔵" : job.status === "stopping" ? "⏸️" : job.status === "completed" ? "✅" : job.status === "killed" ? "⏹️" : "❌";
		const detail = job.detail === void 0 ? "" : `（${job.detail}）`;
		const when = new Date(job.startedAt).toLocaleTimeString("zh-CN", { hour12: false });
		return `· ${mark} ${job.label}${detail} [${job.id}] ${when}`;
	};
	const active = snapshots.filter((s) => s.status === "running" || s.status === "stopping");
	const done = snapshots.filter((s) => s.status !== "running" && s.status !== "stopping");
	const lines = [...active.map(row), ...done.map(row)];
	return {
		reply: `**后台任务**（${snapshots.length} 个，${active.length} 活动）\n${lines.join("\n")}`,
		resolved: true
	};
}
/**
* Handle `/skills [name]`: list the workspace's discoverable skills, or show
* one skill's body when named. This is the Feishu surface of the dsh skill
* ecosystem — a chat user can see what skills are installed and peek at one
* without leaving the conversation.
* @param line - the trimmed command line.
* @param skills - the host skill registry, when composed.
* @returns the reply for the chat.
*/
async function runSkillsCommand(line, skills) {
	if (skills === void 0) return {
		reply: `⚠️ 本部署没有组合 skill 注册表，\`/${SKILLS_COMMAND}\` 不可用。`,
		resolved: false
	};
	const query = line.slice(7).trim();
	if (query.length > 0) {
		const skill = await skills.get(query);
		if (skill === void 0) return {
			reply: `⚠️ 找不到 skill \`${query}\`。用 \`/${SKILLS_COMMAND}\` 查看全部可用 skill。`,
			resolved: true
		};
		const body = skill.body.trim();
		return {
			reply: `**Skill · ${query}**\n\n${body.length > 800 ? `${body.slice(0, 800)}\n…（截断）` : body}`,
			resolved: true
		};
	}
	const summaries = await skills.list();
	if (summaries.length === 0) return {
		reply: `**可用的 skills**\n当前工作区没有发现 skill。部署方可以注入 skill provider（如 \`@deepseek-ai/dsh-skill-filesystem\`）。`,
		resolved: true
	};
	const row = (s) => `· \`${s.name}\` — ${s.description}${s.source === void 0 ? "" : `（${s.source}）`}`;
	const lines = summaries.map(row);
	return {
		reply: `**可用的 skills**（${summaries.length} 个）\n${lines.join("\n")}\n\n查看某个：\`/${SKILLS_COMMAND} <name>\``,
		resolved: true
	};
}
/**
* Handle `/plugins`: list the deployed Loader tree with live status — the chat
* face of the web Settings' read-only inventory. The bridge reads the same
* Cordis loader entries the web's pluginInventory remote projects, so the two
* surfaces agree by construction. Read-only: installing or removing plugins
* stays a CLI operation (`dsh plugin add/remove`), because the loader tree is
* fixed at boot and mutating it from chat would lie about what is running.
* @param loaderEntries - the host context's loader entries, when reachable.
* @returns the reply for the chat.
*/
function runPluginsCommand(loaderEntries) {
	if (loaderEntries === void 0) return {
		reply: `⚠️ 本部署拿不到插件清单（loader 不可达）。安装/卸载请用宿主 CLI：\`dsh plugin --profile <name> add <package>\`。`,
		resolved: false
	};
	const FIBER_ACTIVE = 2;
	const rows = loaderEntries.filter((entry) => entry.options.name !== void 0).map((entry) => {
		const name = entry.options.name ?? "";
		if (entry.disabled) return `· ${name} — ⏸ 已禁用`;
		if (entry.fiber === void 0) return `· ${name} — ⚠ 未挂载`;
		if (entry.fiber.state === FIBER_ACTIVE) return `· ${name}`;
		return `· ${name} — ❌ 异常(state=${entry.fiber.state})`;
	});
	if (rows.length === 0) return {
		reply: "**已部署插件**：（清单为空）",
		resolved: true
	};
	return {
		reply: `**已部署插件**（${rows.filter((row) => !row.includes("—")).length}/${rows.length} 运行中）\n${rows.join("\n")}\n\n安装新插件请在部署机执行 \`dsh plugin --profile <name> add <npm包或github:repo>\`，重启后生效。`,
		resolved: true
	};
}
/**
* Handle `/ws`: list the registry's workspaces with the chat's current
* workspace marked. Read-only — the chat drives one configured cwd, so unlike
* the PC UI there is nothing to switch here; the listing shows what exists and
* where new chats land. The registry is optional: a deployment without it (no
* workspace plugin composed) gets a clear refusal instead of a fake answer.
* @param workspaces - the host workspace-registry service, when composed.
* @param currentCwd - the deployment's chat cwd (the directory new sessions use).
* @returns the reply for the chat.
*/
function runWsCommand(workspaces, currentCwd) {
	if (workspaces?.list === void 0) return {
		reply: `⚠️ 本部署没有组合 workspace 插件，\`/ws\` 不可用。`,
		resolved: false
	};
	const rows = workspaces.list().map((w) => {
		const mark = currentCwd !== void 0 && w.path === currentCwd ? " ← 当前" : "";
		const title = w.id === w.path || !w.id ? "" : `（${w.id}）`;
		return `· \`${w.path}\`${title}${mark}`;
	});
	if (rows.length === 0) return {
		reply: `**工作区**：注册表为空。新会话将使用部署目录${currentCwd === void 0 ? "" : ` \`${currentCwd}\``}（首次使用时自动注册）。`,
		resolved: true
	};
	const tail = currentCwd === void 0 ? "" : `\n\n新会话工作目录：\`${currentCwd}\`（由部署配置 \`cwd\` 决定；改目录请编辑 cordis.patch.yml 后重启）。`;
	return {
		reply: `**已注册的工作区**\n${rows.join("\n")}${tail}`,
		resolved: true
	};
}
/**
* Handle `/model [provider/model]`: show the current default model, or switch
* it. The switch goes through the host `agentDefaultModel.saveSelection` seam,
* so a deployment with a settings provider persists the choice across
* restarts; without one, the change is process-local. A deployment that pins
* `provider`/`model` in the bridge config overrides everything — switching is
* refused there because the config would win on the next agent anyway.
* @param line - the trimmed command line.
* @param defaultModel - the host agent-default-model service, when composed.
* @param configModel - the bridge config's own provider/model override, when set.
* @returns the reply for the chat.
*/
async function runModelCommand(line, defaultModel, configModel, catalog) {
	if (configModel?.provider !== void 0 || configModel?.model !== void 0) {}
	if (defaultModel === void 0) return {
		reply: `⚠️ 本部署没有组合 agent-default-model 服务，\`/${MODEL_COMMAND}\` 不可用。`,
		resolved: false
	};
	const arg = line.slice(6).trim();
	if (arg.length === 0) {
		const cur = defaultModel.currentSelection();
		const current = `${cur.provider}/${cur.model}`;
		const effort = "reasoningEffort" in cur && typeof cur.reasoningEffort === "string" ? `（推理强度 ${cur.reasoningEffort}）` : "";
		if (catalog && catalog.length > 0) return {
			reply: `**可选模型**（当前：${current}${effort}）\n${catalog.map((m, i) => {
				const mark = m === cur.model || `${cur.provider}/${m}` === current ? " ← 当前" : "";
				return `${i + 1}. ${m}${mark}`;
			}).join("\n")}\n\n回复编号即可切换`,
			resolved: true
		};
		return {
			reply: `**当前默认模型**：\`${current}\`${effort}\n\n切换：\`/${MODEL_COMMAND} <provider>/<model>\``,
			resolved: true
		};
	}
	if (catalog && catalog.length > 0 && /^\d+$/.test(arg)) {
		const idx = parseInt(arg, 10) - 1;
		if (idx < 0 || idx >= catalog.length) return {
			reply: `⚠️ 编号超范围（1-${catalog.length}）。`,
			resolved: false
		};
		const sel = catalog[idx] ?? "";
		const sl = sel.indexOf("/");
		const sp = sl > 0 ? sel.slice(0, sl).trim() : configModel?.provider ?? "";
		const sm = sl > 0 ? sel.slice(sl + 1).trim() : sel;
		if (defaultModel.saveSelection === void 0) return {
			reply: "⚠️ 无 settings 层。",
			resolved: false
		};
		await defaultModel.saveSelection({
			provider: sp,
			model: sm
		});
		return {
			reply: `✅ 已切换为 **${sel}**`,
			resolved: true
		};
	}
	const slash = arg.indexOf("/");
	if (slash <= 0 || slash === arg.length - 1) return {
		reply: `⚠️ 格式：\`/${MODEL_COMMAND} <provider>/<model>\`，例如 \`/${MODEL_COMMAND} deepseek-official/deepseek-v4\`。`,
		resolved: false
	};
	const provider = arg.slice(0, slash).trim();
	const model = arg.slice(slash + 1).trim();
	if (defaultModel.saveSelection === void 0) return {
		reply: `⚠️ 本部署没有 settings 持久化层，切换无法保存。请在部署配置（cordis.patch.yml 的 agent-default-model）里改。`,
		resolved: false
	};
	try {
		await defaultModel.saveSelection({
			provider,
			model
		});
		return {
			reply: `✅ 默认模型已切换为 \`${provider}/${model}\`。对之后**新建**的会话生效；进行中的会话保持原模型（发 \`/new\` 开新会话即用新模型）。`,
			resolved: true
		};
	} catch (error) {
		return {
			reply: `⚠️ 切换失败：${error instanceof Error ? error.message : String(error)}`,
			resolved: true
		};
	}
}
/**
* Handle `/feedback <positive|negative> [note]`: rate the chat's most recent
* assistant answer through the host message-feedback seam.
* @param line - the trimmed command line.
* @param agent - the chat's agent (owns the session being rated).
* @param feedback - the message-feedback service, when composed.
* @param lastAssistantMessageId - the most recent assistant message id, or
*   undefined when the session has produced no answer yet.
* @returns the reply for the chat.
*/
async function runFeedbackCommand(line, agent, feedback, lastAssistantMessageId) {
	if (feedback === void 0) return {
		reply: `⚠️ 本部署没有组合反馈服务，\`/${FEEDBACK_COMMAND}\` 不可用。`,
		resolved: false
	};
	if (lastAssistantMessageId === void 0) return {
		reply: "⚠️ 还没有可评分的回答。先让 agent 回答一条，再给这条回答评分。",
		resolved: false
	};
	const args = line.slice(`/${FEEDBACK_COMMAND}`.length).trim().split(/\s+/).filter((a) => a !== "");
	const rating = args[0]?.toLowerCase();
	if (rating !== "positive" && rating !== "negative") return {
		reply: `用法：\`/${FEEDBACK_COMMAND} positive|negative [备注]\`（给上一条回答评分）。`,
		resolved: false
	};
	const note = args.slice(1).join(" ").trim();
	const result = await feedback.put({
		sessionId: agent.session.id,
		messageId: lastAssistantMessageId,
		rating,
		...note === "" ? {} : { note },
		ifVersion: null
	});
	if (!result.ok) return {
		reply: `⚠️ 评分未记录（${result.error?.code ?? "unknown"}）。可能是这条回答已被清空或会话已归档。`,
		resolved: false
	};
	return {
		reply: `✅ 已记录本次评分（${rating === "positive" ? "👍 正面" : "👎 负面"}）${note === "" ? "" : `：${note}`}`,
		resolved: true
	};
}
/**
* Handle `/context`: show the session's current context token pressure.
* @param agent - the chat's agent (owns the measured session).
* @param tokenMeter - the token-meter service, when composed.
* @returns the reply for the chat.
*/
function runContextCommand(agent, tokenMeter) {
	if (tokenMeter === void 0) return {
		reply: `⚠️ 本部署没有组合 token 计量服务，\`/${CONTEXT_COMMAND}\` 不可用。`,
		resolved: false
	};
	const measure = tokenMeter.measure(agent.session);
	return {
		reply: `**上下文压力**\n当前约 ${measure.totalTokens.toLocaleString("zh-CN")} tokens（会话表面 ${measure.surfaceTokens.toLocaleString("zh-CN")}）${measure.totalTokens > 12e4 ? "\n⚠️ 上下文已偏高，长任务建议先 `/compact` 压缩。" : measure.totalTokens > 6e4 ? "\n📈 上下文正在增长，超过 12 万 tokens 后建议压缩。" : ""}`,
		resolved: true
	};
}
function runSchedulesCommand(agent, schedules) {
	if (schedules === void 0) return {
		reply: `⚠️ 本部署没有启用定时提醒，\`/${SCHEDULES_COMMAND}\` 不可用。`,
		resolved: false
	};
	const entries = schedules.get(agent.session.id);
	if (entries === void 0 || entries.size === 0) return {
		reply: "**定时提醒**\n当前没有活跃的提醒。让 agent 设一个（例如\"10 分钟后提醒我\"）后再看。",
		resolved: true
	};
	const rows = [...entries.values()].map((entry) => {
		return `· [${entry.kind === "after" ? "延时" : entry.kind === "at" ? "定点" : `周期(${entry.everySeconds ?? "?"}s)`}] ${entry.prompt.length > 40 ? `${entry.prompt.slice(0, 40)}…` : entry.prompt}`;
	});
	return {
		reply: `**定时提醒**（${entries.size} 个活跃）\n${rows.join("\n")}`,
		resolved: true
	};
}
/**
* Handle `/tools`, `/tools deny <name>`, and `/tools allow <name>`.
* @param line - the trimmed command line.
* @param deniedTools - the live denied-tool set, when the bridge shares one.
* @returns the reply for the chat.
*/
function runToolsCommand(line, deniedTools) {
	const args = line.slice(`/${TOOLS_COMMAND}`.length).trim().split(/\s+/).filter((a) => a !== "");
	if (deniedTools === void 0) return {
		reply: `⚠️ 本部署没有运行时工具开关，\`/${TOOLS_COMMAND}\` 不可用。`,
		resolved: false
	};
	const action = args[0]?.toLowerCase();
	const tool = args[1]?.toLowerCase();
	if (action === "deny" && tool !== void 0) {
		if (deniedTools.has(tool)) return {
			reply: `\`${tool}\` 已在禁用列表。`,
			resolved: true
		};
		deniedTools.add(tool);
		return {
			reply: `⛔ 已禁用 \`${tool}\`。下次调用即被拦截。`,
			resolved: true
		};
	}
	if (action === "allow" && tool !== void 0) {
		if (!deniedTools.has(tool)) return {
			reply: `\`${tool}\` 不在禁用列表。`,
			resolved: true
		};
		deniedTools.delete(tool);
		return {
			reply: `✅ 已允许 \`${tool}\`。`,
			resolved: true
		};
	}
	const listed = [...deniedTools];
	return {
		reply: `**工具开关**\n${listed.length === 0 ? "当前没有禁用的工具。" : `当前禁用（${listed.length}）：\n${listed.map((t) => `· \`${t}\``).join("\n")}`}\n\n用法：\`/${TOOLS_COMMAND} deny <name>\` 禁用、\`/${TOOLS_COMMAND} allow <name>\` 恢复。`,
		resolved: true
	};
}
/**
* Handle `/preset` and `/preset <id>`.
* @param line - the trimmed command line (leading slash preserved).
* @param agent - the chat's agent.
* @param presets - the roster, when composed.
* @returns the reply for the chat.
*/
async function runPresetCommand(line, agent, presets, sessionPresets) {
	const unlisted = `⚠️ 本部署没有组合 agent-presets 服务，\`/${PRESET_COMMAND}\` 不可用。`;
	if (presets === void 0) return {
		reply: unlisted,
		resolved: false
	};
	const scope = agentScope(agent);
	if (scope === void 0) return {
		reply: "⚠️ 无法访问当前会话的配置上下文。",
		resolved: false
	};
	const current = presets.composedPreset(scope);
	const wanted = line.slice(`/${PRESET_COMMAND}`.length).trim().split(/\s+/)[0]?.toLowerCase();
	if (wanted === void 0 || wanted === "") {
		const rows = (await presets.list()).map((p) => {
			const label = presetDisplayName(p);
			const mark = p.id === current ? " ← 当前" : "";
			const broken = p.broken === void 0 ? "" : `（已损坏：${p.broken}）`;
			return `· \`${p.id}\` — ${label}${mark}${broken}`;
		}).join("\n");
		return {
			reply: `**模式选择**（${current ?? "未加入 preset"}）\n${rows}\n\n切换：\`/${PRESET_COMMAND} <id>\`（新会话才能切换）`,
			resolved: true
		};
	}
	if (!SHIPPED_PRESET_IDS.includes(wanted)) return {
		reply: `⚠️ 未知模式 \`${wanted}\`。可用：${SHIPPED_PRESET_IDS.join("、")}。`,
		resolved: false
	};
	if (current === wanted) return {
		reply: `当前已是 ${PRESET_NAMES[wanted] ?? wanted}（\`${wanted}\`）。`,
		resolved: true
	};
	try {
		await presets.recompose(scope, wanted);
		if (sessionPresets !== void 0) sessionPresets.set(agent.session.id, wanted);
		return {
			reply: `✅ 已切换到 ${PRESET_NAMES[wanted] ?? wanted}（\`${wanted}\`）。当前会话为空白会话，新工具集已生效。`,
			resolved: true
		};
	} catch (error) {
		return {
			reply: `⚠️ 切换失败：${error instanceof Error ? error.message : String(error)}\n\n已进行过对话的会话不能切换模式。发送 \`/new\` 开一个新会话（新会话使用所选模式）后即可生效。`,
			resolved: false
		};
	}
}
//#endregion
//#region lib/types/images.js
/**
* Images a chat message carried. Sending a screenshot is how someone shows a
* problem, so an image the model never receives is worse than a missing
* feature: the model answers as if it had seen one. Every image that cannot be
* attached therefore leaves a note in the text instead of disappearing.
* @module dsh-lark-bridge/images
*/
/**
* The media type to declare for stored bytes: the transport's own, when it
* names one the store accepts, else the file name's extension.
* @param contentType - transport-reported type, possibly parameterized.
* @param fileName - the sender's file name, when the message carried one.
* @param accepted - media types this deployment's store accepts.
* @returns the media type to declare, or undefined when nothing matches.
*/
function mediaTypeOf(contentType, fileName, accepted) {
	const declared = contentType?.split(";")[0]?.trim().toLowerCase();
	if (declared !== void 0 && accepted.includes(declared)) return declared;
	const extension = fileName?.toLowerCase().split(".").pop();
	const fromName = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === void 0 ? void 0 : `image/${extension}`;
	return fromName !== void 0 && accepted.includes(fromName) ? fromName : void 0;
}
/**
* Download and commit the images one message carried.
*
* Bounds come from the store rather than this plugin: it is the component that
* knows what a model request may carry. An image past them is skipped with a
* note, as is one whose type the store does not accept.
* @param msg - the inbound message.
* @param port - transport used to download the bytes.
* @param attachments - the attachment store, when composed.
* @param enabled - whether this deployment's route accepts images at all.
* @returns the blocks to attach and the notes to append to the text.
*/
async function collectImages(msg, port, attachments, enabled) {
	const images = msg.resources.filter((resource) => resource.type === "image");
	if (images.length === 0) return {
		blocks: [],
		notes: []
	};
	if (!enabled) return {
		blocks: [],
		notes: [`（用户发送了 ${images.length} 张图片，本渠道未向模型传递图片：attachImages 未开启）`]
	};
	if (attachments === void 0) return {
		blocks: [],
		notes: [`（用户发送了 ${images.length} 张图片，但本部署没有组合附件存储，模型看不到它们）`]
	};
	const limits = attachments.imageLimits;
	const blocks = [];
	const notes = [];
	let budget = limits.maxMessageImageBytes;
	for (const [index, image] of images.entries()) {
		if (index >= limits.maxImagesPerMessage) {
			notes.push(`（还有 ${images.length - index} 张图片超出单条消息上限，未附加）`);
			break;
		}
		try {
			const { buffer, contentType } = await port.downloadResourceWithMeta(msg.messageId, image.fileKey, "image");
			const mediaType = mediaTypeOf(contentType, image.fileName, limits.mediaTypes);
			if (mediaType === void 0) {
				notes.push(`（一张图片的格式 ${contentType ?? "未知"} 不被支持，未附加）`);
				continue;
			}
			if (buffer.byteLength > limits.maxImageBytes || buffer.byteLength > budget) {
				notes.push("（一张图片超出大小上限，未附加）");
				continue;
			}
			const ref = await attachments.saveImage({
				data: buffer,
				mediaType,
				...image.fileName === void 0 ? {} : { name: image.fileName }
			});
			budget -= buffer.byteLength;
			blocks.push({
				type: "image",
				attachment: ref
			});
		} catch (error) {
			notes.push(`（一张图片附加失败：${error instanceof Error ? error.message : String(error)}）`);
		}
	}
	return {
		blocks,
		notes
	};
}
//#endregion
//#region lib/types/files.js
/**
* File delivery: the `send_file` tool the bridge registers on every chat
* agent, and the delivery helper it calls.
*
* The host session event stream carries no file payloads — a tool result is
* text, a path is not an artifact the channel knows about. So the channel
* exposes its own tool: an agent that produced a report, spreadsheet, or
* image calls `send_file(path)` and the bridge uploads that file to the
* Feishu chat as a real attachment. The agent learns the outcome in its
* result, and the human gets a clickable file in the chat it is already
* watching.
* @module dsh-lark-bridge/files
*/
/** The `send_file` tool the bridge registers on chat agents. */
const SEND_FILE_TOOL_NAME = "send_file";
/** Model-facing content renderer for the tool's canonical result. */
function renderSendFileResult(args, value) {
	if (value.ok && value.fileName !== void 0) return [{
		type: "text",
		text: `已发送文件 \`${value.fileName}\` 到当前聊天。`
	}];
	return [{
		type: "text",
		text: `文件发送失败：${value.error ?? "未知错误"}`
	}];
}
/** Presentation title for one pending call, for the call log/card header. */
function presentSendFileCall(args) {
	const path = args.path;
	return { title: `发送文件 ${typeof path === "string" ? path : ""}`.trimEnd() };
}
/**
* The tool definition to register on one chat agent's scope. The factory
* captures the bridge's delivery capability so the tool can reach the chat
* the agent belongs to.
* @param capability - the bridge's file delivery hook.
* @returns a dsh `ToolDefinition`-shaped registration.
*/
function createSendFileTool(capability) {
	return {
		name: SEND_FILE_TOOL_NAME,
		description: "Send one file from the workspace as an attachment in the current chat. Use it to deliver finished artifacts to the human: HTML reports, PDFs, spreadsheets, images, logs. The human can open or download the file directly from the chat. Pass an absolute path, or a path relative to the workspace root.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Absolute or workspace-relative path of the file to send"
				},
				caption: {
					type: "string",
					description: "Optional short caption delivered with the file"
				}
			},
			required: ["path"]
		},
		output: {
			schema: {
				type: "object",
				properties: {
					ok: { type: "boolean" },
					fileName: { type: "string" },
					error: { type: "string" }
				},
				additionalProperties: false
			},
			render: renderSendFileResult,
			presentationMeta: presentSendFileCall
		},
		async execute(args, exec) {
			const parsed = args;
			const sessionId = exec.agent?.session?.id;
			if (sessionId === void 0) return {
				ok: false,
				error: "无法确定所属会话"
			};
			try {
				const { fileName } = await capability.deliverBySession(sessionId, parsed);
				return {
					ok: true,
					fileName
				};
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	};
}
/**
* Deliver a file to a chat through the outbound transport. Resolves with the
* delivered file name, or rejects with a message the tool turns into a result.
* @param port - the outbound transport (replay-wrapped by the bridge).
* @param chatId - the target chat.
* @param cwd - workspace root, for resolving relative paths.
* @param args - the parsed tool arguments.
*/
async function deliverFile(port, chatId, cwd, args) {
	const absolute = resolve(cwd, args.path);
	if (!(await promises.stat(absolute).catch((error) => {
		throw new Error(`文件不存在或不可读：${args.path}（${error instanceof Error ? error.message : String(error)}）`);
	})).isFile()) throw new Error(`不是文件：${args.path}`);
	const fileName = absolute.split(/[\\/]/).pop() ?? "file";
	const caption = args.caption;
	if (caption !== void 0 && caption !== "") await port.send(chatId, { markdown: caption });
	await port.send(chatId, { file: {
		source: absolute,
		fileName
	} });
	return { fileName };
}
/**
* Download and save non-image files from one chat message into the agent's
* workspace so the agent can read them with its own tools.
*/
async function saveInboundFiles(msg, download, workDir) {
	const files = msg.resources.filter((r) => r.type === "file");
	if (files.length === 0) return {
		notes: [],
		paths: []
	};
	const notes = [];
	const paths = [];
	for (const file of files) {
		const name = (file.fileName || `file_${file.fileKey.slice(0, 12)}`).replace(/[/\\]/g, "_");
		try {
			const { buffer } = await download(msg.messageId, file.fileKey, "file");
			const dest = join(workDir, name);
			writeFileSync(dest, buffer);
			paths.push(dest);
			notes.push(`📎 用户发送了文件「${name}」，已保存到工作区`);
		} catch (e) {
			notes.push(`📎 文件 ${name} 保存失败：${String(e).slice(0, 80)}`);
		}
	}
	return {
		notes,
		paths
	};
}
//#endregion
//#region lib/types/slash-panel.js
/**
* The bot's native slash-command panel. Feishu shows a chooser when a user
* types `/`, built from commands registered on the APP rather than sent in a
* message, so a chat only discovers what this channel accepts if the panel is
* kept in step with it.
*
* The sync reconciles: it creates what the panel is missing and removes what
* this channel no longer offers. An additive-only sync was tried first, on the
* reasoning that the panel belongs to the app and a human might have curated
* it. Drift turned out to be the real cost — a command removed from the channel
* stayed in the menu and answered "unknown command" for everyone who picked it
* — while a deployment that does curate its own menu has `syncSlashCommands`
* to turn this off.
* @module dsh-lark-bridge/slash-panel
*/
/**
* Make the panel offer exactly what this channel accepts.
* @param port - the panel operations.
* @param desired - what this channel accepts.
* @param notify - operator console line.
* @returns the names added and removed.
*/
async function syncSlashPanel(port, desired, notify) {
	let existing;
	try {
		existing = await port.listSlashCommands();
	} catch (error) {
		notify(`dsh-lark-bridge: slash-command panel not synced: ${error instanceof Error ? error.message : String(error)}`);
		return {
			added: [],
			removed: []
		};
	}
	const known = new Map(existing.map((entry) => [entry.command, entry.commandId]));
	const wanted = new Map(desired.map((command) => [command.name, command.description]));
	const added = [];
	const removed = [];
	for (const command of desired) {
		const existingId = known.get(command.name);
		if (existingId === void 0) {
			try {
				await port.createSlashCommand(command.name, command.description);
				added.push(command.name);
			} catch (error) {
				notify(`dsh-lark-bridge: could not register /${command.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
			continue;
		}
		const previous = existing.find((entry) => entry.command === command.name);
		if (previous?.description !== void 0 && previous.description !== command.description) try {
			await port.deleteSlashCommand(existingId);
			await port.createSlashCommand(command.name, command.description);
			added.push(command.name);
		} catch (error) {
			notify(`dsh-lark-bridge: could not refresh /${command.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const entry of existing) {
		if (wanted.has(entry.command)) continue;
		try {
			await port.deleteSlashCommand(entry.commandId);
			removed.push(entry.command);
		} catch (error) {
			notify(`dsh-lark-bridge: could not remove /${entry.command}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		added,
		removed
	};
}
//#endregion
//#region lib/types/session.js
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
const SESSION_PREFIX = "feishu-";
/** Separator between a conversation key's facets; absent from Feishu open ids. */
const FACET_SEPARATOR = ":";
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
function conversationKey(scope, msg) {
	switch (scope) {
		case "chat": return msg.chatId;
		case "chat-thread": return msg.threadId === void 0 ? msg.chatId : `${msg.chatId}${FACET_SEPARATOR}${msg.threadId}`;
		case "chat-sender": return `${msg.chatId}${FACET_SEPARATOR}${msg.senderId}`;
		default: throw new Error(`dsh-lark-bridge: unknown session scope ${String(scope)}`);
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
function sessionIdFor(key) {
	return `${SESSION_PREFIX}${key}`;
}
/**
* Get, resume, or create the agent bound to one conversation key, deduplicated
* per key so a burst of messages cannot race two sessions into existence.
* Bindings live until {@link ConversationSessions.close}, which disposes every
* agent this store owns.
*/
var ConversationSessions = class {
	scope;
	ladder;
	/** Resolved sessions by conversation key. */
	opened = /* @__PURE__ */ new Map();
	/** Conversation key per live session id, in binding order. */
	keys = /* @__PURE__ */ new Map();
	/** Acquisitions still walking the ladder, joined by concurrent messages. */
	opening = /* @__PURE__ */ new Map();
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
		if (this.closed) throw new Error("dsh-lark-bridge: sessions are closed");
		const key = conversationKey(this.scope, msg);
		const bound = this.opened.get(key);
		if (bound !== void 0) return bound;
		let opening = this.opening.get(key);
		if (opening === void 0) {
			opening = this.bind(key);
			this.opening.set(key, opening);
			opening.catch(() => {
				this.opening.delete(key);
			});
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
		const owned = [...this.opened.values()].filter((session) => session.owned);
		this.opened.clear();
		this.keys.clear();
		this.opening.clear();
		const failures = (await Promise.allSettled(owned.map((session) => session.handle.dispose()))).flatMap((result) => result.status === "rejected" ? [result.reason] : []);
		if (failures.length > 0) throw new AggregateError(failures, "dsh-lark-bridge: session disposal failed");
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
			if (opened.owned) await opened.handle.dispose().catch((error) => {
				this.ladder.report(`dsh-lark-bridge: disposing the late session for ${key} failed: ${failureDetail(error)}`);
			});
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
		if (live !== void 0) return {
			handle: live,
			owned: false
		};
		try {
			return {
				handle: await this.ladder.resume(sessionId),
				owned: true
			};
		} catch (error) {
			this.ladder.report(`dsh-lark-bridge: resuming session for ${key} failed, starting a new one: ${failureDetail(error)}`);
		}
		return {
			handle: await this.ladder.create(sessionId),
			owned: true
		};
	}
};
//#endregion
//#region lib/types/reaction.js
/**
* Message reaction feedback: the bot's own emoji reaction on the triggering
* message, so a human sees that the bot received it and is working, without
* any chat text. States replace each other: acknowledging, working, then a
* terminal result (success / failure), or clearing entirely when configured.
*
* Feishu lets an app add and remove its own reactions on a message; only the
* bot's own reactions can be removed. The tracker holds the `reaction_id`
* each add returns so the same emoji can be swapped for the next one.
* @module dsh-lark-bridge/reaction
*/
/**
* Default feedback, using Feishu's reaction emoji_type vocabulary (the
* platform only accepts these codes — arbitrary Unicode emoji are rejected
* with `231001 reaction type is invalid`):
* OK 收到 → THINKING 思考 → DONE 完成（失败 ERROR）.
*/
const DEFAULT_REACTION_PRESET = {
	ack: "OK",
	working: "THINKING",
	success: "DONE",
	failure: "ERROR",
	clearWhenDone: false
};
/**
* Track one message's reaction through the lifecycle. Every transition first
* removes the previous reaction (best-effort) then adds the next one; failures
* to remove are reported through `onError` and never abort the transition.
*
* Only one reaction is ever on the message at a time, so the feedback reads
* as a single morphing emoji rather than a stack.
* @param port - reaction operations.
* @param preset - the emoji lifecycle.
* @param onError - report a reaction failure to the operator.
* @returns the tracker.
*/
function createReactionTracker(port, preset = DEFAULT_REACTION_PRESET, onError = () => {}) {
	const states = /* @__PURE__ */ new Map();
	const swap = async (messageId, state, emoji) => {
		if (state.currentId !== void 0) {
			await port.removeReaction(messageId, state.currentId).catch(onError);
			state.currentId = void 0;
		}
		if (emoji === "") return;
		try {
			state.currentId = await port.addReaction(messageId, emoji);
		} catch (error) {
			onError(error);
		}
	};
	const settle = async (messageId, emoji, clearDelayMs) => {
		let state = states.get(messageId);
		if (state === void 0) {
			state = {
				currentId: void 0,
				settled: false,
				acked: false
			};
			states.set(messageId, state);
		}
		if (state.settled) return;
		state.settled = true;
		if (emoji !== "") await swap(messageId, state, emoji);
		if (preset.clearWhenDone && state.currentId !== void 0) {
			const id = state.currentId;
			setTimeout(() => {
				port.removeReaction(messageId, id).catch(onError);
				states.delete(messageId);
			}, clearDelayMs);
		}
	};
	return {
		async ack(messageId) {
			let state = states.get(messageId);
			if (state === void 0) {
				state = {
					currentId: void 0,
					settled: false,
					acked: false
				};
				states.set(messageId, state);
			}
			if (state.settled || state.acked) return;
			state.acked = true;
			if (preset.ack !== "") await swap(messageId, state, preset.ack);
		},
		async working(messageId) {
			const state = states.get(messageId);
			if (state === void 0 || state.settled) return;
			if (preset.working !== "") await swap(messageId, state, preset.working);
		},
		done(messageId) {
			return settle(messageId, preset.success, 4e3);
		},
		fail(messageId) {
			return settle(messageId, preset.failure, 6e3);
		},
		/** Forget a message (its chat was disposed); the reaction stays as it was. */
		forget(messageId) {
			states.delete(messageId);
		}
	};
}
//#endregion
//#region lib/types/questions.js
/**
* The model-to-human question flow as a Feishu card.
*
* dsh's `ctx.userQuestions` seam pauses a tool call until a human answers;
* the UI side is a single registered provider. This module is that provider
* for the bridge: the model's `ask_user_question` becomes an interactive
* Feishu card (option buttons, or a free-text prompt), the human's click or
* text resolves the pending promise, and the structured answer rides back
* into the agent loop as the tool result — the exact round trip the Web UI's
* question composer performs.
* @module dsh-lark-bridge/questions
*/
/** Card-button payload carried by an option selection. */
const QUESTION_ACTION = "dsh-lark-bridge/question";
/**
* Narrow an arbitrary card-action value to this plugin's question payload.
* @param value - raw button value from a card action event.
* @returns the typed payload, or undefined for foreign card actions.
*/
function questionActionValue(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (record.kind !== "dsh-lark-bridge/question") return void 0;
	if (typeof record.id !== "string") return void 0;
	if (typeof record.option !== "string") return void 0;
	return {
		kind: QUESTION_ACTION,
		id: record.id,
		option: record.option
	};
}
/** How much of a question's detail an option card may carry. */
const QUESTION_DETAIL_MAX_CHARS = 400;
/** Bound one untrusted detail string so it cannot inflate a card payload. */
function boundDetail(text) {
	return text.length <= QUESTION_DETAIL_MAX_CHARS ? text : `${text.slice(0, 399)}…`;
}
/**
* Build the interactive question card for one request.
*
* Untrusted model text (question/detail/option labels) rides `plain_text`
* elements so none of it can inject card markup. Option buttons are the
* selectable surface; a question without options degrades to a single
* "已读（无选项）" confirmation button so the promise always has a path
* to resolve.
* @param questions - the questions to render.
* @param id - correlation id carried by every button.
* @returns a Feishu card object for `send({ card })`.
*/
function questionCard(questions, id) {
	const elements = [];
	for (const q of questions) {
		elements.push({
			tag: "div",
			text: {
				tag: "plain_text",
				content: q.question
			}
		});
		if (q.header !== void 0 && q.header !== "") elements.push({
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: `分组：${q.header}`
			}]
		});
		if (q.detail !== void 0 && q.detail !== "") elements.push({
			tag: "div",
			text: {
				tag: "plain_text",
				content: boundDetail(q.detail)
			}
		});
		const options = q.options ?? [];
		if (options.length === 0) elements.push({
			tag: "action",
			actions: [{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "确认已读"
				},
				type: "primary",
				value: {
					kind: QUESTION_ACTION,
					id,
					option: ""
				}
			}]
		});
		else elements.push({
			tag: "action",
			actions: options.slice(0, 6).map((option, index) => ({
				tag: "button",
				text: {
					tag: "plain_text",
					content: option.label.slice(0, 40)
				},
				type: index === 0 ? "primary" : "default",
				value: {
					kind: QUESTION_ACTION,
					id,
					option: option.label
				}
			}))
		});
	}
	return {
		config: { wide_screen_mode: true },
		header: {
			template: "blue",
			title: {
				tag: "plain_text",
				content: "需要你的回答"
			}
		},
		elements
	};
}
/**
* The bridge's user-questions provider: render questions as Feishu cards and
* resolve them on button clicks.
* @param port - the transport used to send cards.
* @param chatFor - resolve the chat a session's question belongs to; keyed by
*   the agent's session id (the host seam validates the caller is the exact
*   live root before it reaches us).
* @returns the provider and its card-action handler.
*/
function createQuestionProvider(port, chatFor) {
	const pending = /* @__PURE__ */ new Map();
	const provider = { async ask(request) {
		const id = randomUUID();
		const sessionId = request.agent?.session.id;
		const chat = sessionId === void 0 ? void 0 : chatFor(sessionId);
		if (chat === void 0) return { answers: request.questions.map((q) => ({
			id: q.id,
			selected: [],
			custom: "[会话不可用]"
		})) };
		try {
			await port.send(chat.chatId, { card: questionCard(request.questions, id) });
		} catch (error) {
			return { answers: request.questions.map((q) => ({
				id: q.id,
				selected: [],
				custom: "[无法发送问题]"
			})) };
		}
		return new Promise((resolve) => {
			pending.set(id, {
				chatId: chat.chatId,
				resolve,
				questions: request.questions
			});
			request.signal?.addEventListener("abort", () => {
				const item = pending.get(id);
				if (item === void 0) return;
				pending.delete(id);
				item.resolve({ answers: item.questions.map((q) => ({
					id: q.id,
					selected: [],
					custom: "[已取消]"
				})) });
			}, { once: true });
		});
	} };
	const handleCardAction = (evt) => {
		const value = questionActionValue(evt.action.value);
		if (value === void 0) return void 0;
		const item = pending.get(value.id);
		if (item === void 0) return void 0;
		pending.delete(value.id);
		const answers = item.questions.map((q) => {
			if (value.option === "") return {
				id: q.id,
				selected: [],
				custom: "已确认"
			};
			if (!(q.options ?? []).some((o) => o.label === value.option)) return {
				id: q.id,
				selected: [],
				custom: value.option
			};
			return {
				id: q.id,
				selected: [value.option]
			};
		});
		item.resolve({ answers });
		return { toast: "回答已提交" };
	};
	return {
		provider,
		handleCardAction
	};
}
//#endregion
//#region lib/types/todo.js
/**
* The model's todo list as a live Feishu progress card.
*
* dsh's `todo_write` tool replaces the whole list on every call and appends a
* `todo/write` snapshot to the session log. This module renders those
* snapshots as one progress card per session: the first write sends the card,
* later writes update it in place, and a cleared or finished list settles it
* with a summary. The Web UI renders the same projection in its sidebar; the
* chat card is the equivalent surface for a messaging client.
* @module dsh-lark-bridge/todo
*/
function counts(todos) {
	let done = 0;
	let inProgress = 0;
	for (const item of todos) if (item.status === "completed") done += 1;
	else if (item.status === "in_progress") inProgress += 1;
	return {
		total: todos.length,
		done,
		inProgress
	};
}
/** Emoji per status, chosen from Feishu's supported reaction/emoji set. */
const STATUS_EMOJI = {
	pending: "⚪",
	in_progress: "🔵",
	completed: "✅"
};
/** How many todo rows one card may show before collapsing. */
const CARD_TODO_MAX_ROWS = 12;
/** Bound one untrusted todo line so it cannot inflate a card payload. */
function boundLine$1(text) {
	return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}
/**
* Build the progress card for one todo snapshot.
* @param todos - the latest whole list.
* @returns a Feishu card object for `send({ card })` / `updateCard`.
*/
function todoCard(todos) {
	const { total, done, inProgress } = counts(todos);
	const rows = todos.slice(0, CARD_TODO_MAX_ROWS).map((item) => ({
		tag: "div",
		text: {
			tag: "lark_md",
			content: `${STATUS_EMOJI[item.status]} ${boundLine$1(item.content)}`
		}
	}));
	const overflow = todos.length - rows.length;
	const elements = [{
		tag: "div",
		text: {
			tag: "lark_md",
			content: `**任务进度** ${done}/${total} 完成${inProgress > 0 ? ` · ${inProgress} 进行中` : ""}`
		}
	}, ...rows];
	if (overflow > 0) elements.push({
		tag: "note",
		elements: [{
			tag: "plain_text",
			content: `… 还有 ${overflow} 项`
		}]
	});
	return {
		config: { wide_screen_mode: true },
		header: {
			template: "blue",
			title: {
				tag: "plain_text",
				content: `📋 任务进度 ${done}/${total}`
			}
		},
		elements
	};
}
/**
* The bridge's todo renderer: first snapshot sends a card, later snapshots
* update it in place, and a session with no pending rows leaves the card with
* a "done" header.
* @param port - the transport used to send and update cards.
* @returns the renderer and its failure report hook.
*/
function createTodoRenderer(port, reportSendFailure) {
	const cards = /* @__PURE__ */ new Map();
	const sendOrUpdate = async (sessionId, chatId, todos) => {
		const existing = cards.get(sessionId);
		const card = todoCard(todos);
		if (existing === void 0) {
			try {
				const sent = await port.send(chatId, { card });
				cards.set(sessionId, {
					chatId,
					messageId: sent.messageId
				});
			} catch (error) {
				reportSendFailure(error);
			}
			return;
		}
		if (existing.chatId !== chatId) {
			try {
				const sent = await port.send(chatId, { card });
				cards.set(sessionId, {
					chatId,
					messageId: sent.messageId
				});
			} catch (error) {
				reportSendFailure(error);
			}
			return;
		}
		try {
			await port.updateCard(existing.messageId, card);
		} catch (error) {
			reportSendFailure(error);
		}
	};
	return {
		async handle(sessionId, chatId, todos) {
			await sendOrUpdate(sessionId, chatId, todos);
		},
		dispose() {
			cards.clear();
		}
	};
}
//#endregion
//#region lib/types/goal.js
/**
* The model's current goal as a live Feishu card.
*
* dsh's goal tools mutate the session's goal and append a `goal/change`
* snapshot event (whole-value replace: the newest snapshot is the current
* goal). This module renders those snapshots as one goal card per session:
* the first change sends the card, later changes update it in place, and a
* cleared goal (no snapshot) settles the card with a neutral header. The Web
* UI renders the same projection in its sidebar; the chat card is the
* equivalent surface for a messaging client.
* @module dsh-lark-bridge/goal
*/
/** Emoji and label per lifecycle phase. */
const PHASE_META = {
	active: {
		emoji: "🎯",
		label: "进行中"
	},
	paused: {
		emoji: "⏸️",
		label: "已暂停"
	},
	blocked: {
		emoji: "🚧",
		label: "受阻"
	},
	complete: {
		emoji: "✅",
		label: "已完成"
	}
};
/** Bound one untrusted line so it cannot inflate a card payload. */
function boundLine(text) {
	return text.length <= 160 ? text : `${text.slice(0, 159)}…`;
}
/** Marker distinguishing this plugin's goal buttons from other card actions. */
const GOAL_ACTION = "dsh-lark-bridge/goal";
/**
* Narrow an arbitrary card-action value to this plugin's goal payload.
* @param value - raw button value from a card action event.
* @returns the typed payload, or undefined for foreign card actions.
*/
function goalActionValue(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (record.kind !== "dsh-lark-bridge/goal") return void 0;
	if (typeof record.sessionId !== "string" || record.sessionId === "") return void 0;
	if (record.operation !== "pause" && record.operation !== "resume" && record.operation !== "clear") return void 0;
	return {
		kind: GOAL_ACTION,
		sessionId: record.sessionId,
		operation: record.operation
	};
}
/**
* Build the goal card for one snapshot.
* @param goal - the current goal snapshot.
* @param sessionId - the session the buttons drive, carried in their values.
* @returns a Feishu card object for `send({ card })` / `updateCard`.
*/
function goalCard(goal, sessionId) {
	const meta = PHASE_META[goal.phase];
	const lines = [`**目标** ${boundLine(goal.objective)}`, `${meta.emoji} ${meta.label}`];
	if (goal.phase === "blocked" && goal.blockedReason?.message !== void 0 && goal.blockedReason.message !== "") lines.push(`原因：${boundLine(goal.blockedReason.message)}`);
	if (goal.maxGoalRounds !== void 0) lines.push(`轮次上限：${goal.maxGoalRounds}`);
	const button = (operation, text, type) => ({
		tag: "button",
		text: {
			tag: "plain_text",
			content: text
		},
		type,
		value: {
			kind: GOAL_ACTION,
			sessionId,
			operation
		}
	});
	const actions = [];
	if (goal.phase === "active") actions.push(button("pause", "⏸️ 暂停", "default"));
	else if (goal.phase === "paused" || goal.phase === "blocked") actions.push(button("resume", "▶️ 继续", "primary"));
	if (goal.phase !== "complete") actions.push(button("clear", "⏹ 清除", "danger"));
	return {
		config: { wide_screen_mode: true },
		header: {
			template: "turquoise",
			title: {
				tag: "plain_text",
				content: `${meta.emoji} 目标 ${meta.label}`
			}
		},
		elements: [{
			tag: "div",
			text: {
				tag: "lark_md",
				content: lines.join("\n")
			}
		}, ...actions.length === 0 ? [] : [{
			tag: "action",
			actions
		}]]
	};
}
/**
* The bridge's goal renderer: first snapshot sends a card, later snapshots
* update it in place, and a clear (operation `clear`) leaves the last card
* untouched — the goal is gone, so there is nothing to update.
* @param port - the transport used to send and update cards.
* @returns the renderer and its failure report hook.
*/
function createGoalRenderer(port, reportSendFailure) {
	const cards = /* @__PURE__ */ new Map();
	const sendOrUpdate = async (sessionId, chatId, goal) => {
		const existing = cards.get(sessionId);
		const card = goalCard(goal, sessionId);
		if (existing === void 0 || existing.chatId !== chatId) {
			try {
				const sent = await port.send(chatId, { card });
				cards.set(sessionId, {
					chatId,
					messageId: sent.messageId
				});
			} catch (error) {
				reportSendFailure(error);
			}
			return;
		}
		try {
			await port.updateCard(existing.messageId, card);
		} catch (error) {
			reportSendFailure(error);
		}
	};
	return {
		async handle(sessionId, chatId, change) {
			if (change.goal === void 0) return;
			await sendOrUpdate(sessionId, chatId, change.goal);
		},
		dispose() {
			cards.clear();
		}
	};
}
//#endregion
//#region lib/types/workflow.js
/**
* Workflow run progress as chat messages.
*
* dsh's `workflow` tool runs a JS orchestration script that fans out
* subagents, and appends four event types to the session log: run-start,
* agent-start, agent-end, run-end. The Web UI has a dedicated workflow-run
* surface; a messaging client gets the same shape as a short text stream so
* the human sees the fan-out happening instead of a silent gap followed by a
* final answer.
* @module dsh-lark-bridge/workflow
*/
/** The run-opening line. */
function runStartLine(run) {
	return `🧩 工作流「${run.name}」开始，派出子任务…`;
}
/** The per-member outcome emoji. */
function outcomeMark(outcome) {
	switch (outcome) {
		case "completed": return "✅";
		case "failed": return "❌";
		case "cancelled": return "⏹️";
	}
}
/** One member starting line (deduped by seq). */
function agentStartLine(agent) {
	return `  · ${agent.label} 启动…`;
}
/** One member settling line. */
function agentEndLine(agent) {
	return `  · #${agent.seq} ${outcomeMark(agent.outcome)}`;
}
/** The run-closing line. */
function runEndLine(run) {
	return `🧩 工作流结束：${run.stopReason === "completed" ? "全部完成" : run.stopReason === "cancelled" ? "已取消" : "出错终止"}`;
}
/** A workflow phase-change line (live `workflow/phase` event). */
function phaseLine(title) {
	return `🗂️ 阶段：${title}`;
}
/** A workflow narration line (live `workflow/log` event). */
function workflowLogLine(message) {
	return `📝 ${message}`;
}
//#endregion
//#region lib/types/notices.js
/** A human interval label for one schedule kind. */
function scheduleKindLabel(kind) {
	switch (kind) {
		case "after": return "延时";
		case "at": return "定点";
		case "every": return "周期";
		default: return "";
	}
}
/** A schedule mutation line. `dispatch` stays silent — it fires on schedule and is noise. */
function scheduleLine(notice) {
	switch (notice.operation) {
		case "create": return `⏰ 已创建${scheduleKindLabel(notice.kind)}任务${notice.prompt === void 0 ? "" : `：${notice.prompt.slice(0, 40)}`}`;
		case "delete": return "⏰ 定时任务已删除";
		case "dispatch": return;
	}
}
/** A DeepSeek search firing line. */
function webSearchLine() {
	return "🔍 正在搜索网络…";
}
/** A live subagent settlement line (`subagent/end`). */
function subagentEndLine(info) {
	return `${info.stopReason === "completed" ? "✅" : info.stopReason === "aborted" ? "⏹️" : info.stopReason === "error" ? "❌" : "⛔"} 子任务结束${info.stopReason === "max-tokens" ? "（达到 token 上限）" : info.stopReason === "error" ? "（失败）" : info.stopReason === "aborted" ? "（已中止）" : ""} [${info.id}]`;
}
/** A background job's terminal line (from `JobRegistry.onJobDone`). */
function jobDoneLine(job) {
	const mark = job.status === "completed" ? "✅" : job.status === "killed" ? "⏹️" : "❌";
	const detail = job.detail === void 0 || job.detail === "" ? "" : `（${job.detail}）`;
	return `${mark} 后台任务完成：${job.label}${detail} [${job.id}]`;
}
/**
* A model-call retry line. Transient upstream failures self-heal through the
* retry policy in the vast majority of cases — announcing the first retry
* only taught users to expect noise on every hiccup. The chat stays silent
* while retries are in flight (the turn either completes or ends with an
* error event either way); we speak up only at the LAST attempt, when the
* next failure would actually kill the turn — the moment a human may want
* to look at the route.
*/
function retryLine(retry) {
	if (retry.maxRetries === void 0 || retry.retry !== retry.maxRetries) return void 0;
	return `⚠️ 模型调用连续失败，正在进行最后一次重试（第 ${retry.retry}/${retry.maxRetries} 次）；若仍失败本轮将终止。`;
}
/** Extract the visible text from a compaction summary's content blocks. */
function summaryText(blocks) {
	return blocks.filter((block) => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
/**
* A compaction summary line: what replaced the old history, and at what cost.
* @param data - the `compaction/summary` payload.
* @returns the markdown line for the chat.
*/
function compactionSummaryLine(data) {
	const text = summaryText(data.summary).trim();
	const preview = text.length === 0 ? "" : `\n${text.slice(0, 200)}`;
	return `📦 上下文压缩完成，释放约 ${data.shadowedTokenCount} tokens${preview}`;
}
/**
* A prune line: old history was trimmed without a model call.
* @param data - the `compaction/prune` payload.
* @returns the markdown line for the chat.
*/
function compactionPruneLine(data) {
	return `🗑️ 已修剪 ${data.shadowedSeqs.length} 条旧消息（释放约 ${data.shadowedTokenCount} tokens）`;
}
/**
* A proactive token-pressure warning: the session's context has climbed past
* the compaction advice threshold. Unlike the compaction notices (which fire
* after the fact), this is a heads-up the bridge polls for while a long task
* is running, so the chat hears about pressure before the model degrades.
* @param total - current measured total tokens.
* @param surface - the session-surface portion of the total.
* @param threshold - the configured warning threshold.
* @returns the markdown line for the chat.
*/
function tokenPressureLine(data) {
	return `⚠️ 上下文压力偏高（当前约 ${data.total.toLocaleString("zh-CN")} tokens / 会话表面 ${data.surface.toLocaleString("zh-CN")}）\n已超过 ${data.threshold.toLocaleString("zh-CN")} tokens 的建议压缩线。长任务建议先 \`/compact\` 压缩，或让 agent 收尾当前阶段。`;
}
//#endregion
//#region lib/types/first-contact.js
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
/**
* Derive the permission posture from the same environment knob dsh-base reads
* (`DSH_PERMISSION_MODE`, default `workspace-write`), so the guide always
* matches what the session actually enforces.
* @param env - process environment (injectable for tests).
* @returns the posture name, defaulting to `workspace-write`.
*/
function permissionPosture(env = process.env) {
	return env.DSH_PERMISSION_MODE ?? "workspace-write";
}
/**
* One sentence describing what the current posture means to the human in the
* chat.
*/
function postureLine(posture) {
	switch (posture) {
		case "danger-full-access": return "全自动模式：命令直接执行，不再逐条确认。它和你拥有同等文件权限，请只在你信任的环境使用。";
		case "read-only": return "只读模式：不会修改任何文件，但读取范围仍限工作区。";
		case "workspace-write": return "工作区模式：工作区内可写，工作区外的操作会弹卡片请你确认。";
		default: return `当前权限模式：${posture}。`;
	}
}
/**
* The commands every user needs on day one, with the exact invocation that
* works. Written to prevent the two real first-use failures: `/permission`
* without an argument (a status line, not a menu) and an unclicked approval
* card (the bot waits on it forever).
*/
function commandGuide(posture) {
	const lines = [
		"常用命令：",
		"- `/help` 查看全部命令",
		"- `/stop` 停止当前任务（卡住时用它）",
		"- `/plan` 先出计划再执行",
		"- `/permission <模式>` 切换权限：`read-only` / `workspace-write` / `danger-full-access`（注意：**不带参数只显示当前状态，不是选项菜单，不要等它让你选**）",
		"",
		"审批卡片：",
		"- 如果出现**卡片**（权限确认），点卡片上的按钮即可，不点它会一直等",
		"- 如果只是**一段文字**列了几个选项（如 \"available: a, b, c\"），那不是菜单——直接在输入框发对应的命令，例如 `/permission danger-full-access`"
	];
	if (posture === "danger-full-access") lines.splice(4, 0, "- 当前已是全自动模式（danger-full-access），命令不再逐条确认。");
	return lines.join("\n");
}
/**
* Render the first-contact guide for a brand-new session.
* @param posture - the deployment's permission posture.
* @returns the markdown message to send into the chat.
*/
function onboardingText(posture) {
	return [
		"**你好，我是跑在飞书里的编码智能体（DeepSeek Harness）。**",
		"",
		"直接说你要做的事，我会调用工具（终端/文件/搜索等）去完成。",
		"",
		`权限：${postureLine(posture)}`,
		"",
		commandGuide(posture),
		"",
		"开始吧——发一句话试试。"
	].join("\n");
}
/** The first-contact message, as a plain object for `port.send({ markdown })`. */
function onboardingMessage(env = process.env) {
	return { markdown: onboardingText(permissionPosture(env)) };
}
//#endregion
//#region lib/types/replay.js
/**
* Outbound replay: a thin transport wrapper that turns a long-connection gap
* into a delivery delay instead of a loss.
*
* The Lark WebSocket has no cursor and no server-side replay, so events that
* the bridge renders while the connection is down are lost at the transport.
* This wrapper queues an outbound call when the connection is not live (or
* when a send fails mid-gap) and flushes the queue in order once the
* connection is restored — a chat that missed a few minutes of a running
* agent then catches up instead of seeing a hole.
*
* Only chat-facing sends are replayed: `send` (messages/cards), `stream`
* (cot), and `updateCard` (in-place card edits). Reactions and removals are
* one-shot feedback — losing one while down is acceptable, and replaying it
* risks flipping a just-reacted emoji.
* @module dsh-lark-bridge/replay
*/
/**
* Wrap a transport so outbound calls survive a connection gap.
* @param port - the underlying transport.
* @param onFlushFailure - report one queued call that failed to re-send.
* @param notify - operator console line for queue lifecycle.
* @returns the replay-aware port.
*/
function createReplayPort(port, onFlushFailure, notify) {
	let live = true;
	let queue = [];
	let flushing;
	const queuedSendResult = () => ({ messageId: `queued-${queue.length}` });
	const enqueueSend = (to, input, opts) => {
		queue.push({
			kind: "send",
			to,
			input,
			...opts === void 0 ? {} : { opts }
		});
		return queuedSendResult();
	};
	const enqueueStream = (to, input, opts) => {
		queue.push({
			kind: "stream",
			to,
			input,
			...opts === void 0 ? {} : { opts }
		});
		return queuedSendResult();
	};
	const enqueueUpdate = (messageId, card) => {
		queue.push({
			kind: "updateCard",
			messageId,
			card
		});
	};
	const flush = async () => {
		if (!live || flushing !== void 0 || queue.length === 0) return;
		flushing = (async () => {
			const batch = queue;
			queue = [];
			notify(`dsh-lark-bridge: replaying ${batch.length} queued message(s) after reconnect`);
			for (const call of batch) try {
				switch (call.kind) {
					case "send":
						await port.send(call.to, call.input, call.opts);
						break;
					case "stream":
						await port.stream(call.to, call.input, call.opts);
						break;
					case "updateCard": await port.updateCard(call.messageId, call.card);
				}
			} catch (error) {
				onFlushFailure(error);
				queue.push(call);
			}
		})().finally(() => {
			flushing = void 0;
		});
		await flushing;
	};
	return {
		...bindPortMethods(port),
		async send(to, input, opts) {
			if (!live) return enqueueSend(to, input, opts);
			try {
				return await port.send(to, input, opts);
			} catch (error) {
				onFlushFailure(error);
				return enqueueSend(to, input, opts);
			}
		},
		async stream(to, input, opts) {
			if (!live) return enqueueStream(to, input, opts);
			try {
				return await port.stream(to, input, opts);
			} catch (error) {
				onFlushFailure(error);
				return enqueueStream(to, input, opts);
			}
		},
		async updateCard(messageId, card) {
			if (!live) {
				enqueueUpdate(messageId, card);
				return;
			}
			try {
				await port.updateCard(messageId, card);
			} catch (error) {
				onFlushFailure(error);
				enqueueUpdate(messageId, card);
			}
		},
		setConnected(next) {
			live = next;
			if (next) flush().catch(onFlushFailure);
		},
		pending: () => queue.length
	};
}
/**
* Copy a transport's methods onto a plain object with `this` bound to the
* transport. A plain spread (`{ ...port }`) copies only own enumerable fields
* — a class instance (LarkChannel) keeps every method on the prototype, so
* the spread result has NO `connect`, `send`, or `on`, and the bridge would
* call `undefined` and die on the first connection. Binding keeps the
* prototype methods callable without losing the instance state they read.
* @param port - the transport surface to copy.
* @returns own fields plus every method bound to the original port.
*/
function bindPortMethods(port) {
	const copy = {};
	for (const key of Object.keys(port)) {
		const value = port[key];
		copy[key] = typeof value === "function" ? value.bind(port) : value;
	}
	for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(port))) {
		if (key === "constructor") continue;
		const value = port[key];
		if (typeof value === "function") copy[key] = value.bind(port);
	}
	return copy;
}
//#endregion
//#region lib/types/bridge.js
/**
* The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
* committed assistant output returns as chat messages, and host approval
* questions become interactive cards answered by button clicks.
* @module dsh-lark-bridge/bridge
*/
/** How much of a pending call's arguments the approval card shows. */
const CARD_ARGUMENTS_MAX_CHARS = 600;
/** Marker distinguishing this plugin's approval buttons from other card actions. */
const APPROVAL_ACTION = "dsh-lark-bridge/approval";
/**
* Narrow an arbitrary card-action value to this plugin's approval payload.
* @param value - raw button value from a card action event.
* @returns the typed payload, or undefined for foreign card actions.
*/
function approvalActionValue(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (record.kind !== APPROVAL_ACTION) return void 0;
	if (typeof record.id !== "string") return void 0;
	if (record.decision !== "allow" && record.decision !== "reject") return void 0;
	return {
		kind: APPROVAL_ACTION,
		id: record.id,
		decision: record.decision
	};
}
/**
* Build the interactive approval card for one permission question.
* @param toolName - the tool the question is about.
* @param reason - the asker's explanation, when it gave one.
* @param id - correlation id carried by both decision buttons.
* @returns a Feishu card object for `send({ card })`.
*/
function approvalCard(toolName, reason, command, id) {
	const untrusted = (label, value) => [{
		tag: "div",
		text: {
			tag: "lark_md",
			content: `**${label}**`
		}
	}, {
		tag: "div",
		text: {
			tag: "plain_text",
			content: value
		}
	}];
	return {
		config: { wide_screen_mode: true },
		header: {
			template: "orange",
			title: {
				tag: "plain_text",
				content: "DSH 操作审批"
			}
		},
		elements: [
			{
				tag: "div",
				text: {
					tag: "lark_md",
					content: `**工具**：\`${toolName}\``
				}
			},
			...command === void 0 ? [] : untrusted("将执行", command),
			...reason === void 0 || reason === "" ? [] : untrusted("模型说明", reason),
			{
				tag: "note",
				elements: [{
					tag: "plain_text",
					content: "批准前请确认上面的内容确实是你要执行的。"
				}]
			},
			{
				tag: "action",
				actions: [{
					tag: "button",
					text: {
						tag: "plain_text",
						content: "允许一次"
					},
					type: "primary",
					value: {
						kind: APPROVAL_ACTION,
						id,
						decision: "allow"
					}
				}, {
					tag: "button",
					text: {
						tag: "plain_text",
						content: "拒绝"
					},
					type: "danger",
					value: {
						kind: APPROVAL_ACTION,
						id,
						decision: "reject"
					}
				}]
			}
		]
	};
}
/** Card headline and color for each settled approval outcome. */
const SETTLED_CARD = {
	"allowed-once": {
		template: "green",
		text: "✅ 已允许执行一次"
	},
	"rejected": {
		template: "red",
		text: "⛔ 已拒绝"
	},
	"cancelled": {
		template: "grey",
		text: "⏹ 请求已撤回"
	},
	"unavailable": {
		template: "grey",
		text: "⏹ 无法作答"
	}
};
/**
* Build the static replacement card shown after an approval settles.
* @param toolName - the tool the question was about.
* @param outcome - the closed decision.
* @returns a Feishu card object for `updateCard`.
*/
function settledCard(toolName, outcome, decidedBy) {
	const look = SETTLED_CARD[outcome];
	return {
		config: { wide_screen_mode: true },
		header: {
			template: look.template,
			title: {
				tag: "plain_text",
				content: "DSH 操作审批"
			}
		},
		elements: [{
			tag: "div",
			text: {
				tag: "lark_md",
				content: `**工具**：\`${toolName}\`\n${look.text}`
			}
		}, ...decidedBy === void 0 ? [] : [{
			tag: "note",
			elements: [{
				tag: "plain_text",
				content: `操作人：${decidedBy}`
			}]
		}]]
	};
}
/** How long one tool-activity label may be before it is ellipsized. */
const ACTIVITY_LABEL_MAX_CHARS = 90;
/**
* Reduce one presentation title to a single safe card line: the value is
* model-influenced (a search pattern, a command) and rides a markdown card, so
* newlines and code fences — the two things that could restructure the card —
* come out, and the rest is bounded.
* @param title - the tool's own label for this call.
* @returns the label as one bounded line.
*/
function activityLabel(title) {
	const line = title.replace(/[\s`]+/g, " ").trim();
	return line.length <= ACTIVITY_LABEL_MAX_CHARS ? line : `${line.slice(0, 89)}…`;
}
/**
* Build the tool-call describer for one agent's view of the registry. Prefers
* the tool's own `presentCall` title — the label the host's own surfaces show,
* so a chat line says what a call does rather than repeating its name — then
* the model's `description` argument, then the bare name.
* @param tools - the host tool registry, when composed.
* @param scope - the viewing scope key holding this agent's tools.
* @returns a describer safe to call on every `tool/call` event.
*/
function createCallPresenter(tools, scope) {
	return (name, argumentsJson) => {
		let args;
		try {
			args = JSON.parse(argumentsJson);
		} catch {
			return { title: name };
		}
		try {
			const view = tools?.get(name, scope)?.presentCall?.(args);
			const title = view?.title;
			if (typeof title === "string" && title.trim() !== "") return {
				title: activityLabel(title),
				...typeof view?.kind === "string" ? { kind: view.kind } : {}
			};
		} catch {}
		const described = args?.description;
		return typeof described === "string" && described.trim() !== "" ? { title: `${name} · ${activityLabel(described)}` } : { title: name };
	};
}
/**
* Bound one untrusted value to what an approval card may carry.
* @param text - raw tool arguments as the model produced them.
* @returns the value, ellipsized when it exceeds the card's budget.
*/
function boundCardText(text) {
	return text.length <= CARD_ARGUMENTS_MAX_CHARS ? text : `${text.slice(0, 599)}…`;
}
/**
* Compose the parts of a chat agent's world this channel owns: the tools it
* must not call, and the prompt sentence that tells the model what to do
* instead. Both registrations are scoped to this one agent.
* @param agentCtx - the agent's scope context, inside creation `setup`.
* @param config - resolved plugin configuration.
*/
/**
* Compose one chat agent's channel-facing context: tool restrictions, the
* channel identity prompt, and the channel-owned `send_file` tool when the
* deployment offers file delivery.
* @param agentCtx - the agent's scoped Cordis context.
* @param config - resolved bridge configuration.
* @param extraTools - channel-owned tools to register on this agent's scope.
* @param runtimeDenied - the live denied-tool set shared across agents, when
* the bridge offers runtime `/tools` toggling; falls back to a frozen copy of
* `config.denyTools` when absent.
*/
function composeChatAgent(agentCtx, config, extraTools = [], runtimeDenied = void 0) {
	const tools = agentCtx.get("tools");
	for (const tool of extraTools) try {
		tools?.register(tool);
	} catch (error) {
		process.stderr.write(`dsh-lark-bridge: channel tool registration skipped (${String(error)})\n`);
	}
	if (config.denyTools.length > 0 || runtimeDenied !== void 0 && runtimeDenied.size > 0) {
		const denied = runtimeDenied ?? new Set(config.denyTools);
		agentCtx.get("tools")?.guard((execution) => denied.has(execution.name) ? `${execution.name} is unavailable in this chat channel: its answer would surface on a different interface. Ask the user directly in your reply instead, and continue when they answer.` : void 0);
	}
	const prompt = agentCtx.get("systemPrompt");
	prompt?.section({
		name: "dsh-lark-bridge:identity",
		order: 120,
		text: "You are 云鹊桥 (dsh-lark-bridge), a coding agent running inside a Feishu/Lark chat via the DeepSeek Harness host. The person you are talking to is the user of this chat, not a machine. Reply in the same language they write in. You have the full coding-agent toolset of the host: you can read and edit files, run commands, and work on projects in the workspace. When you need a decision or want to ask a clarifying question, write it directly in your reply — their next message is the answer, and the chat keeps the conversation going. Do not describe your own architecture or ask what kind of interface you are running on; you are simply the bot in this chat."
	});
	prompt?.section({
		name: "dsh-lark-bridge:interaction",
		order: 150,
		text: "To ask a question or seek approval for a plan, write it in your reply — their next message is the answer. " + (config.denyTools.length > 0 ? `These tools are unavailable here: ${[...new Set(config.denyTools)].join(", ")}.` : "")
	});
}
/**
* Create an identified user message from one chat input. Group messages carry
* the sender so the model can tell voices apart; direct messages stay verbatim.
* @param msg - normalized inbound chat message.
* @returns a frozen user message for `agent.followup()`.
*/
function chatUserMessage(msg, images) {
	const text = [msg.chatType === "group" ? `${msg.senderName ?? msg.senderId}: ${msg.content}` : msg.content, ...images.notes].filter((line) => line !== "").join("\n");
	const content = [...text === "" ? [] : [{
		type: "text",
		text
	}], ...images.blocks];
	return Object.freeze({
		id: randomUUID(),
		role: "user",
		content: Object.freeze(content),
		source: Object.freeze({ kind: "user" })
	});
}
/**
* Install the bridge on a scoped plugin context. Every registration is owned
* by the context's fiber: disposal disconnects the transport, disposes every
* agent this channel owns, and settles pending approvals as `'cancelled'`.
* @param ctx - scoped plugin context carrying the `agents` service.
* @param config - resolved plugin configuration.
* @param port - the transport to drive; production passes the real Lark channel.
*/
function installBridge(ctx, config, port, notify, authorization) {
	const rawPort = port;
	const replay = createReplayPort(port, (error) => {
		notify(`dsh-lark-bridge: replay flush failed: ${error instanceof Error ? error.message : String(error)}`);
	}, notify);
	const sendFileTool = createSendFileTool({ deliverBySession: async (sessionId, args) => {
		const binding = bySession.get(sessionId);
		if (binding === void 0) throw new Error(`会话 ${sessionId} 不在当前聊天`);
		return deliverFile(replay, binding.chatId, cwd, args);
	} });
	const runtimeDeniedTools = new Set(config.denyTools);
	const scheduleRegistry = /* @__PURE__ */ new Map();
	const sessionPresets = /* @__PURE__ */ new Map();
	const subagentTrackers = /* @__PURE__ */ new Map();
	const auditStats = /* @__PURE__ */ new Map();
	const bySession = /* @__PURE__ */ new Map();
	const pendingApprovals = /* @__PURE__ */ new Map();
	/**
	* Arguments of tool calls this turn requested, by call id. An approval names
	* the call it decides but not what that call does, and the human cannot judge
	* an escalation without seeing the command; the log already published these.
	*/
	const pendingCallArguments = /* @__PURE__ */ new Map();
	/** Live workflow run id -> chat id, fed by the durable run-start event. */
	const workflowChats = /* @__PURE__ */ new Map();
	/** Most recent assistant message id per session, for `/feedback`. */
	const lastAssistantIds = /* @__PURE__ */ new Map();
	const pressureWarned = /* @__PURE__ */ new Set();
	const cwd = resolve(config.cwd ?? process.cwd());
	/**
	* Proactive context-pressure polling. While a live session is bound, the
	* host `tokenMeter` reports how many tokens the session's context costs; a
	* long task that outgrows the advised ceiling degrades quality before any
	* compaction runs. This heads-up posts at most once per crossing.
	*/
	const pollTokenPressure = () => {
		if (config.tokenPressure.enabled === false) return;
		const tokenMeter = ctx.get("tokenMeter");
		if (tokenMeter === void 0) return;
		const { threshold } = config.tokenPressure;
		for (const [sessionId, binding] of bySession) {
			let total;
			let surface;
			try {
				const measure = tokenMeter.measure({ id: sessionId });
				total = measure.totalTokens;
				surface = measure.surfaceTokens;
			} catch (error) {
				ctx.logger.warn("token pressure measure failed for %s: %s", sessionId, error);
				continue;
			}
			if (total >= threshold) {
				if (pressureWarned.has(sessionId)) continue;
				pressureWarned.add(sessionId);
				replay.send(binding.chatId, { markdown: tokenPressureLine({
					total,
					surface,
					threshold
				}) }).catch(reportSendFailure);
			} else pressureWarned.delete(sessionId);
		}
	};
	const pressureTimer = config.tokenPressure.enabled === false ? void 0 : setInterval(pollTokenPressure, config.tokenPressure.intervalMs);
	/**
	* The workspace chat sessions are accounted under, resolved once. Workspace
	* grouping is an ACCOUNT, not a cwd derivation: a session nobody attaches
	* stays in the GUI's Ungrouped bucket however its cwd reads. Registering the
	* directory when no record exists keeps chat sessions out of that bucket
	* instead of orphaning every one of them.
	*/
	let workspacePromise;
	const chatWorkspace = () => {
		workspacePromise ??= (async () => {
			const registry = ctx.get("workspaceRegistry");
			if (registry === void 0) return void 0;
			return await registry.resolveByPath(cwd) ?? await registry.create(cwd);
		})().catch((error) => {
			notify(`dsh-lark-bridge: workspace lookup failed for ${cwd}: ${String(error)}`);
		});
		return workspacePromise;
	};
	const reportSendFailure = (error) => {
		const detail = error instanceof Error ? error.message : String(error);
		notify(`dsh-lark-bridge: outbound send failed: ${detail}`);
		ctx.logger.warn("outbound send failed: %s", detail);
	};
	/** Lifecycle emoji feedback on triggering messages; disabled by configuration. */
	const reactions = config.reactionFeedback ? createReactionTracker(port, void 0, reportSendFailure) : void 0;
	/**
	* Live todo progress cards: `todo_write` snapshots render as one card per
	* session, updated in place. This is the chat equivalent of the Web UI's
	* sidebar todo projection.
	*/
	const todos = createTodoRenderer(port, reportSendFailure);
	/** Live goal cards: `goal/change` snapshots render as one card per session. */
	const goals = createGoalRenderer(port, reportSendFailure);
	/**
	* The model-to-human question flow. dsh's `ask_user_question` tool pauses a
	* tool call until a human answers through the single user-questions provider.
	*
	* The seam allows exactly ONE provider. The web profile's api-proxy
	* registers it first (its questions surface in the browser), so a bridge
	* registered on the web profile would fail the plugin's fiber asynchronously
	* and stop the WebSocket from connecting. Deploy the bridge on a profile
	* WITHOUT the web-app bundle (e.g. bundles = [dsh-base, dsh-lark-bridge]):
	* then this bridge owns the slot and the model's question becomes a Feishu
	* card. On the web profile the register is skipped and chat agents ask in
	* prose instead.
	*/
	const questions = createQuestionProvider(port, (sessionId) => {
		const binding = bySession.get(sessionId);
		return binding === void 0 ? void 0 : { chatId: binding.chatId };
	});
	const hostQuestions = ctx.get("userQuestions");
	let disposeQuestions;
	if (hostQuestions !== void 0) try {
		disposeQuestions = hostQuestions.registerProvider(questions.provider);
	} catch (error) {
		notify(`dsh-lark-bridge: user-questions provider unavailable (${error instanceof Error ? error.message : String(error)})`);
		ctx.logger.warn("user-questions provider unavailable: %s", error);
	}
	/** Resolve the provider/model for a new chat agent; config overrides the host default. */
	const modelSelection = () => {
		if (config.provider !== void 0 || config.model !== void 0) return {
			provider: config.provider,
			model: config.model
		};
		const defaults = ctx.get("agentDefaultModel");
		if (defaults === void 0) throw new Error("dsh-lark-bridge: no model configured — set config.provider/model or compose the agentDefaultModel service");
		return defaults.currentSelection();
	};
	/**
	* Resolve what one agent joins, and the view its calls are described through.
	* A deployment with a preset roster keeps every model-facing row on the agent
	* plane, so an agent that joins nothing reaches the model with NO tools and
	* none of the deployment's prompt sections. The id is resolved up front to
	* record it, and the join happens inside setup so a broken preset rolls the
	* whole creation back instead of publishing a toolless session.
	* @returns the composition every rung of one session's ladder applies.
	* @throws when the roster supplies no such preset.
	*/
	const composeAgent = async (sessionId) => {
		await ctx.get("loader")?.await();
		const presets = ctx.get("agentPresets");
		const presetId = presets === void 0 ? void 0 : (await presets.resolve(sessionPresets.get(sessionId) ?? config.preset)).id;
		const toolScope = presets === void 0 || presetId === void 0 ? void 0 : await presets.standingKeyFor(presetId);
		return {
			...presetId === void 0 ? {} : { presetId },
			presentCall: createCallPresenter(ctx.get("tools"), toolScope),
			setup: async (agentCtx) => {
				if (presets !== void 0 && presetId !== void 0) await presets.mount(agentCtx, presetId);
				composeChatAgent(agentCtx, config, [sendFileTool], runtimeDeniedTools);
				agentCtx.on("subagent/end", (info) => {
					const binding = bySession.get(sessionId);
					if (binding === void 0) return;
					replay.send(binding.chatId, { markdown: subagentEndLine(info) }).catch(reportSendFailure);
				});
				agentCtx.get("jobs")?.onJobDone((snapshot) => {
					if (snapshot.status === "running" || snapshot.status === "stopping") return;
					const binding = bySession.get(sessionId);
					if (binding === void 0) return;
					const terminal = {
						id: snapshot.id,
						kind: snapshot.kind,
						label: snapshot.label,
						status: snapshot.status,
						...snapshot.detail === void 0 ? {} : { detail: snapshot.detail }
					};
					replay.send(binding.chatId, { markdown: jobDoneLine(terminal) }).catch(reportSendFailure);
				});
			}
		};
	};
	/**
	* One composition per session id, shared by the resume attempt, the create
	* that follows it, and the renderer that describes the session's calls.
	* Resolving a preset re-reads the roster, and a first-contact chat walks every
	* rung, so an uncached ladder would read the roster once per rung.
	*/
	const compositions = /* @__PURE__ */ new Map();
	const compositionFor = (sessionId) => {
		let pending = compositions.get(sessionId);
		if (pending === void 0) {
			pending = composeAgent(sessionId);
			compositions.set(sessionId, pending);
			pending.catch(() => {
				compositions.delete(sessionId);
			});
		}
		return pending;
	};
	const agents = ctx.agents;
	/** Session ids created (not resumed) this boot — they get the first-contact guide. */
	const freshlyCreated = /* @__PURE__ */ new Set();
	const sessions = new ConversationSessions(config.sessionScope, {
		lookup: (sessionId) => {
			const agent = agents.get(sessionId);
			return agent === void 0 ? void 0 : {
				agent,
				dispose: () => Promise.resolve()
			};
		},
		resume: async (sessionId) => {
			const composition = await compositionFor(sessionId);
			const handle = await agents.resume({
				resumeSessionId: sessionId,
				agentOptions: modelSelection(),
				setup: composition.setup
			});
			publishSlashPanel(handle.agent);
			return handle;
		},
		create: async (sessionId) => {
			const composition = await compositionFor(sessionId);
			const workspace = await chatWorkspace();
			const handle = await agents.create({
				sessionId,
				meta: {
					cwd: workspace?.path ?? cwd,
					...composition.presetId === void 0 ? {} : { agentPreset: composition.presetId }
				},
				agentOptions: modelSelection(),
				setup: composition.setup
			});
			freshlyCreated.add(sessionId);
			if (workspace !== void 0) await workspace.attachSession(sessionId).catch((error) => {
				notify(`dsh-lark-bridge: session ${sessionId} stays ungrouped: ${String(error)}`);
			});
			publishSlashPanel(handle.agent);
			return handle;
		},
		report: (line) => {
			ctx.logger.info(line);
		}
	});
	/**
	* The renderer for one session, opened on first use and kept until the fiber
	* unwinds: it holds the turn's streaming card, which outlives any one message.
	* @param sessionId - the session whose events it renders.
	* @param msg - the message that reached this session.
	* @returns the binding, the same object for every later message of the session.
	* @throws when the session's composition cannot be resolved.
	*/
	const bindingFor = async (sessionId, msg) => {
		const existing = bySession.get(sessionId);
		if (existing !== void 0) return existing;
		const { presentCall } = await compositionFor(sessionId);
		compositions.delete(sessionId);
		const binding = {
			chatId: msg.chatId,
			chatType: msg.chatType,
			renderer: renderFor(msg.chatId, presentCall),
			currentMessageId: void 0
		};
		bySession.set(sessionId, binding);
		if (config.onboarding && freshlyCreated.delete(sessionId)) replay.send(binding.chatId, onboardingMessage()).catch(reportSendFailure);
		return binding;
	};
	/**
	* The renderer one chat's output goes through.
	*
	* `cot` shows the process as the platform's own agent messages do — reasoning
	* in a thinking area, each tool call with an icon and its result as a code
	* block — and leaves the answer to an ordinary markdown message, which is
	* where the platform says a final answer belongs. `stream` keeps the whole
	* turn in one typewriter card instead, for clients older than that surface.
	* Either way `showProcess` decides whether the process is shown at all.
	* @param chatId - the chat this renderer serves.
	* @param presentCall - the session's tool presenter.
	* @returns the renderer for the configured output.
	*/
	const renderFor = (chatId, presentCall) => {
		if (config.output === "stream") return createStreamRenderer(port, chatId, {
			showProcess: config.showProcess,
			presentCall,
			onFailure: reportSendFailure
		});
		return createCotRenderer(port, chatId, {
			showProcess: config.showProcess,
			hidden: config.hideProcessWhenDone,
			presentCall,
			onFailure: reportSendFailure,
			answer: createMessageRenderer(port, chatId, reportSendFailure)
		});
	};
	/**
	* Publish what this chat accepts to the bot's `/` panel. Reconcile is
	* idempotent (create missing, remove stale), so it runs on every session
	* acquire — a restart that resumes sessions still refreshes the panel.
	* Fire and forget: discovery is a convenience, and every command works
	* typed by hand.
	*/
	/**
	* The Loader tree as of now, flattened for the chat inventory: the bridge's
	* scoped context shares the root loader, so its entries ARE the deployment's
	* plugin tree. Structural group rows (no name) are filtered downstream.
	*/
	const loaderEntries = () => {
		try {
			return [...ctx.loader?.entries?.() ?? []];
		} catch {
			return;
		}
	};
	/** The channel-owned commands, independent of any agent's scope — the boot-time panel floor. */
	const channelCommands = (locale) => [
		{
			name: PRESET_COMMAND,
			description: describeCommand(PRESET_COMMAND, locale, "View or switch mode")
		},
		{
			name: SESSIONS_COMMAND,
			description: describeCommand(SESSIONS_COMMAND, locale, "View session history")
		},
		{
			name: TOOLS_COMMAND,
			description: describeCommand(TOOLS_COMMAND, locale, "View, deny, or allow tools")
		},
		{
			name: SCHEDULES_COMMAND,
			description: describeCommand(SCHEDULES_COMMAND, locale, "View scheduled reminders")
		},
		{
			name: JOBS_COMMAND,
			description: describeCommand(JOBS_COMMAND, locale, "View background jobs")
		},
		{
			name: AUDIT_COMMAND,
			description: describeCommand(AUDIT_COMMAND, locale, "View operation audit")
		},
		{
			name: FEEDBACK_COMMAND,
			description: describeCommand(FEEDBACK_COMMAND, locale, "Record feedback about this session")
		},
		{
			name: CONTEXT_COMMAND,
			description: describeCommand(CONTEXT_COMMAND, locale, "View context pressure")
		},
		{
			name: SKILLS_COMMAND,
			description: describeCommand(SKILLS_COMMAND, locale, "List / inspect discoverable skills")
		},
		{
			name: MODEL_COMMAND,
			description: describeCommand(MODEL_COMMAND, locale, "View or switch the default model")
		},
		{
			name: "ws",
			description: describeCommand("ws", locale, "List registered workspaces")
		},
		{
			name: PLUGINS_COMMAND,
			description: describeCommand(PLUGINS_COMMAND, locale, "List deployed plugins and status")
		},
		{
			name: CONFIG_COMMAND,
			description: describeCommand(CONFIG_COMMAND, locale, "View current configuration")
		},
		...config.restartCommand === "" ? [] : [{
			name: RESTART_COMMAND,
			description: describeCommand(RESTART_COMMAND, locale, "Restart the host process")
		}],
		{
			name: STOP_COMMAND,
			description: describeCommand(STOP_COMMAND, locale, "Stop the current task")
		},
		{
			name: HELP_COMMAND,
			description: describeCommand(HELP_COMMAND, locale, "Show available commands")
		}
	];
	const publishSlashPanel = (agent) => {
		if (!config.syncSlashCommands) return;
		const hosted = ctx.get("commands")?.list(agent) ?? [];
		const locale = config.locale;
		syncSlashPanel(port, [...hosted.map((descriptor) => ({
			name: descriptor.name,
			description: describeCommand(descriptor.name, locale, descriptor.description)
		})), ...channelCommands(locale)], notify).then(({ added, removed }) => {
			if (added.length > 0) notify(`dsh-lark-bridge: registered /${added.join(", /")} on the bot's slash panel`);
			if (removed.length > 0) notify(`dsh-lark-bridge: removed /${removed.join(", /")} from the bot's slash panel`);
		});
	};
	/** Aborts in-flight command executions when this bridge unwinds. */
	const commands = new AbortController();
	ctx.effect(() => () => {
		commands.abort();
	}, "dsh-lark-bridge:commands");
	const commandSignal = () => commands.signal;
	const handleMessage = async (msg) => {
		const refusal = refuseMessage(authorization, msg);
		if (refusal !== void 0) {
			notify(`dsh-lark-bridge: ignored a message in ${msg.chatId}: ${refusal}`);
			return;
		}
		if (msg.senderIsBot === true) return;
		if (msg.content.trim() === "") return;
		reactions?.ack(msg.messageId);
		postChronicle(config.chronicleEndpoint, {
			source: config.chronicleSource,
			text: msg.content,
			chatId: msg.chatId
		}, notify);
		try {
			const opened = await sessions.acquire(msg);
			const binding = await bindingFor(opened.handle.agent.session.id, msg);
			binding.currentMessageId = msg.messageId;
			if (msg.content.trim() === "/stop") {
				opened.handle.agent.cancel("user-requested");
				notify(`dsh-lark-bridge: preemptive /stop for session ${opened.handle.agent.session.id}`);
				await port.send(msg.chatId, { markdown: "⏹ 已停止当前任务" }).catch(reportSendFailure);
				return;
			}
			if (isCommandLine(msg.content)) {
				const sessionId = opened.handle.agent.session.id;
				const presetBefore = sessionPresets.get(sessionId);
				const outcome = await runCommandLine(msg.content, opened.handle.agent, ctx.get("commands"), commandSignal(), ctx.get("agentPresets"), ctx.get("sessionPersistence"), msg.chatId, runtimeDeniedTools, scheduleRegistry, auditStats, config, sessionPresets, ctx.get("sessionQuery"), ctx.get("jobs"), ctx.get("messageFeedback"), lastAssistantIds.get(sessionId), ctx.get("tokenMeter"), ctx.get("skills"), ctx.get("agentDefaultModel"), {
					...config.provider === void 0 ? {} : { provider: config.provider },
					...config.model === void 0 ? {} : { model: config.model }
				}, ctx.get("workspaceRegistry"), cwd, loaderEntries(), getSyncContext());
				if (sessionPresets.get(sessionId) !== presetBefore) compositions.delete(sessionId);
				if (outcome.reply !== "") await replay.send(binding.chatId, { markdown: outcome.reply }).catch(reportSendFailure);
				return;
			}
			binding.renderer.aim({
				messageId: msg.messageId,
				...msg.threadId === void 0 ? {} : { threadId: msg.threadId }
			});
			const images = await collectImages(msg, port, ctx.get("attachments"), config.attachImages);
			let fileNotes = [];
			if (config.autoSaveFiles && msg.resources?.length) try {
				fileNotes = (await saveInboundFiles(msg, (mid, fk, type) => port.downloadResourceWithMeta(mid, fk, type), config.cwd ?? process.cwd())).notes;
			} catch {}
			if (config.autoResumeGoals) {
				const agent = opened.handle.agent;
				try {
					const view = ctx.goals?.get(agent);
					if (view !== void 0 && view.goal?.phase === "active" && view.activation === "disarmed") {
						const ref = {
							id: view.goal.id,
							revision: view.goal.revision
						};
						await ctx.goals?.resume(agent, ref);
						notify(`dsh-lark-bridge: auto-resumed goal "${ref.id}" for session ${agent.session.id}`);
					}
				} catch (error) {
					notify(`dsh-lark-bridge: auto-resume skipped for session ${opened.handle.agent.session.id}: ${String(error)}`);
					ctx.logger.warn("goal auto-resume skipped: %s", error);
				}
			}
			{
				const prefix = briefingPrefix(config.briefingFile, opened.handle.agent.session.id, notify);
				const allNotes = [...images.notes, ...fileNotes];
				const spoken = allNotes.length > 0 ? msg.content + "\n" + allNotes.join("\n") : msg.content;
				const turn = chatUserMessage({
					...msg,
					content: spoken
				}, images);
				let content = prefix === "" ? turn.content : Object.freeze([{
					type: "text",
					text: prefix
				}, ...turn.content]);
				opened.handle.agent.followup({
					...turn,
					content
				});
			}
		} catch (error) {
			notify(`dsh-lark-bridge: agent creation failed for chat ${msg.chatId}: ${String(error)}`);
			ctx.logger.warn("agent creation failed for chat %s: %s", msg.chatId, error);
			await port.send(msg.chatId, { text: `⚠️ 无法启动会话：${error instanceof Error ? error.message : String(error)}` }).catch(reportSendFailure);
		}
	};
	const settleApproval = (id, outcome, decidedBy) => {
		const pending = pendingApprovals.get(id);
		if (pending === void 0) return false;
		pendingApprovals.delete(id);
		pending.clearReminder?.();
		pending.settle(outcome);
		port.updateCard(pending.messageId, settledCard(pending.toolName, outcome, decidedBy)).catch(reportSendFailure);
		return true;
	};
	const askViaCard = async (binding, request, next) => {
		const id = randomUUID();
		let sent;
		try {
			const command = request.callId === void 0 ? void 0 : pendingCallArguments.get(request.callId);
			sent = await rawPort.send(binding.chatId, { card: approvalCard(request.toolName, request.reason, command === void 0 ? void 0 : boundCardText(command), id) });
		} catch (error) {
			reportSendFailure(error);
			return next();
		}
		return new Promise((resolveOutcome) => {
			let reminder;
			if (config.approvalReminderMs > 0) reminder = setTimeout(() => {
				if (!pendingApprovals.has(id)) return;
				port.send(binding.chatId, { markdown: `⏳ 有一张审批卡等你处理（\`${request.toolName}\`）——点卡片上的按钮继续，或发 \`/stop\` 取消当前操作。` }).catch(reportSendFailure);
			}, config.approvalReminderMs);
			pendingApprovals.set(id, {
				chatId: binding.chatId,
				chatType: binding.chatType,
				messageId: sent.messageId,
				toolName: request.toolName,
				...reminder === void 0 ? {} : { clearReminder: () => clearTimeout(reminder) },
				settle: resolveOutcome
			});
			request.signal?.addEventListener("abort", () => {
				settleApproval(id, "cancelled");
			}, { once: true });
		});
	};
	/**
	* Drive a goal card's buttons: pause / resume / clear. The buttons carry the
	* session id, so a click from elsewhere is refused before touching the goal.
	*/
	const handleGoalCardAction = (evt, value) => {
		const binding = bySession.get(value.sessionId);
		if (binding === void 0 || binding.chatId !== evt.chatId) return { toast: {
			type: "info",
			content: "该目标卡已失效"
		} };
		const clickRefusal = refuseApprovalClick(authorization, {
			operatorId: evt.operator.openId,
			chatId: evt.chatId
		}, {
			chatId: binding.chatId,
			chatType: binding.chatType
		});
		if (clickRefusal !== void 0) {
			notify(`dsh-lark-bridge: rejected a goal click: ${clickRefusal}`);
			return { toast: {
				type: "error",
				content: "你无权操作此目标"
			} };
		}
		const agent = agents.get(value.sessionId);
		if (agent === void 0) return { toast: {
			type: "info",
			content: "该会话当前不在线"
		} };
		const goals = ctx.goals;
		if (goals === void 0) return { toast: {
			type: "error",
			content: "目标服务不可用"
		} };
		const view = goals.get(agent);
		if (view?.goal === void 0) return { toast: {
			type: "info",
			content: "当前没有目标"
		} };
		const ref = {
			id: view.goal.id,
			revision: view.goal.revision
		};
		try {
			const labels = {
				pause: "已暂停",
				resume: "已继续",
				clear: "已清除"
			};
			if (value.operation === "pause") goals.pause(agent, ref);
			else if (value.operation === "resume") goals.resume(agent, ref);
			else goals.clear(agent, ref);
			notify(`dsh-lark-bridge: goal ${value.operation} for session ${value.sessionId}`);
			return { toast: {
				type: "success",
				content: labels[value.operation]
			} };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			notify(`dsh-lark-bridge: goal ${value.operation} failed for session ${value.sessionId}: ${detail}`);
			return { toast: {
				type: "error",
				content: `操作失败：${detail}`
			} };
		}
	};
	const handleCardAction = (evt) => {
		const questionResponse = questions.handleCardAction(evt);
		if (questionResponse !== void 0) return questionResponse;
		const goalValue = goalActionValue(evt.action.value);
		if (goalValue !== void 0) return handleGoalCardAction(evt, goalValue);
		const value = approvalActionValue(evt.action.value);
		if (value === void 0) return void 0;
		const pending = pendingApprovals.get(value.id);
		if (pending === void 0) return { toast: {
			type: "info",
			content: "该审批已失效"
		} };
		const clickRefusal = refuseApprovalClick(authorization, {
			operatorId: evt.operator.openId,
			chatId: evt.chatId
		}, pending);
		if (clickRefusal !== void 0) {
			notify(`dsh-lark-bridge: rejected an approval click: ${clickRefusal}`);
			return { toast: {
				type: "error",
				content: "你无权批准此操作"
			} };
		}
		const outcome = value.decision === "allow" ? "allowed-once" : "rejected";
		const decidedBy = evt.operator.name ?? evt.operator.openId;
		if (!settleApproval(value.id, outcome, decidedBy)) return { toast: {
			type: "info",
			content: "该审批已失效"
		} };
		return { toast: {
			type: value.decision === "allow" ? "success" : "info",
			content: value.decision === "allow" ? "已允许执行一次" : "已拒绝"
		} };
	};
	ctx.effect(() => replay.on("message", (msg) => {
		handleMessage(msg);
	}), "dsh-lark-bridge:on(message)");
	ctx.effect(() => replay.on("cardAction", handleCardAction), "dsh-lark-bridge:on(cardAction)");
	ctx.effect(() => replay.on("reject", (evt) => {
		if (evt.reason === "no_mention") {
			ctx.logger.debug("rejected %s in %s: %s", evt.messageId, evt.chatId, evt.reason);
			return;
		}
		ctx.logger.info("rejected %s in %s from %s: %s", evt.messageId, evt.chatId, evt.senderId, evt.reason);
		if (evt.reason === "bot_loop") notify(`dsh-lark-bridge: bot loop guard tripped in chat ${evt.chatId} — traffic from bots is being refused`);
	}), "dsh-lark-bridge:on(reject)");
	ctx.effect(() => replay.on("error", (error) => {
		notify(`dsh-lark-bridge: transport error [${error.code}]: ${error.message}`);
		ctx.logger.warn("transport error [%s]: %s", error.code, error.message);
	}), "dsh-lark-bridge:on(error)");
	ctx.effect(() => replay.on("reconnecting", () => {
		replay.setConnected(false);
		notify("dsh-lark-bridge: connection lost, reconnecting — outbound is queued and will replay once restored");
		ctx.logger.warn("connection lost, reconnecting");
	}), "dsh-lark-bridge:on(reconnecting)");
	ctx.effect(() => replay.on("reconnected", () => {
		replay.setConnected(true);
		notify("dsh-lark-bridge: connection restored");
		ctx.logger.info("connection restored");
	}), "dsh-lark-bridge:on(reconnected)");
	if (config.syncSlashCommands) {
		const floor = channelCommands(config.locale);
		(async () => {
			for (let attempt = 1; attempt <= 3; attempt += 1) try {
				const { added } = await syncSlashPanel(port, floor, notify);
				if (added.length > 0) notify(`dsh-lark-bridge: registered /${added.join(", /")} on the bot's slash panel`);
				return;
			} catch {
				if (attempt === 3) return;
				await new Promise((resolve) => setTimeout(resolve, attempt * 15e3));
			}
		})();
	}
	ctx.on("workflow/phase", (info, title) => {
		const chatId = workflowChats.get(info.id);
		if (chatId === void 0) return;
		replay.send(chatId, { markdown: phaseLine(title) }).catch(reportSendFailure);
	});
	ctx.on("workflow/log", (info, message) => {
		const chatId = workflowChats.get(info.id);
		if (chatId === void 0) return;
		replay.send(chatId, { markdown: workflowLogLine(message) }).catch(reportSendFailure);
	});
	ctx.on("session/event", (session, event) => {
		const binding = bySession.get(session.id);
		if (binding === void 0) return;
		{
			let stats = auditStats.get(session.id);
			if (stats === void 0) {
				stats = {
					startedAt: Date.now(),
					turns: 0,
					steps: 0,
					toolCalls: 0,
					turnErrors: 0,
					compactions: 0,
					retries: 0,
					subagents: 0,
					workflows: 0,
					schedules: 0
				};
				auditStats.set(session.id, stats);
			}
			if (isToolCallEvent(event)) stats.toolCalls += 1;
			else if (isTurnEndEvent(event)) {
				stats.turns += 1;
				if (event.data.reason.kind === "error") stats.turnErrors += 1;
			} else if (isStepStartEvent(event)) stats.steps += 1;
			else if (isCompactionStartEvent(event)) stats.compactions += 1;
			else if (isLlmRetryEvent(event)) stats.retries += 1;
			else if (isSubagentDescriptorEvent(event)) stats.subagents += 1;
			else if (isWorkflowRunStartEvent(event)) stats.workflows += 1;
			else if (isScheduleChangeEvent(event)) stats.schedules += 1;
		}
		if (isAssistantMessageEvent(event)) lastAssistantIds.set(session.id, event.data.message.id);
		if (isToolCallEvent(event)) pendingCallArguments.set(event.data.callId, event.data.arguments);
		else if (isTurnEndEvent(event)) pendingCallArguments.clear();
		if (reactions !== void 0 && binding.currentMessageId !== void 0) {
			if (isStepStartEvent(event)) reactions.working(binding.currentMessageId);
			else if (isTurnEndEvent(event)) {
				if (event.data.reason.kind === "error") reactions.fail(binding.currentMessageId);
				else reactions.done(binding.currentMessageId);
				binding.currentMessageId = void 0;
			}
		}
		if (isTodoWriteEvent(event)) {
			const items = event.data.todos.filter((item) => item.status === "pending" || item.status === "in_progress" || item.status === "completed");
			todos.handle(session.id, binding.chatId, items);
		}
		if (isGoalChangeEvent(event)) {
			const goal = event.data.goal;
			if (goal !== void 0 && (goal.phase === "active" || goal.phase === "paused" || goal.phase === "blocked" || goal.phase === "complete")) goals.handle(session.id, binding.chatId, {
				operation: event.data.operation,
				goal: {
					objective: goal.objective,
					phase: goal.phase,
					...goal.blockedReason !== void 0 ? { blockedReason: goal.blockedReason } : {},
					...goal.maxGoalRounds !== void 0 ? { maxGoalRounds: goal.maxGoalRounds } : {}
				}
			});
		}
		if (isWorkflowRunStartEvent(event)) {
			workflowChats.set(event.data.runId, binding.chatId);
			replay.send(binding.chatId, { markdown: runStartLine(event.data) }).catch(reportSendFailure);
		} else if (isWorkflowAgentStartEvent(event)) replay.send(binding.chatId, { markdown: agentStartLine(event.data) }).catch(reportSendFailure);
		else if (isWorkflowAgentEndEvent(event)) replay.send(binding.chatId, { markdown: agentEndLine(event.data) }).catch(reportSendFailure);
		else if (isWorkflowRunEndEvent(event)) {
			workflowChats.delete(event.data.runId);
			replay.send(binding.chatId, { markdown: runEndLine(event.data) }).catch(reportSendFailure);
		}
		if (isCompactionStartEvent(event)) replay.send(binding.chatId, { markdown: "📦 上下文较长，正在压缩（较早内容将被摘要）…" }).catch(reportSendFailure);
		else if (isCompactionSummaryEvent(event)) replay.send(binding.chatId, { markdown: compactionSummaryLine(event.data) }).catch(reportSendFailure);
		else if (isCompactionPruneEvent(event)) replay.send(binding.chatId, { markdown: compactionPruneLine(event.data) }).catch(reportSendFailure);
		else if (isCompactionEndEvent(event)) {
			if (event.data.error !== void 0) replay.send(binding.chatId, { markdown: `⚠️ 上下文压缩失败：${event.data.error}` }).catch(reportSendFailure);
		}
		if (isSubagentDescriptorEvent(event)) {
			let tracker = subagentTrackers.get(binding.chatId);
			if (tracker === void 0) {
				tracker = createTracker();
				subagentTrackers.set(binding.chatId, tracker);
			}
			const childKey = `child-${tracker.entries.size + 1}-${Date.now()}`;
			addEntry(tracker, childKey, event.data);
			const card = render(tracker);
			replay.send(binding.chatId, { card }).catch(reportSendFailure);
		}
		if (isScheduleChangeEvent(event)) {
			const line = scheduleLine({
				operation: event.data.operation,
				...event.data.schedule === void 0 ? {} : {
					kind: event.data.schedule.kind,
					prompt: event.data.schedule.prompt
				}
			});
			if (line !== void 0) replay.send(binding.chatId, { markdown: line }).catch(reportSendFailure);
			const id = event.data.schedule?.id ?? event.data.id;
			const sessionId = session.id;
			if (id !== void 0) {
				let byId = scheduleRegistry.get(sessionId);
				if (event.data.operation === "create" && event.data.schedule !== void 0) {
					if (byId === void 0) {
						byId = /* @__PURE__ */ new Map();
						scheduleRegistry.set(sessionId, byId);
					}
					byId.set(id, {
						id,
						kind: event.data.schedule.kind,
						prompt: event.data.schedule.prompt,
						...event.data.schedule.everySeconds === void 0 ? {} : { everySeconds: event.data.schedule.everySeconds },
						createdAt: Date.now()
					});
				} else if (byId !== void 0) {
					if (event.data.operation === "delete") byId.delete(id);
					else if (event.data.operation === "dispatch" && event.data.schedule?.kind === "after") byId.delete(id);
					if (byId.size === 0) scheduleRegistry.delete(sessionId);
				}
			}
		}
		if (isWebSearchRequestEvent(event)) replay.send(binding.chatId, { markdown: webSearchLine() }).catch(reportSendFailure);
		if (isLlmRetryEvent(event)) {
			const line = retryLine(event.data);
			if (line !== void 0) replay.send(binding.chatId, { markdown: line }).catch(reportSendFailure);
		}
		binding.renderer.handle(event);
	});
	ctx.on("approval/request", (request, next) => {
		const binding = bySession.get(request.agent.session.id);
		if (binding === void 0) return next();
		return askViaCard(binding, request, next);
	}, { prepend: true });
	ctx.effect(() => () => {
		if (pressureTimer !== void 0) clearInterval(pressureTimer);
		for (const [id, pending] of [...pendingApprovals]) {
			pendingApprovals.delete(id);
			pending.settle("cancelled");
		}
		disposeQuestions?.();
		const bindings = [...bySession.values()];
		bySession.clear();
		compositions.clear();
		pendingCallArguments.clear();
		lastAssistantIds.clear();
		goals.dispose();
		todos.dispose();
		for (const binding of bindings) if (binding.currentMessageId !== void 0) reactions?.forget(binding.currentMessageId);
		return Promise.allSettled([sessions.close(), ...bindings.map((binding) => binding.renderer.close())]).then(() => void 0);
	}, "dsh-lark-bridge:agents");
	ctx.effect(() => {
		replay.connect().catch((error) => {
			notify(`dsh-lark-bridge: connect failed: ${error instanceof Error ? error.message : String(error)}`);
			ctx.logger.error("dsh-lark-bridge channel connect failed: %s", error);
		});
		return () => replay.disconnect().catch(reportSendFailure);
	}, "dsh-lark-bridge:connect");
}
//#endregion
//#region lib/types/onboarding.js
/**
* First-boot credential acquisition through the official Lark QR device-code
* flow (`registerApp`): a scannable code is shown on the console, the scanning
* user confirms app creation in Feishu (event subscription is configured by
* that flow), and the resulting credentials are handed back for persistence and
* connection.
*
* A code expires after a window the platform states when it issues one. Nobody
* scanning inside that window is the ordinary case — an operator installs the
* plugin, the process starts, and they get to it later — so an expired code is
* re-issued rather than reported as a failure. Every other rejection stops: a
* refused authorization or a rejected request needs a human decision, and a new
* code would not supply one.
* @module dsh-lark-bridge/onboarding
*/
/**
* What the app-creation page is pre-filled with.
*
* Everything here rides on the QR URL, so it carries as little as possible: no
* `addons`, because the platform's own base template already grants the bot
* capability and the message scopes and event subscription this channel needs —
* additive increments only lengthened the URL. No `createOnly` either, so
* selecting an existing app stays available; that page shows the config diff
* and asks the user to re-authorize explicitly.
*/
const REGISTRATION_PRESET = {
	source: "dsh-lark-bridge",
	appPreset: {
		name: "DSH Agent",
		desc: "DSH 会话机器人"
	}
};
/** The rejection code the flow reports when nobody scanned before the code expired. */
const EXPIRED_CODE = "expired_token";
/**
* Shortest gap between two issued codes.
*
* A code that ran its course already took its full validity window, so this
* never delays a real re-issue. It bounds the one case that would otherwise
* spin: a platform that reports a code expired the moment it is issued.
*/
const REISSUE_FLOOR_MS = 6e4;
/**
* Read the flow's own rejection code.
* @param error - the rejection value, of any shape.
* @returns the code, or undefined for a rejection that carries none.
*/
function rejectionCode(error) {
	if (typeof error !== "object" || error === null || !("code" in error)) return void 0;
	const { code } = error;
	return typeof code === "string" ? code : void 0;
}
/**
* Render one rejection as an operator-readable reason.
* @param error - the rejection value, which is usually neither an `Error` nor a string.
* @returns the message, the `code: description` pair, or the stringified value.
*/
function rejectionDetail(error) {
	if (error instanceof Error) return error.message;
	const code = rejectionCode(error);
	if (code === void 0) return String(error);
	const { description } = error;
	return typeof description === "string" ? `${code}: ${description}` : code;
}
/**
* Draw one URL as a QR code for the console.
*
* Rendered unconditionally rather than only for an interactive terminal: a
* deployment whose console is a log file is exactly the one whose operator
* cannot browse the URL on the host, and block characters survive being read
* back out of that file.
* @param url - the registration URL to encode.
* @returns the drawn code, or undefined when it could not be drawn.
*/
async function drawQrCode(url) {
	return new Promise((resolve) => {
		try {
			qrcode.generate(url, { small: true }, (drawn) => {
				resolve(drawn);
			});
		} catch {
			resolve(void 0);
		}
	});
}
/** Sleep, resolving early when the flow unwinds. */
async function delay(ms, signal) {
	if (ms <= 0 || signal.aborted) return;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve();
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Start the QR onboarding flow as a fiber-owned effect. The pending scan is
* withdrawn on disposal; a completed scan persists first, then hands the
* credentials to `onCredentials` unless the fiber already unwound. An expired
* code is replaced by a fresh one for as long as this fiber lives.
* @param run - the surfaces to drive and the sinks to report through.
*/
function beginOnboarding(run) {
	const { ctx, register, notify, persist, onCredentials, appId } = run;
	const floorMs = run.reissueFloorMs ?? REISSUE_FLOOR_MS;
	const announce = (line) => {
		notify(line);
		ctx.logger.info(line);
	};
	ctx.effect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		/** Drive one code to a scan, or to the reason it produced none. */
		const issue = async (round) => register({
			...REGISTRATION_PRESET,
			...appId === void 0 || appId === "" ? {} : { appId },
			signal,
			onQRCodeReady({ url, expireIn }) {
				const minutes = String(Math.round(expireIn / 60));
				announce(round === 0 ? `dsh-lark-bridge: 未配置应用凭证。用飞书扫下面的二维码创建应用（或在已登录飞书的浏览器打开链接），${minutes} 分钟内有效：` : `dsh-lark-bridge: 上一个二维码已过期，这是第 ${String(round + 1)} 个，同样 ${minutes} 分钟内有效：`);
				drawQrCode(url).then((drawn) => {
					if (signal.aborted) return;
					if (drawn !== void 0) notify(`\n${drawn}`);
					announce(`  ${url}\n`);
				});
			}
		});
		(async () => {
			for (let round = 0; !signal.aborted; round++) {
				const startedAt = Date.now();
				let result;
				try {
					result = await issue(round);
				} catch (error) {
					if (signal.aborted) return;
					if (rejectionCode(error) !== EXPIRED_CODE) {
						announce(`dsh-lark-bridge: 应用注册失败：${rejectionDetail(error)}（重启进程可重新发起）`);
						return;
					}
					await delay(floorMs - (Date.now() - startedAt), signal);
					continue;
				}
				if (signal.aborted) return;
				const scanned = result.user_info?.open_id;
				const credentials = {
					appId: result.client_id,
					appSecret: result.client_secret,
					...scanned === void 0 || scanned === "" ? {} : { registeredBy: scanned }
				};
				const persisted = await persist(credentials).catch((error) => {
					announce(`dsh-lark-bridge: 凭证持久化失败：${rejectionDetail(error)}`);
					return false;
				});
				if (signal.aborted) return;
				announce(persisted ? `dsh-lark-bridge: 应用 ${credentials.appId} 注册成功，凭证已写入用户设置。` + (credentials.registeredBy === void 0 ? "" : ` 注册者：${credentials.registeredBy}（需要收窄时可填入 senderAllowlist / approvers）。`) : `dsh-lark-bridge: 应用 ${credentials.appId} 注册成功，但当前组合没有 settings 存储——凭证仅本次进程有效。要跨重启保留，请设置 LARK_APP_ID/LARK_APP_SECRET。`);
				onCredentials(credentials);
				return;
			}
		})().catch((error) => {
			if (signal.aborted) return;
			announce(`dsh-lark-bridge: 应用注册失败：${rejectionDetail(error)}（重启进程可重新发起）`);
		});
		return () => {
			controller.abort();
		};
	}, "dsh-lark-bridge:onboarding");
}
//#endregion
//#region lib/types/runtime.js
/**
* Runtime boundary and Cordis activation for the plugin.
* @module dsh-lark-bridge/runtime
*/
/** The app-config endpoint for the bot's slash-command panel; the SDK has no method for it. */
const SLASH_COMMAND_API = "/open-apis/application/v7/app_slash_commands";
/**
* The thinking-process endpoint: `POST` opens one, `PUT` appends events, and a
* terminal `RUN_FINISHED` closes it without a further call.
*/
const COT_API = "/open-apis/im/v1/message_cot";
/** The user-settings namespace holding this plugin's section (onboarded credentials included). */
const SETTINGS_NAMESPACE = "dsh-lark-bridge";
/**
* Narrow a resolved configuration to one carrying live credentials.
* @param config - resolved plugin configuration.
* @returns whether both credential fields are non-empty strings.
*/
function hasCredentials(config) {
	return typeof config.appId === "string" && config.appId !== "" && typeof config.appSecret === "string" && config.appSecret !== "";
}
/**
* Create the production Lark transport from resolved configuration.
* @param config - resolved plugin configuration with credentials.
* @returns the real `@larksuite/channel` client behind the bridge's port surface.
*/
function createLarkChannelPort(config, authorization) {
	const policy = { requireMention: config.requireMention };
	if (authorization.directSenders.size > 0) {
		policy.dmMode = "allowlist";
		policy.dmAllowlist = [...authorization.directSenders];
	}
	if (config.groupAllowlist.length > 0) policy.groupAllowlist = config.groupAllowlist;
	const options = {
		appId: config.appId,
		appSecret: config.appSecret,
		policy,
		source: "dsh-lark-bridge"
	};
	if (config.domain !== void 0) options.domain = config.domain;
	if (config.outbound?.allowedFileDirs !== void 0) options.outbound = { allowedFileDirs: config.outbound.allowedFileDirs };
	options.keepalive = {
		enabled: true,
		intervalMs: 15e3,
		onUnrecoverable: (error) => {
			const detail = error instanceof Error ? error.message : String(error);
			process.stderr.write(`dsh-lark-bridge: connection unrecoverable — restarting the process is likely needed: ${detail}\n`);
		}
	};
	const channel = createLarkChannel(options);
	const nativeAddReaction = channel.addReaction.bind(channel);
	const nativeRemoveReaction = channel.removeReaction.bind(channel);
	const raw = channel.rawClient;
	return Object.assign(channel, {
		async listSlashCommands() {
			return ((await raw.request({
				method: "GET",
				url: `${SLASH_COMMAND_API}?page_size=50`
			})).data?.items ?? []).filter((item) => typeof item.command === "string" && typeof item.command_id === "string").map((item) => ({
				command: item.command,
				commandId: item.command_id,
				...item.description?.default_value === void 0 ? {} : { description: item.description.default_value }
			}));
		},
		async deleteSlashCommand(commandId) {
			await raw.request({
				method: "DELETE",
				url: `${SLASH_COMMAND_API}/${commandId}`
			});
		},
		async createCot(chatId, options) {
			const response = await raw.request({
				method: "POST",
				url: `${COT_API}?receive_id_type=chat_id`,
				data: {
					receive_id: chatId,
					...options.replyTo === void 0 ? {} : { origin_message_id: options.replyTo },
					cot_hidden: options.hidden,
					enable_badge: false,
					update_feed_rank: false
				}
			});
			const cotId = response.data?.cot_id;
			const messageId = response.data?.message_id;
			if (cotId === void 0 || messageId === void 0) throw new Error("dsh-lark-bridge: the platform returned no cot_id/message_id");
			return {
				cotId,
				messageId
			};
		},
		async writeCotEvents(handle, events) {
			await raw.request({
				method: "PUT",
				url: COT_API,
				data: {
					events,
					message_id: handle.messageId,
					cot_id: handle.cotId
				}
			});
		},
		async createSlashCommand(command, description) {
			await raw.request({
				method: "POST",
				url: SLASH_COMMAND_API,
				data: {
					command,
					description: { default_value: description }
				}
			});
		},
		async addReaction(messageId, emojiType) {
			return await nativeAddReaction(messageId, emojiType);
		},
		async removeReaction(messageId, reactionId) {
			await nativeRemoveReaction(messageId, reactionId);
		}
	});
}
/** Substitutable production boundaries; tests replace them with fakes. */
const internals = {
	createPort: createLarkChannelPort,
	registerApp,
	notify: (line) => void process.stderr.write(`${line}\n`)
};
/**
* Apply the plugin to its Cordis context. With credentials configured (entry
* config or a stored settings section) the transport connects directly;
* without them the official QR registration flow runs first and persists the
* scanned credentials through the host `settings` service when one is composed.
* @param ctx - Scoped plugin context; requires the `agents` service.
* @param config - Configuration resolved by Cordis from the exported schema.
*/
function apply(ctx, config) {
	let active = true;
	let started = false;
	ctx.effect(() => () => {
		active = false;
	}, "dsh-lark-bridge:lifetime");
	/**
	* Install the bridge once credentials are known, stating this channel's reach
	* on the console: who it serves is a security fact its operator must see, and
	* a groups-only channel (no owner configured yet) is a valid deployment.
	*/
	const start = (resolved) => {
		if (!active || started) return;
		started = true;
		const authorization = resolveAuthorization(resolved);
		internals.notify(describeAuthorization(authorization));
		installBridge(ctx, resolved, internals.createPort(resolved, authorization), internals.notify, authorization);
	};
	/**
	* Dual-end sync layer: control API + peer heartbeat. Failures degrade to a
	* log line — a dead sync layer must never take the Feishu channel down.
	*/
	const startSyncLayer = (resolved) => {
		if (!active) return;
		const form = process.env.DSH_FORM === "desktop" ? "desktop" : "web";
		const profile = process.env.DSH_PROFILE ?? "web";
		const harnessHome = process.env.DSH_HOME ?? (process.env.HOME === void 0 ? void 0 : `${process.env.HOME}/.dsh`);
		const token = `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		let started = false;
		startControlApi({
			profile,
			form,
			bridgeVersion: process.env.npm_package_version ?? "dev",
			manifest: () => Promise.resolve().then(() => profile_manifest_exports).then((m) => m.readProfileManifest(harnessHome ?? `${os.homedir()}/.dsh`, profile))
		}, token, resolved.controlPort).then((server) => {
			if (!active) {
				server.close();
				return;
			}
			started = true;
			const manifestSnapshot = () => Promise.resolve().then(() => profile_manifest_exports).then(async (m) => {
				const read = await m.readProfileManifest(harnessHome ?? `${os.homedir()}/.dsh`, profile);
				return read === null ? void 0 : {
					profile: read.profile,
					dependencies: read.dependencies,
					bundles: read.bundles
				};
			}).catch(() => void 0);
			const publish = () => {
				manifestSnapshot().then((manifest) => heartbeat(selfEntry(form, profile, process.env.npm_package_version ?? "dev", server.port, token, manifest), harnessHome)).catch(() => {});
			};
			publish();
			const timer = setInterval(publish, 15e3);
			timer.unref?.();
			setSyncContext({
				home: harnessHome,
				form,
				profile,
				bridgeVersion: process.env.npm_package_version ?? "dev",
				controlPort: server.port,
				controlToken: token,
				harnessHome
			});
			ctx.logger.info("dual-end sync layer up: profile=%s form=%s control=127.0.0.1:%s", profile, form, server.port);
			ctx.effect(() => () => {
				clearInterval(timer);
				server.close();
			}, "dsh-lark-bridge:sync-lifetime");
		}).catch((error) => {
			ctx.logger.error("dual-end sync layer failed to start (channel unaffected): %s", error instanceof Error ? error.message : error);
		});
		if (!started) return;
	};
	const bootstrap = async () => {
		await ctx.get("loader")?.await();
		if (!active) return;
		let resolved = resolveConfig(config);
		let persist = async (_app) => false;
		const settings = ctx.get("settings");
		if (settings !== void 0) try {
			const scope = settings.register(SETTINGS_NAMESPACE, Config, { base: config });
			resolved = resolveConfig(scope.get());
			persist = async (credentials) => {
				await scope.update(credentials);
				return true;
			};
		} catch (error) {
			ctx.logger.error("settings registration failed; continuing with entry config only: %s", error instanceof Error ? error.message : error);
		}
		try {
			const shared = await readSettings();
			const touched = Object.keys(shared).length;
			if (touched > 0) {
				resolved = resolveConfig({
					...resolved,
					...shared
				});
				ctx.logger.info("dual-end sync: %d shared key(s) overlaid onto the boot config", touched);
			}
		} catch (error) {
			ctx.logger.error("dual-end sync: shared settings overlay failed: %s", error instanceof Error ? error.message : error);
		}
		startSyncLayer(resolved);
		if (hasCredentials(resolved)) {
			start(resolved);
			return;
		}
		const base = resolved;
		beginOnboarding({
			ctx,
			register: internals.registerApp,
			notify: internals.notify,
			persist,
			onCredentials: (app) => {
				start({
					...base,
					...app
				});
			},
			appId: resolved.appId,
			...internals.reissueFloorMs === void 0 ? {} : { reissueFloorMs: internals.reissueFloorMs }
		});
	};
	bootstrap().catch((error) => {
		ctx.logger.error("dsh-lark-bridge bootstrap failed: %s", error instanceof Error ? error.message : error);
	});
}
//#endregion
//#region lib/types/index.js
/**
* Lark/Feishu IM bot channel for DeepSeek Harness: each chat drives its own
* agent, committed assistant output returns as chat messages, and approval
* questions become interactive cards.
* @module dsh-lark-bridge
*/
/** Cordis plugin name; keep this stable after publishing. */
const name = "dsh-lark-bridge";
/** Services that must exist before the plugin is applied. */
const inject = ["agents", "goals"];
//#endregion
export { Config as i, name as n, apply as r, inject as t };
