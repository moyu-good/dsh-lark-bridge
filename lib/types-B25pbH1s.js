import z from "@deepseek-ai/schemastery";
import os, { homedir } from "node:os";
import fs, { appendFileSync, mkdirSync, promises, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLarkChannel, registerApp } from "@larksuite/channel";
import { createHash, randomUUID } from "node:crypto";
import path, { join, resolve } from "node:path";
import fsp, { readFile } from "node:fs/promises";
import { exec, execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
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
/**
* Default elision budgets, sized for a session someone is working in.
*
* The earlier fixed values (3 lines / 240 chars for a result, 120 chars per
* argument, 700 for a job tail) were tuned for a chat read in passing, and lost
* exactly the lines that answer "why did it fail": the last lines of a build
* log, the middle of a command. The caps still exist — a 10k-line log must not
* turn one card into a wall — they are just far enough out to keep the useful
* part. `userMessageChars` stays under the 4096-character event bound.
*/
const DEFAULT_LIMITS = {
	toolResultLines: 10,
	toolResultChars: 1600,
	toolArgChars: 400,
	userMessageChars: 3e3,
	quoteChars: 6e3,
	jobTailChars: 2500,
	approvalArgChars: 1e3,
	skillPreviewChars: 2e3,
	searchSnippetChars: 200,
	sessionPromptChars: 120,
	schedulePromptChars: 120
};
/**
* Apply defaults to a configured set of elision budgets.
* @param config - the configured budgets, when any.
* @returns every budget, with defaults filled in.
*/
function resolveLimits(config) {
	return {
		toolResultLines: config?.toolResultLines ?? DEFAULT_LIMITS.toolResultLines,
		toolResultChars: config?.toolResultChars ?? DEFAULT_LIMITS.toolResultChars,
		toolArgChars: config?.toolArgChars ?? DEFAULT_LIMITS.toolArgChars,
		userMessageChars: config?.userMessageChars ?? DEFAULT_LIMITS.userMessageChars,
		quoteChars: config?.quoteChars ?? DEFAULT_LIMITS.quoteChars,
		jobTailChars: config?.jobTailChars ?? DEFAULT_LIMITS.jobTailChars,
		approvalArgChars: config?.approvalArgChars ?? DEFAULT_LIMITS.approvalArgChars,
		skillPreviewChars: config?.skillPreviewChars ?? DEFAULT_LIMITS.skillPreviewChars,
		searchSnippetChars: config?.searchSnippetChars ?? DEFAULT_LIMITS.searchSnippetChars,
		sessionPromptChars: config?.sessionPromptChars ?? DEFAULT_LIMITS.sessionPromptChars,
		schedulePromptChars: config?.schedulePromptChars ?? DEFAULT_LIMITS.schedulePromptChars
	};
}
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
	busyPolicy: z.union([
		"queue",
		"steer",
		"inject"
	]).default("queue"),
	showProcess: z.boolean().default(true),
	attachImages: z.boolean().default(false),
	hideProcessWhenDone: z.boolean().default(false),
	showMessageTime: z.boolean().default(true),
	syncSlashCommands: z.boolean().default(true),
	chronicleEndpoint: z.string().default(""),
	briefingFile: z.string().default(""),
	autoSaveFiles: z.boolean().default(true),
	presentBridge: z.boolean().default(true),
	announceSubagents: z.boolean().default(true),
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
	}),
	limits: z.object({
		toolResultLines: z.number().min(1),
		toolResultChars: z.number().min(1),
		toolArgChars: z.number().min(1),
		userMessageChars: z.number().min(1),
		quoteChars: z.number().min(1),
		jobTailChars: z.number().min(1),
		approvalArgChars: z.number().min(1),
		skillPreviewChars: z.number().min(1),
		searchSnippetChars: z.number().min(1),
		sessionPromptChars: z.number().min(1),
		schedulePromptChars: z.number().min(1)
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
		busyPolicy: config.busyPolicy ?? "queue",
		showProcess: config.showProcess ?? true,
		attachImages: config.attachImages ?? false,
		hideProcessWhenDone: config.hideProcessWhenDone ?? false,
		showMessageTime: config.showMessageTime ?? true,
		syncSlashCommands: config.syncSlashCommands ?? true,
		chronicleEndpoint: config.chronicleEndpoint ?? "",
		controlPort: config.controlPort ?? 0,
		chronicleSource: config.chronicleSource ?? "lark-bridge",
		briefingFile: config.briefingFile ?? "",
		autoSaveFiles: config.autoSaveFiles ?? true,
		presentBridge: config.presentBridge ?? true,
		announceSubagents: config.announceSubagents ?? true,
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
		},
		limits: resolveLimits(config.limits)
	};
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
const FILE_NAME$2 = "settings.json";
const LOCK_NAME = "settings.lock";
const LOCK_STALE_MS = 1e4;
/** Absolute path of the shared sync directory (`$DSH_HOME/dsh-lark-bridge`). */
function syncDir(home) {
	const base = process.env.DSH_SYNC_HOME ?? home ?? process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
	return path.join(base, DIR_NAME);
}
/** Absolute path of the shared settings file. */
function settingsFile(home) {
	return path.join(syncDir(home), FILE_NAME$2);
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
	const tmp = path.join(dir, `.${FILE_NAME$2}.${process.pid}.tmp`);
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
const DEVICE_STATE_NAME = "device-state.json";
/** Absolute path of this machine's device-state file. */
function deviceStateFile(home) {
	return path.join(syncDir(home), DEVICE_STATE_NAME);
}
/** Read this machine's device state, or `{}` when absent/corrupt. */
async function readDeviceState(home) {
	try {
		const parsed = JSON.parse(await fsp.readFile(deviceStateFile(home), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}
/** Persist this machine's device state. */
async function writeDeviceState(state, home) {
	const file = deviceStateFile(home);
	await fsp.mkdir(path.dirname(file), { recursive: true });
	await fsp.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
/**
* A digest of this machine's own identifiers.
*
* Only identifiers that survive a rename belong here. The hostname does
* not: a host that gets renamed — a WSL distribution, a container, a cloud
* instance — would otherwise look like a different machine, and the check
* that follows would re-mint this device's identity and clear the retired
* flag that an operator set on purpose. The stable sources are the machine
* id on Linux (both the systemd one and the dbus one) and the machine guid
* on Windows.
*
* A host with none of those is identified by its hostname, and by nothing
* else: two such hosts that share a name are indistinguishable, which the
* caller has to know when it reads the digest.
* @returns a hex digest, or undefined when the host offers no identifier.
*/
function machineFingerprint() {
	const stable = [];
	for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) try {
		const value = readFileSync(file, "utf8").trim();
		if (value !== "") stable.push(value);
	} catch {}
	if (stable.length > 0) return createHash("sha256").update(stable.join("\0")).digest("hex").slice(0, 32);
	const host = os.hostname();
	if (host === "") return void 0;
	return createHash("sha256").update(`hostname\u0000${host}`).digest("hex").slice(0, 32);
}
/**
* The digest the fingerprint used to be: the machine id AND the hostname.
*
* It was wrong — a rename changed the digest — but the state file on disk
* may still carry it, and a device that was recorded under the old digest
* is the very same device. A state whose digest matches this one is the
* same machine, so it keeps its identity and its retired flag.
* @returns a hex digest, or undefined when the host offers no identifier.
*/
function legacyMachineFingerprint() {
	const parts = [];
	try {
		parts.push(readFileSync("/etc/machine-id", "utf8").trim());
	} catch {}
	parts.push(os.hostname());
	if (parts.every((part) => part === "")) return void 0;
	return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}
/**
* This machine's stable identity, minted into device-state.json on first
* use. Hostname and pid are NOT identity (both drift); a device keeps its id
* across restarts and form switches, and a NEW machine mints its own — the
* file never travels with a migration (only per-machine state lives there).
*
* A copied state file is the one way that promise breaks, so the state
* carries a digest of the machine it was minted on. When the digest does not
* match, the file belongs to another machine: the identity is re-minted and
* the retired flag goes with it, because a retirement belongs to the machine
* that asked for it.
* @param home - the sync home; defaults to this machine's.
* @param options - an explicit fingerprint, for tests.
* @returns the identity this machine answers with.
*/
async function ensureDeviceId(home, options = {}) {
	const state = await readDeviceState(home);
	const fingerprint = options.fingerprint ?? machineFingerprint();
	const legacy = options.fingerprint === void 0 ? legacyMachineFingerprint() : void 0;
	const deviceName = state.deviceName ?? os.hostname();
	const recorded = state.machineFingerprint;
	const recordedLegacy = state.machineFingerprintLegacy;
	const arrivedFromAnotherMachine = recorded !== void 0 && fingerprint !== void 0 && !(fingerprint !== void 0 && (recorded === fingerprint || recordedLegacy === fingerprint) || legacy !== void 0 && (recorded === legacy || recordedLegacy === legacy));
	if (state.deviceId !== void 0 && !arrivedFromAnotherMachine) {
		const patch = { ...state };
		if (fingerprint !== void 0) {
			if (recorded === void 0) patch.machineFingerprint = fingerprint;
			else if (recorded !== fingerprint) {
				patch.machineFingerprint = fingerprint;
				if (patch.machineFingerprintLegacy === void 0) patch.machineFingerprintLegacy = recorded;
			}
		}
		if (patch.machineFingerprintLegacy === void 0 && legacy !== void 0 && legacy !== patch.machineFingerprint) patch.machineFingerprintLegacy = legacy;
		if (state.machineFingerprint !== patch.machineFingerprint || state.machineFingerprintLegacy !== patch.machineFingerprintLegacy) await writeDeviceState(patch, home);
		return {
			deviceId: state.deviceId,
			deviceName
		};
	}
	const deviceId = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const next = {
		...state,
		deviceId,
		deviceName
	};
	if (fingerprint !== void 0) next.machineFingerprint = fingerprint;
	if (legacy !== void 0 && legacy !== fingerprint) next.machineFingerprintLegacy = legacy;
	delete next.retired;
	delete next.retiredAt;
	await writeDeviceState(next, home);
	return {
		deviceId,
		deviceName
	};
}
/** Patch device state in place, preserving unknown/identity fields. */
async function patchDeviceState(patch, home) {
	const next = {
		...await readDeviceState(home),
		...patch
	};
	await writeDeviceState(next, home);
	return next;
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
const FILE_NAME$1 = "peers.json";
function peersFile(home) {
	return path.join(syncDir(home), FILE_NAME$1);
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
	const tmp = path.join(dir, `.${FILE_NAME$1}.${process.pid}.tmp`);
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
async function fetchPeerManifest(port, token, timeoutMs = 1e4) {
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
//#region lib/types/sync/accounts-store.js
/**
* Named Feishu-account book for the bridge (`/bot account`).
*
* Switching accounts means swapping the Feishu自建应用 the bridge connects
* as — distinct appId/appSecret pairs the operator keeps side by side (a
* private app, a test app, a second identity). The book stores the pairs
* under memorable names in the shared sync directory, so every form on the
* machine sees the same roster and `/bot account use` is one command instead
* of two error-prone `/bot set` calls with a pasted secret.
*
* The file is credentials at rest: same handling as settings.json — atomic
* tmp+rename writes, posix 600, secrets masked in every reply.
* @module dsh-lark-bridge/sync/accounts-store
*/
/** Absolute path of the shared account book. */
function accountsFile(home) {
	return syncDir(home) + "/accounts.json";
}
/** Read the book, or an empty one when absent/corrupt. */
async function readAccounts(home) {
	try {
		const raw = await fsp.readFile(accountsFile(home), "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || typeof parsed.accounts !== "object" || parsed.accounts === null) return { accounts: {} };
		return {
			active: parsed.active,
			accounts: parsed.accounts
		};
	} catch {
		return { accounts: {} };
	}
}
/** Atomic write (tmp+rename) of the whole book. */
async function writeAccounts(book, home) {
	const file = accountsFile(home);
	await fsp.mkdir(syncDir(home), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	await fsp.writeFile(tmp, JSON.stringify(book, null, 2) + "\n", { mode: 384 });
	await fsp.rename(tmp, file);
}
//#endregion
//#region lib/types/account-card.js
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
const ACCOUNT_ACTION = "bot-account";
/**
* Build the account-switcher card. Cap the roster at eight entries — beyond
* that the card is a scroll pit and `/bot account save` curation is the
* better fix.
*/
function buildAccountCard(data) {
	const elements = [];
	if (data.hint !== void 0 && data.hint !== "") elements.push({
		tag: "div",
		text: {
			tag: "plain_text",
			content: data.hint
		}
	});
	for (const entry of data.entries.slice(0, 8)) {
		const flag = entry.active ? "🎖 当前" : "";
		elements.push({
			tag: "div",
			text: {
				tag: "plain_text",
				content: `**${entry.name}** \`${entry.maskedAppId}\`${entry.savedAt === void 0 ? "" : ` · ${entry.savedAt}`}${flag}`
			}
		});
		elements.push({
			tag: "action",
			actions: [{
				tag: "button",
				text: {
					tag: "plain_text",
					content: "✅ 使用"
				},
				type: entry.active ? "default" : "primary",
				value: {
					kind: ACCOUNT_ACTION,
					act: "use",
					name: entry.name
				}
			}, {
				tag: "button",
				text: {
					tag: "plain_text",
					content: "🗑 忘记"
				},
				type: "default",
				value: {
					kind: ACCOUNT_ACTION,
					act: "forget",
					name: entry.name
				}
			}]
		});
	}
	return {
		config: { wide_screen_mode: true },
		header: {
			template: "blue",
			title: {
				tag: "plain_text",
				content: "飞书账号库"
			}
		},
		elements
	};
}
/**
* Narrow an arbitrary card-action value to this card's payload. Foreign
* values (approval clicks, question answers, goal cards) parse to undefined.
*/
function accountCardValue(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (raw.kind !== "bot-account") return void 0;
	if (raw.act !== "use" && raw.act !== "forget") return void 0;
	if (typeof raw.name !== "string" || raw.name === "") return void 0;
	return {
		act: raw.act,
		name: raw.name
	};
}
//#endregion
//#region lib/types/sync/feishu-cloud.js
/**
* Feishu drive (v1) as the cross-machine carrier: the app's own cloud space
* is the natural transfer point for migration files and the arbitration
* record — same credentials the bridge already holds, an isolation boundary
* the platform enforces, and no manual copying between machines. Token is
* cached until shortly before expiry; every call goes through the injected
* fetch so tests run without network.
* @module dsh-lark-bridge/sync/feishu-cloud
*/
const TOKEN_SAFETY_MS = 6e4;
/**
* Deadline for every drive/auth call made here.
*
* This class is read on the inbound message path (the arbitration record is
* fetched per message, cached for a minute), and `fetch` has no default
* deadline. A request that stalls without one parks the inbound handler
* forever: the message is acknowledged with a reaction and then nothing
* happens — no reply, no error, no log — until the process is restarted.
* Bounding every call here keeps a stalled carrier from wedging the channel.
*/
const CLOUD_TIMEOUT_MS = 15e3;
/** Drive-backed JSON storage scoped to the app's own root folder. */
var FeishuCloud = class {
	creds;
	token;
	rootToken;
	fetchImpl;
	constructor(creds, fetchImpl = fetch) {
		this.creds = creds;
		this.fetchImpl = (url, init = {}) => fetchImpl(url, {
			...init,
			signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS)
		});
	}
	origin() {
		return (this.creds.domain ?? "https://open.feishu.cn").replace(/\/$/, "");
	}
	/** Mint (or reuse) a tenant_access_token. */
	async getToken() {
		if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
		const data = await (await this.fetchImpl(`${this.origin()}/open-apis/auth/v3/tenant_access_token/internal`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				app_id: this.creds.appId,
				app_secret: this.creds.appSecret
			})
		})).json();
		if (data.code !== 0 || !data.tenant_access_token) throw new Error(`飞书 token 获取失败(${data.code}): ${data.msg ?? "unknown"}`);
		this.token = {
			value: data.tenant_access_token,
			expiresAt: Date.now() + (data.expire ?? 7200) * 1e3 - TOKEN_SAFETY_MS
		};
		return this.token.value;
	}
	/**
	* The app's own bot profile — the display name a human sees in the Feishu
	* chat header. Fleet UX depends on it: several endpoints (and even several
	* deployments) share or echo app names, so the model's self-description and
	* the first-contact guide quote this name instead of guessing.
	*/
	async botInfo() {
		const token = await this.getToken();
		const data = await (await this.fetchImpl(`${this.origin()}/open-apis/bot/v3/info`, { headers: { Authorization: `Bearer ${token}` } })).json();
		if (data.code !== 0 || data.bot?.app_name === void 0) throw new Error(`飞书 bot 信息获取失败(${data.code}): ${data.msg ?? "unknown"}`);
		return {
			name: data.bot.app_name,
			active: data.bot.activate_status === 2
		};
	}
	/** The app's own drive root folder — files land here unless told otherwise. */
	async rootFolder() {
		if (this.rootToken) return this.rootToken;
		const token = await this.getToken();
		const data = await (await this.fetchImpl(`${this.origin()}/open-apis/drive/explorer/v2/root_folder/meta`, { headers: { Authorization: `Bearer ${token}` } })).json();
		const folder = data.data?.token;
		if (data.code !== 0 || !folder) throw new Error(`飞书根目录获取失败(${data.code}): ${data.msg ?? "unknown"}`);
		this.rootToken = folder;
		return folder;
	}
	/** Upload one text file. Returns its drive file token. */
	async upload(fileName, content, folderToken) {
		const token = await this.getToken();
		const folder = folderToken ?? await this.rootFolder();
		const bytes = Buffer.from(content, "utf8");
		const form = new FormData();
		form.append("file_name", fileName);
		form.append("parent_type", "explorer");
		form.append("parent_node", folder);
		form.append("size", String(bytes.length));
		form.append("file", new Blob([bytes]), fileName);
		const data = await (await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/upload_all`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: form
		})).json();
		const fileToken = data.data?.file_token;
		if (data.code !== 0 || !fileToken) throw new Error(`飞书上传失败(${data.code}): ${data.msg ?? "unknown"}`);
		return fileToken;
	}
	/** List the app's root folder: name → token + modified time (ms). */
	async list() {
		const token = await this.getToken();
		const folder = await this.rootFolder();
		const out = [];
		let pageToken;
		for (;;) {
			const url = new URL(`${this.origin()}/open-apis/drive/v1/files`);
			url.searchParams.set("folder_token", folder);
			url.searchParams.set("page_size", "200");
			if (pageToken !== void 0) url.searchParams.set("page_token", pageToken);
			const data = await (await this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` } })).json();
			if (data.code !== 0) throw new Error(`飞书列目录失败(${data.code}): ${data.msg ?? "unknown"}`);
			for (const file of data.data?.files ?? []) if (file.token !== void 0) out.push({
				name: file.name ?? "",
				token: file.token,
				modifiedMs: Number(file.modified_time ?? 0)
			});
			pageToken = data.data?.next_page_token;
			if (pageToken === void 0 || pageToken === "") break;
		}
		return out;
	}
	/** Download one file's text by token. */
	async download(fileToken) {
		const token = await this.getToken();
		const res = await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/${fileToken}/download`, { headers: { Authorization: `Bearer ${token}` } });
		if (res.status !== 200) throw new Error(`飞书下载失败: HTTP ${res.status}`);
		return res.text();
	}
	/** Delete one file by token (best effort by caller). */
	async remove(fileToken) {
		const token = await this.getToken();
		const data = await (await this.fetchImpl(`${this.origin()}/open-apis/drive/v1/files/${fileToken}?type=file`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` }
		})).json();
		if (data.code !== 0) throw new Error(`飞书删除失败(${data.code}): ${data.msg ?? "unknown"}`);
	}
	/** Upsert-by-name: upload fresh, then retire the old version of that name. */
	async putJson(name, content) {
		const previous = (await this.list()).filter((file) => file.name === name);
		await this.upload(name, content);
		for (const old of previous) await this.remove(old.token).catch(() => {});
	}
	/** Fetch the newest file with this name, or null when absent. */
	async getJson(name) {
		const matches = (await this.list()).filter((file) => file.name === name).sort((a, b) => b.modifiedMs - a.modifiedMs);
		if (matches.length === 0) return null;
		return this.download(matches[0].token);
	}
	/** Remove every file with this name (used before a clean re-put). */
	async removeByName(name) {
		for (const file of await this.list()) if (file.name === name) await this.remove(file.token).catch(() => {});
	}
};
//#endregion
//#region lib/types/sync/bot-command.js
/**
* The `/bot` command: bridge identity, cross-form settings, and plugin sync —
* the chat-facing surface of the dual-end sync feature (see
* docs/design/设计卡_双端设置与同步.md). Text-first, matching the bridge's
* other control commands; every mutating subcommand echoes masked secrets.
* @module dsh-lark-bridge/sync/bot-command
*/
var bot_command_exports = /* @__PURE__ */ __exportAll({
	CLOUD_ARBITRATION_NAME: () => CLOUD_ARBITRATION_NAME,
	CLOUD_MIGRATION_NAME: () => CLOUD_MIGRATION_NAME,
	PRESENCE_INTERVAL_MS: () => PRESENCE_INTERVAL_MS,
	PRESENCE_TIMEOUT_MS: () => PRESENCE_TIMEOUT_MS,
	accountForgetByName: () => accountForgetByName,
	accountUseByName: () => accountUseByName,
	arbitrationActiveKey: () => arbitrationActiveKey,
	arbitrationForInbound: () => arbitrationForInbound,
	claimIfActiveStale: () => claimIfActiveStale,
	endpointKey: () => endpointKey,
	getSyncContext: () => getSyncContext,
	isActiveEndpoint: () => isActiveEndpoint,
	readCloudArbitration: () => readCloudArbitration,
	renewPresence: () => renewPresence,
	runBotCommand: () => runBotCommand,
	setSyncContext: () => setSyncContext
});
/** Fixed cloud-slot names (one slot, refreshed on every write). */
const CLOUD_MIGRATION_NAME = "dsh-lark-bridge-migrate.json";
const CLOUD_ARBITRATION_NAME = "dsh-lark-bridge-arbitration.json";
/**
* The presence-ledger key for one endpoint: device + form + profile. Same
* machine, two forms, two keys — that distinction is the whole point.
*/
function endpointKey(deviceId, form, profile) {
	return `${deviceId}:${form}:${profile}`;
}
/**
* Which ledger key the active slot answers as. Current documents carry it
* verbatim; pre-0.7 documents only record the machine and its form, so the
* derived key reconstructs the endpoint that wrote them.
*/
function arbitrationActiveKey(arbitration) {
	if (typeof arbitration.activeEndpoint === "string") return arbitration.activeEndpoint;
	return endpointKey(arbitration.activeDeviceId, arbitration.form ?? "web", arbitration.profile ?? "web");
}
/**
* True when THIS endpoint (device + form + profile) owns the active slot.
* Pre-0.7 documents fall back to machine + recorded form: their writer was
* one endpoint, so the endpoint matching that form inherits the slot and the
* same machine's other form correctly stands down instead of double replying.
*/
function isActiveEndpoint(arbitration, deviceId, form, profile) {
	if (typeof arbitration.activeEndpoint === "string") return arbitration.activeEndpoint === endpointKey(deviceId, form, profile);
	return arbitration.activeDeviceId === deviceId && (arbitration.form ?? form) === form;
}
/** A machine counts as offline after this much silence (2 renewal periods + slack). */
const PRESENCE_TIMEOUT_MS = 18e4;
/** Helper: a cloud client when credentials exist. */
function cloudOf(ctx) {
	if (ctx.cloud !== void 0) return ctx.cloud;
	if (ctx.credentials === void 0) return null;
	return new FeishuCloud(ctx.credentials);
}
/**
* Claim the active slot in the cloud arbitration file. Best-effort: without
* credentials or offline, activation still applies locally and the reply
* says so — a machine must never become un-activatable because the carrier
* is down (prefer double replies over a silent fleet).
*/
async function publishArbitration(ctx) {
	const cloud = cloudOf(ctx);
	if (cloud === null) return "（未绑定飞书凭证——云端仲裁未写入，仅本机生效）";
	try {
		const identity = await ensureDeviceId(ctx.home);
		const previous = await readCloudArbitration(ctx);
		const key = endpointKey(identity.deviceId, ctx.form, ctx.profile);
		const entry = {
			name: identity.deviceName,
			form: ctx.form,
			profile: ctx.profile,
			version: ctx.bridgeVersion,
			lastSeen: Date.now()
		};
		const arbitration = {
			activeDeviceId: identity.deviceId,
			activeName: identity.deviceName,
			form: ctx.form,
			profile: ctx.profile,
			activeEndpoint: key,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			devices: {
				...previous?.devices,
				[key]: entry
			}
		};
		await cloud.putJson(CLOUD_ARBITRATION_NAME, JSON.stringify(arbitration, null, 2));
		return "（云端仲裁已更新：其它端将退避）";
	} catch (error) {
		return `（云端仲裁写入失败：${error instanceof Error ? error.message : String(error)}——仅本机生效）`;
	}
}
/** Read the cloud arbitration file, null when absent/unavailable. */
async function readCloudArbitration(ctx) {
	const cloud = cloudOf(ctx);
	if (cloud === null) return null;
	try {
		const raw = await cloud.getJson(CLOUD_ARBITRATION_NAME);
		if (raw === null) return null;
		const parsed = JSON.parse(raw);
		return typeof parsed.activeDeviceId === "string" ? parsed : null;
	} catch {
		return null;
	}
}
/**
* Inbound-path arbitration lookup: cached for a minute so a busy chat never
* turns into a drive API per message, and unavailable (null) when there are
* no credentials or the carrier is down — absence never blocks replying
* (prefer double replies over a silent fleet).
*/
let inboundArbitrationCache;
async function arbitrationForInbound() {
	if (inboundArbitrationCache !== void 0 && Date.now() - inboundArbitrationCache.at < 6e4) return inboundArbitrationCache.value;
	const ctx = activeContext;
	const value = ctx === void 0 ? null : await readCloudArbitration(ctx);
	inboundArbitrationCache = {
		value,
		at: Date.now()
	};
	return value;
}
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
	"import",
	"devices",
	"retire",
	"activate",
	"name",
	"account"
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
	if (subcommand === "devices") return devicesReply(ctx);
	if (subcommand === "retire") return retireReply(ctx);
	if (subcommand === "activate") return activateReply(ctx);
	if (subcommand === "name") return nameReply(ctx, rest);
	if (subcommand === "account") return accountReply(ctx, rest);
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
			"子命令：`/bot set <key> <value>` / `/bot unset <key>` / `/bot peers` / `/bot sync-plugins [apply]` / `/bot account [save|use|forget <名字>]` / `/bot export [include-secrets]` / `/bot import [file] [apply]`"
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
	const toFeishu = rest.includes("--to-feishu");
	const harnessHome = ctx.harnessHome ?? defaultHarnessHome();
	const file = await buildMigration(ctx.home, harnessHome, ctx.profile, ctx.form, { includeSecrets });
	const json = `${JSON.stringify(file, null, 2)}\n`;
	const lines = [];
	if (toFeishu) {
		const cloud = cloudOf(ctx);
		if (cloud === null) return {
			reply: "⚠️ 云端通道需要已绑定的飞书凭证（`/bot set appId` / `set appSecret` 后重试）。",
			resolved: false
		};
		try {
			await cloud.putJson(CLOUD_MIGRATION_NAME, json);
		} catch (error) {
			return {
				reply: `⚠️ 上传飞书云空间失败：${error instanceof Error ? error.message : String(error)}`,
				resolved: false
			};
		}
		lines.push(`**迁移文件已上传飞书云空间**：\`${CLOUD_MIGRATION_NAME}\`（app 隔离，仅本应用可见）`);
		lines.push("新机上发 `/bot import --from-feishu` 即可拉取。");
	} else {
		const target = resolveMigrationFile("migrate.json", ctx.home);
		await fsp.mkdir(path.dirname(target), { recursive: true });
		await fsp.writeFile(target, json, "utf8");
		lines.push(`**迁移文件已导出**：\`${target}\``, "新机上放到同路径后 `/bot import`。");
	}
	const profileRows = Object.entries(file.profiles).map(([name, p]) => `- profile \`${name}\`：${Object.keys(p.dependencies).length} 个包，${p.bundles.length} 个 bundle`);
	lines.push(`- 共享设置 ${Object.keys(file.settings).length} 个键${includeSecrets ? "" : "（凭证已掩码）"}`, ...profileRows);
	lines.push("", includeSecrets ? "⚠️ 此文件**含明文凭证**——只经可信渠道带到新机，导入后建议删除。" : "导入端需重新 `/bot set appSecret <值>`（掩码值不会被导入）。");
	lines.push("会话历史在 `~/.dsh`（上游管理）——整目录拷贝即可带走，本文件不含。");
	return {
		reply: lines.join("\n"),
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
	const fromFeishu = rest.includes("--from-feishu");
	const nameArg = rest.find((token) => token !== "apply" && token !== "--from-feishu");
	let file;
	let origin;
	if (fromFeishu) {
		const cloud = cloudOf(ctx);
		if (cloud === null) return {
			reply: "⚠️ 云端通道需要已绑定的飞书凭证。",
			resolved: false
		};
		try {
			const raw = await cloud.getJson(CLOUD_MIGRATION_NAME);
			if (raw === null) return {
				reply: `⚠️ 云空间里还没有 \`${CLOUD_MIGRATION_NAME}\`——先在旧机 \`/bot export --to-feishu\`。`,
				resolved: false
			};
			file = validateMigration(JSON.parse(raw));
			origin = `飞书云空间（来自 **${file.from.host}**）`;
		} catch (error) {
			return {
				reply: `⚠️ 云端拉取失败：${error instanceof Error ? error.message : String(error)}`,
				resolved: false
			};
		}
	} else try {
		file = await readMigration(nameArg, ctx.home);
		origin = `本地文件（来自 **${file.from.host}**）`;
	} catch (error) {
		return {
			reply: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
			resolved: false
		};
	}
	return importFromFile(ctx, file, apply, fromFeishu ? void 0 : nameArg, origin);
}
/** Shared import pipeline: preview or apply a validated migration document. */
async function importFromFile(ctx, file, apply, nameArg, origin) {
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
				`**导入预览**（${origin} · ${file.exportedAt}）：`,
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
	const lines = [`**导入执行完毕**（${origin}）：`];
	lines.push(`- ✅ 共享设置写入 ${Object.keys(writable).length} 个键`);
	for (const { profile, plan } of plans) {
		if (plan.steps.length === 0) {
			lines.push(`- ✅ profile \`${profile}\`：插件清单已一致`);
			continue;
		}
		const result = await applySyncPlan(plan, runner);
		lines.push(`- profile \`${profile}\`：成功 ${result.ran.length}，跳过 ${result.skipped.length}，失败 ${result.failures.length}`);
		for (const step of result.ran) lines.push(`  - ✅ ${step.spec}`);
		for (const step of result.skipped) lines.push(`  - ⏸ \`${step.bundle}\`（已装未启用，请人工确认）`);
		for (const failure of result.failures) lines.push(`  - ⚠️ ${failure.step.spec}：${failure.error}`);
	}
	if (reenter.length > 0) lines.push(`- ⚠️ 请补录凭证：${reenter.map((key) => `\`/bot set ${key} <值>\``).join("、")}`);
	if (warning !== null) lines.push("", warning);
	return {
		reply: lines.join("\n"),
		resolved: true
	};
}
/**
* Renew this machine's presence line in the cloud arbitration file — the
* "login heartbeat" of the three-state model. Read-merge-write on a single
* cloud slot: concurrent writers may clobber each other's lastSeen, which
* only blurs presence precision (minutes) and never corrupts the active
* slot. Failures are swallowed; presence is advisory.
*/
async function renewPresence(ctx) {
	const cloud = cloudOf(ctx);
	if (cloud === null) return;
	try {
		const identity = await ensureDeviceId(ctx.home);
		const previous = await readCloudArbitration(ctx);
		const key = endpointKey(identity.deviceId, ctx.form, ctx.profile);
		const entry = {
			name: identity.deviceName,
			form: ctx.form,
			profile: ctx.profile,
			version: ctx.bridgeVersion,
			lastSeen: Date.now()
		};
		const base = previous ?? {
			activeDeviceId: identity.deviceId,
			activeName: identity.deviceName,
			form: ctx.form,
			profile: ctx.profile,
			activeEndpoint: key,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			devices: {}
		};
		await cloud.putJson(CLOUD_ARBITRATION_NAME, JSON.stringify({
			...base,
			devices: {
				...base.devices,
				[key]: entry
			}
		}, null, 2));
	} catch {}
}
/**
* Election: when the arbitration's active ENDPOINT has gone silent past the
* presence timeout, the online endpoint with the lexicographically smallest
* endpoint key claims the slot — deterministic, so concurrent electors
* converge on one winner even without an atomic test-and-set on the drive.
* Keys are endpoint-scoped (device+form+profile): on one machine the web and
* desktop forms are separate contenders, so a silent web form hands the slot
* to desktop (or another machine) instead of deadlocking on a shared id.
* `known` is the caller's (possibly cached) arbitration; a fresh read happens
* only when an election looks possible, keeping the quiet path API-free.
*/
async function claimIfActiveStale(ctx, known) {
	if (known === null) return false;
	const mine = endpointKey((await ensureDeviceId(ctx.home)).deviceId, ctx.form, ctx.profile);
	if (arbitrationActiveKey(known) === mine) return false;
	const knownKey = arbitrationActiveKey(known);
	const activeSeen = known.devices?.[knownKey]?.lastSeen ?? Date.parse(known.updatedAt);
	if (Number.isNaN(activeSeen) || Date.now() - activeSeen < 18e4) return false;
	if (cloudOf(ctx) === null) return false;
	const latest = await readCloudArbitration(ctx);
	if (latest === null) return false;
	const latestKey = arbitrationActiveKey(latest);
	if (latestKey === mine) return false;
	const latestSeen = latest.devices?.[latestKey]?.lastSeen ?? Date.parse(latest.updatedAt);
	if (!Number.isNaN(latestSeen) && Date.now() - latestSeen < 18e4) return false;
	if (Object.entries(latest.devices ?? {}).filter(([key, entry]) => key !== latestKey && Date.now() - entry.lastSeen < 18e4).map(([key]) => key).some((key) => key < mine)) return false;
	await publishArbitration(ctx);
	return true;
}
/** `/bot name [readable-name]` — show or set this machine's roster name. */
async function nameReply(ctx, rest) {
	const name = rest.join(" ").trim();
	if (name === "") {
		const identity = await ensureDeviceId(ctx.home);
		return {
			reply: `当前设备名：**${identity.deviceName}**（\`${identity.deviceId}\`）。改名：\`/bot name <新名字>\``,
			resolved: true
		};
	}
	const next = await patchDeviceState({ deviceName: name }, ctx.home);
	return {
		reply: `✅ 设备名已改为 **${next.deviceName}**（\`${next.deviceId}\`）。`,
		resolved: true
	};
}
/**
* `/bot account` — named Feishu-app credential sets for one-command account
* switching. A "switch" rewrites the transport keys in the shared settings
* (exactly what two `/bot set` calls would do, but atomically and without
* pasting a secret into chat twice), so the normal restart/reconnect path
* picks the new identity up. Secrets never echo unmasked.
*/
async function accountReply(ctx, rest) {
	const [action, name, ...noteParts] = rest;
	const book = await readAccounts(ctx.home);
	if (action === void 0) {
		const names = Object.keys(book.accounts);
		if (names.length === 0) return {
			reply: "**账号库**为空。存当前凭证：`/bot account save <名字> [备注]`；切换：`/bot account use <名字>`。",
			resolved: true
		};
		return {
			reply: "",
			resolved: true,
			card: buildAccountCard({
				entries: names.map((key) => ({
					name: key,
					maskedAppId: maskSecret(book.accounts[key].appId),
					savedAt: book.accounts[key].savedAt,
					active: book.active === key
				})),
				hint: "「使用」切换到该账号（写入共享设置，重启后生效）；「忘记」从账号库删除。"
			})
		};
	}
	if (action === "save") {
		if (name === void 0 || name === "") return {
			reply: "⚠️ 格式：`/bot account save <名字> [备注]`",
			resolved: false
		};
		if (ctx.credentials === void 0) return {
			reply: "⚠️ 本端当前没有可保存的凭证（尚未 onboard）。",
			resolved: false
		};
		const { appId, appSecret, domain } = ctx.credentials;
		book.accounts[name] = {
			appId,
			appSecret,
			...domain !== void 0 ? { domain } : {},
			savedAt: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
			...noteParts.length > 0 ? { note: noteParts.join(" ") } : {}
		};
		await writeAccounts(book, ctx.home);
		return {
			reply: `✅ 当前凭证已存为 **${name}**（\`${maskSecret(appId)}\`）。查看：\`/bot account\`。`,
			resolved: true
		};
	}
	if (action === "use") {
		if (name === void 0 || name === "") return {
			reply: "⚠️ 格式：`/bot account use <名字>`",
			resolved: false
		};
		const outcome = await accountUseByName(ctx, name);
		return {
			reply: outcome.text,
			resolved: outcome.ok
		};
	}
	if (action === "forget") {
		if (name === void 0 || name === "") return {
			reply: "⚠️ 格式：`/bot account forget <名字>`",
			resolved: false
		};
		const outcome = await accountForgetByName(ctx, name);
		return {
			reply: outcome.text,
			resolved: outcome.ok
		};
	}
	return {
		reply: "⚠️ 未知动作。可用：`/bot account`（列表）/ `save <名字>` / `use <名字>` / `forget <名字>`",
		resolved: false
	};
}
/**
* Switch the shared transport keys to a saved account — the guts of
* `/bot account use`, exported for the account card's 使用 button.
* `ok:false` marks a refusal (unknown name) so the command path can flag it
* unresolved; the text is the human-facing line either way.
*/
async function accountUseByName(ctx, name) {
	const book = await readAccounts(ctx.home);
	const account = book.accounts[name];
	if (account === void 0) return {
		text: `⚠️ 账号库里没有 **${name}**。已有：${Object.keys(book.accounts).map((key) => `\`${key}\``).join(" / ") || "（空）"}`,
		ok: false
	};
	await updateSettings(ctx.home, (current) => ({
		...current,
		appId: account.appId,
		appSecret: account.appSecret,
		...account.domain !== void 0 ? { domain: account.domain } : {}
	}));
	book.active = name;
	await writeAccounts(book, ctx.home);
	return {
		text: [
			`✅ 已切换到账号 **${name}**（\`${maskSecret(account.appId)}\`）——凭证写入共享设置。`,
			"⚠️ 传输层身份已变更：本端发 `/restart` 生效（desktop 端重启 DSH Desktop 生效）；其它端下次启动自动采用。",
			"提醒：同一飞书 app 双端同连会双投递，切换后确认旧端已停或退避。"
		].join("\n"),
		ok: true
	};
}
/** Remove one saved account and clear an active marker — the card's 忘记 button. */
async function accountForgetByName(ctx, name) {
	const book = await readAccounts(ctx.home);
	if (book.accounts[name] === void 0) return {
		text: `⚠️ 账号库里没有 **${name}**。`,
		ok: false
	};
	delete book.accounts[name];
	if (book.active === name) delete book.active;
	await writeAccounts(book, ctx.home);
	return {
		text: `✅ 账号 **${name}** 已从账号库删除。`,
		ok: true
	};
}
/**
* `/bot devices` — the device roster: this machine (with its lifecycle state),
* whoever the heartbeat currently sees, and any machine a migration file came
* from. The roster is informational; the Feishu app itself stays single-active.
*/
async function devicesReply(ctx) {
	const identity = await ensureDeviceId(ctx.home);
	const state = await readDeviceState(ctx.home);
	const peers = await listPeers(ctx.home);
	const lines = [`**设备台账**（飞书 app 单活跃——同一时刻只有一端回复消息）：`];
	lines.push(`- **本机** \`${identity.deviceName}\`（\`${identity.deviceId}\`）：profile \`${ctx.profile}\`（${ctx.form}）v${ctx.bridgeVersion}${state.retired ? " —— **已退位**，发 `/bot activate` 重新启用" : " —— ✅ 活跃"}`);
	if (peers.length === 0) lines.push("- 在线对端：无");
	else for (const peer of peers) lines.push(`- 在线：\`${peer.host}\` profile \`${peer.profile}\`（${peer.form}）v${peer.bridgeVersion}`);
	const arbitration = await readCloudArbitration(ctx);
	if (arbitration !== null) {
		const mine = isActiveEndpoint(arbitration, identity.deviceId, ctx.form, ctx.profile);
		const activeForm = arbitration.form ?? "?";
		const activeProfile = arbitration.profile ?? "?";
		lines.push(`- 云端仲裁活跃：**${arbitration.activeName}**（${activeForm}/${activeProfile}）${mine ? " = 本端" : ""} · 更新于 ${arbitration.updatedAt}`);
		const activeKey = arbitrationActiveKey(arbitration);
		for (const [key, entry] of Object.entries(arbitration.devices ?? {})) {
			const age = Date.now() - entry.lastSeen;
			const online = age < PRESENCE_TIMEOUT_MS;
			const activeTag = key === activeKey ? " · 🎖 活跃" : "";
			const where = `${entry.form}/${entry.profile ?? "?"}`;
			lines.push(`  - \`${entry.name}\`（${where}）v${entry.version} —— ${online ? `在线（${Math.round(age / 1e3)}s 前）` : `离线（${Math.round(age / 6e4)}min 前）`}${activeTag}`);
		}
	}
	try {
		const file = await readMigration(void 0, ctx.home);
		lines.push(`- 迁移档案：来自 \`${file.from.host}\`（${file.exportedAt}）`);
	} catch {}
	lines.push("", "转移动作：本机 `/bot export include-secrets --to-feishu` → 新机 `/bot import --from-feishu apply` → 本机 `/bot retire`。改设备名：`/bot name <名字>`。");
	return {
		reply: lines.join("\n"),
		resolved: true
	};
}
/**
* `/bot retire` — take THIS machine out of the reply path (e.g. after
* exporting to a successor). The flag is per-machine local state; inbound
* messages get a one-line notice instead of an agent turn until
* `/bot activate` clears it.
*/
async function retireReply(ctx) {
	if ((await readDeviceState(ctx.home)).retired) return {
		reply: "本机已是退位状态。重新启用：`/bot activate`。",
		resolved: true
	};
	await patchDeviceState({
		retired: true,
		retiredAt: (/* @__PURE__ */ new Date()).toISOString(),
		note: `retired on ${os.hostname()}`
	}, ctx.home);
	return {
		reply: [
			`✅ 本机 \`${os.hostname()}\` 已退位——后续消息不再驱动 agent，只回本提示。`,
			"重新启用：`/bot activate`。",
			"提醒：若迁移到新机，确认新机 `/bot import apply` 完成后再退位，避免飞书端无人应答。"
		].join("\n"),
		resolved: true
	};
}
/** `/bot activate` — clear this machine's retired flag, and when the cloud
* carrier is available, claim the active slot so other machines stand down.
* Claiming happens even when the machine was never retired: activation IS
* the takeover gesture for a fresh machine joining the fleet. */
async function activateReply(ctx) {
	const wasRetired = (await readDeviceState(ctx.home)).retired === true;
	if (wasRetired) await patchDeviceState({
		retired: false,
		activatedAt: (/* @__PURE__ */ new Date()).toISOString()
	}, ctx.home);
	const cloudLine = await publishArbitration(ctx);
	return {
		reply: `${wasRetired ? `✅ 本机 \`${os.hostname()}\` 已重新激活，恢复正常应答。` : `✅ 本机 \`${os.hostname()}\` 已认领活跃槽位，后续消息由本机应答。`}${cloudLine}`,
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
/**
* Whether the event declares files the model wants delivered.
*
* The guard checks the shape, not just the name: a host that emits the
* event with a different payload should leave the bridge's delivery path
* closed rather than deliver something it cannot read.
*/
function isPresentedEvent(event) {
	if (event.type !== "deliverables/presented") return false;
	const data = event.data;
	if (typeof data !== "object" || data === null) return false;
	const candidate = data;
	if (typeof candidate.turn !== "number" || typeof candidate.callId !== "string") return false;
	if (!Array.isArray(candidate.files)) return false;
	return candidate.files.every((file) => {
		if (typeof file !== "object" || file === null) return false;
		const entry = file;
		if (typeof entry.path !== "string" || entry.path === "") return false;
		return entry.description === void 0 || typeof entry.description === "string";
	});
}
function isSubagentDescriptorEvent(event) {
	return event.type === "subagent/descriptor";
}
function isSubagentCatalogEvent(event) {
	return event.type === "subagent/catalog";
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
	const flat = block?.text ?? "";
	const nested = (block?.content ?? []).filter((inner) => inner.type === "text" && inner.text !== void 0).map((inner) => inner.text).join("");
	return {
		callId: block?.toolCallId ?? data.message.source?.callId,
		text: flat !== "" ? flat : nested
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
/**
* Whether an event carries a team member.
*
* The version is checked, not just the name: a payload that does not carry
* version 2 is another shape, and rendering it as a member would show fields
* that are not there.
* @param event - the session event.
* @returns true when the event is a `team/member` event.
*/
function isTeamMemberEvent(event) {
	const data = event.data;
	return event.type === "team/member" && data !== void 0 && data !== null && data.version === 2 && typeof data.teamId === "string" && data.member !== void 0 && data.member !== null && typeof data.member.id === "string" && typeof data.member.name === "string";
}
/**
* Whether an event carries a shared team task.
* @param event - the session event.
* @returns true when the event is a `team/task` event.
*/
function isTeamTaskEvent(event) {
	const data = event.data;
	return event.type === "team/task" && data !== void 0 && data !== null && data.version === 2 && typeof data.teamId === "string" && data.task !== void 0 && data.task !== null && typeof data.task.id === "string" && typeof data.task.subject === "string";
}
/**
* Whether an event carries a queued mailbox message.
* @param event - the session event.
* @returns true when the event is a `team/message/queued` event.
*/
function isTeamMessageEvent(event) {
	const data = event.data;
	return event.type === "team/message/queued" && data !== void 0 && data !== null && data.version === 2 && typeof data.teamId === "string" && data.message !== void 0 && data.message !== null && typeof data.message.id === "string";
}
/**
* Whether an event acknowledges a queued mailbox message.
* @param event - the session event.
* @returns true when the event is a `team/message/delivered` event.
*/
function isTeamMessageDeliveredEvent(event) {
	const data = event.data;
	return event.type === "team/message/delivered" && data !== void 0 && data !== null && data.version === 2 && typeof data.teamId === "string" && typeof data.messageId === "string" && typeof data.targetId === "string";
}
/**
* Narrow a session event to a message the human at the chat typed.
*
* Only the human's own words qualify. The same event carries instruction,
* context, goal and reminder messages the host writes itself — all of them
* `source.kind` values other than `user` — and none of them are something a
* reader of the thinking process would recognise as their own sentence.
*
* @param event - any session event.
* @returns whether the event is a message the human sent.
*/
function isUserChatMessageEvent(event) {
	if (event.type !== "user/message") return false;
	const raw = event.data;
	if (raw === void 0 || raw === null) return false;
	const message = raw.message ?? raw;
	if (typeof message.id !== "string") return false;
	if (!Array.isArray(message.content)) return false;
	return message.source?.kind === "user";
}
/**
* Narrow a session event to a message relayed from a teammate.
*
* @param event - any session event.
* @returns whether the event is a `user/message` a teammate sent.
*/
function isTeamRelayMessageEvent(event) {
	if (event.type !== "user/message") return false;
	const data = event.data;
	if (data === void 0 || data === null) return false;
	const message = data.message;
	if (message === void 0 || message === null) return false;
	if (typeof message.id !== "string") return false;
	if (!Array.isArray(message.content)) return false;
	const source = message.source;
	if (source === void 0 || source === null) return false;
	return source.kind === "agent-message";
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
//#region lib/types/clock.js
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
* Split one epoch instant into local date, local time and UTC offset.
* @param at - epoch milliseconds.
* @returns the parts, in the machine's own time zone.
*/
function partsOf(at) {
	const date = new Date(at);
	const parts = {};
	for (const { type, value } of new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false
	}).formatToParts(date)) parts[type] = value;
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const abs = Math.abs(offsetMinutes);
	const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
	const second = parts.second === "60" ? "59" : parts.second;
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		time: `${parts.hour}:${parts.minute}:${second}`,
		offset
	};
}
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
function messageTimeStamp(at) {
	if (at === void 0 || !Number.isFinite(at) || at <= 0) return void 0;
	const { date, time, offset } = partsOf(at);
	return `${date} ${time} (${offset})`;
}
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
function clockTime(at) {
	if (at === void 0 || !Number.isFinite(at) || at <= 0) return void 0;
	return partsOf(at).time;
}
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
function duration(ms) {
	if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1e3) return `${Math.round(ms)}ms`;
	if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
	const seconds = Math.round(ms / 1e3);
	return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
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
function elapsedPhrase(ms) {
	if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 6e4) return "刚刚";
	if (ms < 36e5) return `${Math.round(ms / 6e4)} 分钟前`;
	if (ms < 864e5) {
		const hours = Math.floor(ms / 36e5);
		const minutes = Math.round(ms % 36e5 / 6e4);
		return minutes === 0 ? `${hours} 小时前` : `${hours} 小时 ${minutes} 分钟前`;
	}
	return `${Math.floor(ms / 864e5)} 天前`;
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
/**
* What one tool call's arguments are worth showing.
*
* The arguments of a file write are the whole file. Putting them in the
* chat means the file's contents are copied into a conversation that
* already has the file on disk, and a chat client renders a megabyte of
* JSON as a wall. What a reader needs from a tool call is which tool ran
* and on what — the path, the command, the query — not the payload.
*
* So the arguments are summarised: the keys whose values identify the
* call are kept, and the ones that carry bulk are replaced by their size.
* The full arguments stay in the session log, where the run can be read
* later.
*/
const SUMMARY_KEYS = [
	"path",
	"file_path",
	"filePath",
	"command",
	"cmd",
	"query",
	"url",
	"pattern",
	"pathPattern",
	"glob",
	"description",
	"name",
	"prompt",
	"old_str",
	"new_str",
	"subagent_type",
	"description"
];
/**
* A parameter this large is described by its size instead of its content: the
* payload is a whole file or a migrated schema, and neither belongs in a card.
*/
const BULK_VALUE_CHARS = 200;
/**
* Summarise one tool call's arguments for the chat.
*
* @param argumentsJson - the arguments as the host delivered them.
* @param maxValueChars - how much of one kept value to show.
* @returns a short description of what the call was for.
*/
function summariseArguments(argumentsJson, maxValueChars = DEFAULT_LIMITS.toolArgChars) {
	let parsed;
	try {
		parsed = JSON.parse(argumentsJson);
	} catch {
		const first = argumentsJson.split("\n")[0]?.trim() ?? "";
		return first.length > maxValueChars ? `${first.slice(0, maxValueChars - 1)}…` : first;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return String(parsed).slice(0, maxValueChars);
	const entries = Object.entries(parsed);
	const kept = [];
	for (const [key, value] of entries) {
		if (!SUMMARY_KEYS.includes(key)) {
			const size = typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
			if (size > BULK_VALUE_CHARS) kept.push(`${key}: ${size} 字符`);
			continue;
		}
		const text = typeof value === "string" ? value : JSON.stringify(value);
		kept.push(`${key}: ${text.length > maxValueChars ? `${text.slice(0, maxValueChars - 1)}…` : text}`);
	}
	if (kept.length === 0) return `${entries.length} 个参数`;
	return kept.join(" · ");
}
/**
* What one tool result is worth showing.
*
* A command's output is output, not prose: the reader wants to know what
* came back and whether it worked, not to read a thousand lines of it in
* the chat. The head carries the answer; the rest stays in the session log.
* The head is a budget, not a rule — a working session wants enough of it to
* see why a command failed.
* @param text - the tool's output.
* @param lines - how many leading lines to show.
* @param chars - how many characters those lines may take in total.
* @returns the preview, with a marker when more lines exist.
*/
function summariseResult(text, lines = DEFAULT_LIMITS.toolResultLines, chars = DEFAULT_LIMITS.toolResultChars) {
	const trimmed = text.trim();
	if (trimmed === "") return "（无输出）";
	const head = trimmed.split("\n").slice(0, lines).join("\n");
	const bounded = head.length > chars ? `${head.slice(0, chars - 1)}…` : head;
	const total = trimmed.split("\n").length;
	if (total > lines) return `${bounded}\n…（共 ${total} 行，完整结果见会话记录）`;
	return bounded;
}
/**
* How much of a mid-turn message the process shows before eliding it.
*
* A person who pastes a stack trace into a running turn meant it for the
* model, not for the thinking area — and one event's payload is capped anyway
* (4096 characters), so the default stays under it. The head is enough to
* recognise which message turned the run.
*/
/**
* What one mid-turn message says.
* @param data - the `user/message` payload.
* @param maxChars - how much of it the thinking area shows.
* @returns the message's text, bounded.
*/
function userChatMessageText(data, maxChars = DEFAULT_LIMITS.userMessageChars) {
	const parts = [];
	for (const block of data.content) if (block.type === "text" && typeof block.text === "string" && block.text !== "") parts.push(block.text);
	const text = parts.join("\n").trim();
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
/**
* The closing line, as an event the answer half can send.
*
* @param run - the finished run.
* @param failure - the failure detail, empty when the turn succeeded.
* @returns the event carrying the line.
*/
function closingEvent(run, failure) {
	const text = failure === void 0 ? closingLine(run) : `⚠️ 本轮失败 · ${failure}`;
	return {
		type: "assistant/message",
		data: {
			turn: run.turn,
			message: {
				role: "assistant",
				content: [{
					type: "text",
					text
				}]
			}
		}
	};
}
/**
* The line that says the turn is over.
*
* A reader watching twenty-six tool calls scroll past has no way to tell
* that the run ended — the process closes, but nothing says so in words.
* The count and the elapsed time are the two facts a reader wants at that
* moment: how much happened, and how long it took.
*/
function closingLine(run) {
	const parts = [`✅ 本轮完成 · ${run.toolCalls === 0 ? "无工具调用" : `${run.toolCalls} 次工具调用`} · 用时 ${duration(Date.now() - run.startedAt)}`];
	if (run.slowest !== void 0 && run.toolCalls > 1) parts.push(`最慢 ${run.slowest.title} ${duration(run.slowest.ms)}`);
	return parts.join(" · ");
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
	const { showProcess, hidden, presentCall, onFailure, answer, limits = DEFAULT_LIMITS } = options;
	let live;
	let aimed;
	/** A target that arrived mid-run; it owns the NEXT turn, never the live one. */
	let pendingAim;
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
	/**
	* Open a fresh reasoning block for this run and announce it.
	*
	* The id is per block, not per turn: the protocol creates one reasoning
	* message per START carrying that id, so reusing a turn-wide id turns every
	* later thought into an edit of the first one. The reader then sees the whole
	* turn's thinking piled up at the top, far from the tool call it explains.
	* @param run - the run the block belongs to.
	* @returns the id its deltas must carry.
	*/
	const openReasoning = (run) => {
		run.reasoningBlocks += 1;
		run.reasoningId = `reasoning-${run.turn}-${run.reasoningBlocks}`;
		run.reasoningOpen = true;
		enqueue(run, cotEvent("REASONING_MESSAGE_START", {
			messageId: run.reasoningId,
			role: "reasoning"
		}));
		return run.reasoningId;
	};
	/** Close the open reasoning block, if any; a no-op otherwise. */
	const closeReasoning = (run) => {
		if (!run.reasoningOpen) return;
		run.reasoningOpen = false;
		enqueue(run, cotEvent("REASONING_MESSAGE_END", { messageId: run.reasoningId }));
	};
	/** The run for `turn`, opening one when the turn is new. */
	const ensure = (turn) => {
		if (live !== void 0 && live.turn === turn) return live;
		if (live !== void 0) closeRun(live);
		if (pendingAim !== void 0) {
			aimed = pendingAim;
			pendingAim = void 0;
			answer.aim(aimed);
		}
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
			reasoningId: "",
			reasoningBlocks: 0,
			finished: false,
			startedAt: Date.now(),
			toolCalls: 0,
			userMessages: 0,
			callStarted: /* @__PURE__ */ new Map(),
			lastToolTitle: "",
			slowest: void 0
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
		closeReasoning(run);
		answer.handle(closingEvent(run, failure));
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
			if (live !== void 0 && !live.finished) {
				pendingAim = target;
				return;
			}
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
			if (isUserChatMessageEvent(event)) {
				if (!showProcess) return;
				if (live === void 0 || live.finished) return;
				const text = userChatMessageText(event.data, limits.userMessageChars);
				if (text === "") return;
				const run = live;
				closeReasoning(run);
				run.userMessages += 1;
				const messageId = `user-${run.turn}-${run.userMessages}`;
				enqueue(run, cotEvent("TEXT_MESSAGE_START", {
					messageId,
					role: "user"
				}), cotEvent("TEXT_MESSAGE_CONTENT", {
					messageId,
					delta: text
				}), cotEvent("TEXT_MESSAGE_END", { messageId }));
				return;
			}
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
					const messageId = run.reasoningOpen ? run.reasoningId : openReasoning(run);
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
					closeReasoning(run);
					const messageId = openReasoning(run);
					enqueue(run, cotEvent("REASONING_MESSAGE_CONTENT", {
						messageId,
						delta: text
					}));
					closeReasoning(run);
					return;
				}
				return;
			}
			if (isToolCallEvent(event)) {
				if (!showProcess) return;
				const run = ensure(event.data.turn);
				const shown = presentCall(event.data.name, event.data.arguments);
				const toolCallId = event.data.callId;
				run.toolCalls += 1;
				const startedAt = Date.now();
				run.callStarted.set(toolCallId, startedAt);
				closeReasoning(run);
				const title = subagentTitle(event.data.name, shown.title);
				run.lastToolTitle = title;
				const shownAt = clockTime(startedAt);
				enqueue(run, cotEvent("TOOL_CALL_START", {
					toolCallId,
					icon: TOOL_ICONS[shown.kind ?? ""] ?? "default",
					title: shownAt === void 0 ? title : `${title} · ${shownAt}`,
					toolCallName: event.data.name
				}), cotEvent("TOOL_CALL_ARGS", {
					toolCallId,
					delta: summariseArguments(event.data.arguments, limits.toolArgChars)
				}), cotEvent("TOOL_CALL_END", { toolCallId }));
				return;
			}
			if (isToolResultEvent(event)) {
				if (!showProcess) return;
				const { callId, text } = toolResultText(event.data);
				if (callId === void 0) return;
				const run = ensure(event.data.turn);
				const startedAt = run.callStarted.get(callId);
				run.callStarted.delete(callId);
				const elapsed = startedAt === void 0 ? void 0 : Date.now() - startedAt;
				if (elapsed !== void 0 && (run.slowest === void 0 || elapsed > run.slowest.ms)) run.slowest = {
					title: run.lastToolTitle,
					ms: elapsed
				};
				const took = elapsed === void 0 || elapsed < 1e3 ? "" : `⏱ ${duration(elapsed)} · `;
				enqueue(run, cotEvent("TOOL_CALL_RESULT", {
					messageId: `result-${callId}`,
					toolCallId: callId,
					role: "tool",
					content: {
						type: "code",
						code: `${took}${summariseResult(text, limits.toolResultLines, limits.toolResultChars)}`
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
				if (pendingAim !== void 0) {
					aimed = pendingAim;
					pendingAim = void 0;
					answer.aim(aimed);
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
//#region lib/types/chat-workspace.js
/**
* Per-chat working-directory bindings.
*
* A session's cwd is fixed when the session is created, so "switch project"
* means "switch where the NEXT session starts" — the current conversation
* keeps working where it was. That is the only honest semantic here: moving a
* live session would move files under an agent mid-turn.
*
* The binding therefore has to outlive a restart. An operator who points a
* chat at a project once should not have to redo it every time the host comes
* back, and `/new` in that chat must land in the same project again.
*
* Storage is a plain JSON map beside the shared settings, written tmp+rename so
* a reader never sees a torn file.
* @module dsh-lark-bridge/chat-workspace
*/
const FILE_NAME = "chat-workspaces.json";
/** Absolute path of the per-chat binding file (`$DSH_HOME/dsh-lark-bridge/…`). */
function chatWorkspaceFile(home) {
	return path.join(syncDir(home), FILE_NAME);
}
/**
* Read every binding, or `{}` when the file is absent or unreadable.
*
* A corrupt file reads as empty rather than throwing: a broken convenience map
* must not stop the bridge from serving chats, and the next write replaces it.
*
* @param home - harness home override, for tests.
* @returns chat id → absolute directory.
*/
async function readChatWorkspaces(home) {
	let raw;
	try {
		raw = await fsp.readFile(chatWorkspaceFile(home), "utf8");
	} catch {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out = {};
		for (const [chatId, dir] of Object.entries(parsed)) if (typeof dir === "string" && dir !== "") out[chatId] = dir;
		return out;
	} catch {
		return {};
	}
}
/**
* Bind one chat to a directory, or clear its binding with `null`.
*
* Read-modify-write: two chats binding at once must not drop each other, and
* the file is small enough that holding the whole map is free.
*
* @param chatId - the chat whose binding changes.
* @param dir - absolute directory, or `null` to fall back to the deployment cwd.
* @param home - harness home override, for tests.
*/
async function writeChatWorkspace(chatId, dir, home) {
	const current = await readChatWorkspaces(home);
	if (dir === null) delete current[chatId];
	else current[chatId] = dir;
	const file = chatWorkspaceFile(home);
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fsp.writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 384 });
	await fsp.rename(tmp, file);
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
*
* The read is ASYNC on purpose. This file can live on a bridged filesystem
* (a Windows path under /mnt), where a synchronous read stalls the whole event
* loop — no replies, no logs, no HTTP — until the mount answers. Awaiting it
* keeps a slow mount from freezing the channel.
*/
const briefedSessions = /* @__PURE__ */ new Set();
async function briefingPrefix(file, sessionId, log) {
	if (!file) return "";
	const key = `${file}\u0000${sessionId}`;
	if (briefedSessions.has(key)) return "";
	briefedSessions.add(key);
	try {
		const text = (await readFile(file, "utf-8")).trim();
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
*
* 2026-09-15 — live content. Before this, the card only ever showed
* `label — status`, and in practice it never appeared at all: the bridge built
* it from `subagent/descriptor`, which 0.1.5 appends **into the child's own
* session** (`subagent-in-process-driver/src/index.ts` attachDescriptorAppend),
* so a parent-session subscriber never sees it. What the parent session does
* receive is `subagent/catalog` (`subagent/src/catalog.ts` establishCatalogChild
* → `parent.append`), carrying `childId / childCreatedAt / mode / label`.
* This module is keyed by that `childId`, and carries the child's latest
* observed activity so a reader can tell what a subagent is doing without
* leaving the chat.
* @module dsh-lark-bridge/subagent-card
*/
function createTracker() {
	return { entries: /* @__PURE__ */ new Map() };
}
/** Collapse whitespace and clip, so one line stays one line on a phone. */
function clipActivity(text, max = 68) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/**
* Register (or refresh) one child. Idempotent: `subagent/catalog` may be
* re-delivered on replay/reconnect, and re-adding must not spawn a second row.
*/
function addEntry(state, id, descriptor, now = Date.now()) {
	const existing = state.entries.get(id);
	if (existing !== void 0) return existing;
	const entry = {
		id,
		label: descriptor.label ?? `子代理 ${state.entries.size + 1}`,
		mode: descriptor.mode === "continuable" ? "continuable" : "one-shot",
		status: "running",
		startedAt: now,
		recent: [],
		chunks: 0
	};
	state.entries.set(id, entry);
	return entry;
}
/**
* Fold one observed activity sample into a child's row. Returns the entry, or
* undefined when the id is unknown (an unattributable frame must not invent a
* row — see the attribution rule in bridge.ts).
*/
function markActivity(state, id, text, now = Date.now()) {
	const entry = state.entries.get(id);
	if (entry === void 0) return void 0;
	const clipped = clipActivity(text);
	if (clipped !== "") {
		entry.lastActivity = clipped;
		if (entry.recent[entry.recent.length - 1] !== clipped) {
			entry.recent.push(clipped);
			if (entry.recent.length > 5) entry.recent.splice(0, entry.recent.length - 5);
		}
	}
	entry.chunks += 1;
	entry.lastAt = now;
	return entry;
}
function settleEntry(state, id, stopReason, now = Date.now()) {
	const e = state.entries.get(id);
	if (!e) return void 0;
	if (stopReason === "completed") e.status = "completed";
	else if (stopReason === "aborted") e.status = "aborted";
	else if (stopReason === "max-tokens") e.status = "max-tokens";
	else e.status = "error";
	e.endedAt = now;
	return e;
}
/**
* The one-message summary a finished child posts.
*
* The panel row already answers「还在跑吗」; this answers「它到底做出了什么」,
* which is the question the reader actually has (and what the old bare
* `✅ 子任务结束 [id]` line never did). Deliberately bounded to the last few
* lines — a child is summarised, never replayed.
*/
function deliveryText(entry, now = Date.now()) {
	return [`${statusMark(entry.status)}【子代理${statusText(entry.status)}】${entry.label} · ${entry.chunks} 条动作 · ${elapsedText(entry.startedAt, entry.endedAt ?? now)}`, ...entry.recent.slice(-3).map((l) => `　　↳ ${l}`)].join("\n");
}
/** Children still running — the window an unattributable frame may fall into. */
function runningEntries(state) {
	return [...state.entries.values()].filter((e) => e.status === "running");
}
/** Settle every still-running one-shot child once the spawning turn is over.
*
* One-shot children are driven inside the tool call that spawned them, so a
* parent `turn/end` means they can no longer progress. `continuable` children
* survive between turns by design — their status is left alone.
*/
function settleRunningOneShots(state, now = Date.now()) {
	let n = 0;
	for (const e of state.entries.values()) {
		if (e.status !== "running" || e.mode !== "one-shot") continue;
		e.status = "completed";
		e.endedAt = now;
		n += 1;
	}
	return n;
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
function statusText(s) {
	switch (s) {
		case "completed": return "完成";
		case "aborted": return "已中止";
		case "error": return "出错";
		case "max-tokens": return "超长截断";
		default: return "进行中";
	}
}
function elapsedText(from, to) {
	const sec = Math.max(0, Math.round((to - from) / 1e3));
	if (sec < 60) return `${sec}秒`;
	const m = Math.floor(sec / 60), s = sec % 60;
	if (m < 60) return s === 0 ? `${m}分` : `${m}分${s}秒`;
	return `${Math.floor(m / 60)}小时${m % 60}分`;
}
function render(state, now = Date.now()) {
	const rows = [];
	for (const [, e] of state.entries) {
		const mark = statusMark(e.status);
		const end = e.endedAt ?? now;
		const line = ` ${mark} **${e.label}** · ${statusText(e.status)} · ${elapsedText(e.startedAt, end)}`;
		rows.push(e.lastActivity === void 0 ? line : `${line}\n　　↳ ${e.lastActivity}`);
	}
	const running = runningEntries(state).length;
	const body = rows.length > 0 ? rows.join("\n") : "（无子任务）";
	const total = state.entries.size;
	const summary = total === 0 ? "" : `\n\n${total - running} 结束 / ${running} 进行中`;
	return {
		config: { wide_screen_mode: true },
		header: {
			template: running > 0 ? "purple" : "grey",
			title: {
				tag: "plain_text",
				content: `🧑‍💻 多代理执行面板（${running} 进行中）`
			}
		},
		elements: [{
			tag: "div",
			text: {
				tag: "lark_md",
				content: body + summary
			}
		}]
	};
}
/** A fresh card state for one team. */
function createTeamState(teamId) {
	return {
		teamId,
		members: /* @__PURE__ */ new Map(),
		tasks: /* @__PURE__ */ new Map(),
		messages: /* @__PURE__ */ new Map()
	};
}
/**
* Fold a member snapshot into the state.
* @param state - the card state to update.
* @param member - the member as the host recorded it.
*/
function addTeamMember(state, member) {
	state.members.set(member.id, {
		id: member.id,
		name: member.name,
		description: member.description,
		provider: member.provider,
		phase: member.phase,
		...member.error === void 0 ? {} : { error: member.error }
	});
}
/**
* Fold a shared-task snapshot into the state.
* @param state - the card state to update.
* @param task - the task as the host recorded it.
*/
function addTeamTask(state, task) {
	state.tasks.set(task.id, {
		id: task.id,
		subject: task.subject,
		description: task.description,
		status: task.status,
		...task.ownerId === void 0 ? {} : { ownerId: task.ownerId },
		blockedBy: [...task.blockedBy]
	});
}
/**
* Fold a queued mailbox message into the state.
* @param state - the card state to update.
* @param message - the message as the host recorded it.
*/
function addTeamMessage(state, message) {
	state.messages.set(message.id, {
		id: message.id,
		senderName: message.senderName,
		targetId: message.targetId,
		content: teamContentText(message.content),
		delivered: false
	});
	while (state.messages.size > 20) {
		const oldest = state.messages.keys().next();
		if (oldest.done === true) break;
		state.messages.delete(oldest.value);
	}
}
/**
* The prefix the team package puts on a relayed message's first block.
*
* The sender's own name is in it, and the rest of the message follows in the
* blocks after it, so the prefix is removed rather than shown twice.
*/
const RELAY_PREFIX = /^Team message from ([^:]+):\s*/;
/**
* Fold a message a teammate relayed into the state.
*
* The team package does not record a mailbox event when one member messages
* another; it steers the message into the target's inbox, and it arrives as
* a `user/message` whose source names the sender. The name is resolved
* against the roster, because the event carries the sender's session id.
* @param state - the card state to update.
* @param message - the relayed message, as the host delivered it.
* @param senderSessionId - the session that sent it.
*/
function addTeamRelayMessage(state, message, senderSessionId) {
	const raw = teamContentText(message.content);
	const match = RELAY_PREFIX.exec(raw);
	const senderName = match?.[1] ?? (senderSessionId === void 0 ? "队友" : state.members.get(senderSessionId)?.name ?? "队友");
	const content = match === null ? raw : raw.slice(match[0].length);
	state.messages.set(message.id, {
		id: message.id,
		senderName,
		targetId: senderSessionId ?? "",
		content,
		delivered: true
	});
	while (state.messages.size > 20) {
		const oldest = state.messages.keys().next();
		if (oldest.done === true) break;
		state.messages.delete(oldest.value);
	}
}
/**
* Mark a message as acknowledged by the session that recorded it.
* @param state - the card state to update.
* @param messageId - the acknowledged message.
*/
function markTeamMessageDelivered(state, messageId) {
	const message = state.messages.get(messageId);
	if (message === void 0) return;
	state.messages.set(messageId, {
		...message,
		delivered: true
	});
}
/**
* The text of a message, flattened from the host's content blocks.
* @param blocks - the content blocks the host recorded.
* @returns one line of readable text.
*/
function teamContentText(blocks) {
	const parts = [];
	for (const block of blocks) if (typeof block?.text === "string" && block.text !== "") parts.push(block.text);
	return parts.join("\n");
}
/** The mark a member's phase is shown with. */
function memberMark(phase) {
	if (phase === "active") return "🟢";
	if (phase === "failed") return "🔴";
	return "⏳";
}
/** The text a member's phase is shown with. */
function memberPhaseText(phase) {
	if (phase === "active") return "在岗";
	if (phase === "failed") return "失败";
	return "准备中";
}
/** The mark a task's status is shown with. */
function taskMark(status) {
	if (status === "completed") return "✅";
	if (status === "in_progress") return "🔨";
	if (status === "deleted") return "🗑️";
	return "⏳";
}
/**
* Render the card for one team.
* @param state - the card state.
* @returns the card object the transport sends.
*/
function renderTeamCard(state) {
	const memberRows = [];
	for (const member of state.members.values()) {
		const detail = member.description === "" ? member.provider : `${member.description}`;
		const failure = member.error === void 0 ? "" : `（${member.error}）`;
		memberRows.push(` ${memberMark(member.phase)} **${member.name}** · ${memberPhaseText(member.phase)} · ${detail}${failure}`);
	}
	const taskRows = [];
	for (const task of state.tasks.values()) {
		if (task.status === "deleted") continue;
		const blocked = task.blockedBy.length === 0 ? "" : ` · 被 ${task.blockedBy.length} 项阻塞`;
		taskRows.push(` ${taskMark(task.status)} **${task.subject}**${blocked}`);
	}
	const messageRows = [];
	for (const message of state.messages.values()) {
		const mark = message.delivered ? "📨" : "📥";
		messageRows.push(` ${mark} ${message.senderName}: ${message.content}`);
	}
	const elements = [];
	elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: memberRows.length === 0 ? "（暂无成员）" : memberRows.join("\n")
		}
	});
	if (taskRows.length > 0) elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: `**共享任务**\n${taskRows.join("\n")}`
		}
	});
	if (messageRows.length > 0) elements.push({
		tag: "div",
		text: {
			tag: "lark_md",
			content: `**往来消息**\n${messageRows.join("\n")}`
		}
	});
	const active = [...state.members.values()].filter((member) => member.phase === "active").length;
	const running = [...state.tasks.values()].filter((task) => task.status === "in_progress").length;
	return {
		config: { wide_screen_mode: true },
		header: {
			template: running > 0 ? "purple" : "grey",
			title: {
				tag: "plain_text",
				content: `👥 团队面板（${active} 在岗 / ${running} 进行中）`
			}
		},
		elements
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
	session: {
		zh: "查看当前会话详情（身份/模型/规模/位置）",
		en: "Inspect the current session (identity/model/size/location)"
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
	think: {
		zh: "查看/设置本会话的思考强度（立即生效）",
		en: "View or change this session’s reasoning effort (applies immediately)"
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
	balance: {
		zh: "查询 DeepSeek API 余额（含当前峰谷时段）",
		en: "Query the DeepSeek API balance (with the live peak/off-peak phase)"
	},
	manual: {
		zh: "完整使用说明",
		en: "The full user guide"
	},
	config: {
		zh: "查看桥的当前配置",
		en: "View the bridge’s current configuration"
	},
	bot: {
		zh: "桥管理：状态/设置/账号/同步/设备（set · unset · peers · sync-plugins · account · export · import · devices · retire · activate · name，发 /bot 看用法）",
		en: "Bridge admin: status/settings/accounts/sync/devices (set · unset · peers · sync-plugins · account · export · import · devices · retire · activate · name — send /bot for usage)"
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
	export: {
		zh: "导出本会话记录",
		en: "Export this session"
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
//#region lib/types/pricing.js
/**
* DeepSeek API peak/off-peak billing awareness.
*
* DeepSeek's official API bills in two phases: peak hours cost DOUBLE the
* off-peak ("空闲") rate. Peak = Beijing-time weekdays 09:00–12:00 and
* 14:00–18:00; everything else — lunch break, evenings, weekends — bills at
* the half rate (official pricing page footnote, verified 2026-09-09 against
* api-docs.deepseek.com/zh-cn/quick_start/pricing).
*
* The fleet runs on this billing, so the model and the human should both see
* which phase is live RIGHT NOW: the model gets it as a prompt section (it
* can schedule deferrable heavy work into the off-peak windows), and the
* first-contact guide states it in one line. All math runs in Asia/Shanghai
* wall clock regardless of the host machine's timezone.
* @module dsh-lark-bridge/pricing
*/
/** Beijing wall-clock parts, derived without timezone-dependent host state. */
function beijingParts(now) {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	}).formatToParts(now);
	const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
	const weekdayShort = get("weekday");
	const hour = Number(get("hour"));
	const minute = Number(get("minute"));
	return {
		weekdayShort,
		minutes: Number.isNaN(hour) || Number.isNaN(minute) ? 0 : hour * 60 + minute
	};
}
const PEAK_WINDOWS = [[540, 720], [840, 1080]];
const WEEKDAYS = /* @__PURE__ */ new Set([
	"Mon",
	"Tue",
	"Wed",
	"Thu",
	"Fri"
]);
/**
* Which phase the Beijing clock is in. Peak is weekday mornings and
* afternoons only — the 12:00–14:00 lunch break, evenings, and weekends all
* bill at the half rate ("其余为空闲时段", official footnote).
*/
function deepseekBillingPhase(now = /* @__PURE__ */ new Date()) {
	const { weekdayShort, minutes } = beijingParts(now);
	if (!WEEKDAYS.has(weekdayShort)) return "off-peak";
	return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end) ? "peak" : "off-peak";
}
/** Beijing wall clock as `HH:MM 周X` for display lines. */
function beijingClock(now = /* @__PURE__ */ new Date()) {
	const { weekdayShort, minutes } = beijingParts(now);
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} 周${{
		Mon: "一",
		Tue: "二",
		Wed: "三",
		Thu: "四",
		Fri: "五",
		Sat: "六",
		Sun: "日"
	}[weekdayShort] ?? weekdayShort}`;
}
/**
* The model-facing prompt section: the rule, the current phase, and the
* scheduling nudge — cheap tokens that save real money on batch work.
*/
function pricingPromptLine(now = /* @__PURE__ */ new Date()) {
	return "DeepSeek 官方 API 分两档计价：高峰时段为北京时间周一至周五 9:00–12:00 与 14:00–18:00，其余时间（午休、晚间、周末）为空闲时段，价格是高峰的一半。" + (deepseekBillingPhase(now) === "peak" ? `现在是高峰时段（北京时间 ${beijingClock(now)}）——计费为空闲的两倍。` : `现在是空闲时段（北京时间 ${beijingClock(now)}）——计费为高峰的一半。`) + "当用户关心成本，或安排可延迟的批量任务（大规模重写、批量抓取、夜间跑数）时，优先把重活排进空闲时段（北京时间 18:00 后或周末）执行。";
}
/** One human-facing line for the first-contact guide. */
function pricingHumanLine(now = /* @__PURE__ */ new Date()) {
	return `- 计费：DeepSeek API 分高峰/空闲两档，空闲半价（高峰=北京时间工作日 9:00–12:00、14:00–18:00）。当前是**${deepseekBillingPhase(now) === "peak" ? "高峰（双倍计费）" : "空闲（半价）"}**时段（北京时间 ${beijingClock(now)}）——批量重活可留到晚间/周末跑。`;
}
//#endregion
//#region lib/types/balance.js
/**
* DeepSeek open-platform balance query (the `/balance` command's guts).
*
* Endpoint: `GET https://api.deepseek.com/user/balance`, Bearer-authed with
* the SAME key the harness bills through (`DEEPSEEK_API_KEY` in the deploy
* environment). Verified live 2026-09-09: the payload carries
* `is_available` plus `balance_infos[]` of {currency, total_balance,
* granted_balance, topped_up_balance}, all string-typed decimals.
*
* The reply always states the query moment and the live peak/off-peak
* phase — a balance number without "when" is how stale-number accidents
* happen (行情必须实测).
* @module dsh-lark-bridge/balance
*/
const BALANCE_URL = "https://api.deepseek.com/user/balance";
/** Query the platform balance with one API key. Throws on HTTP/shape errors. */
async function fetchDeepseekBalance(apiKey, fetchImpl = fetch) {
	const res = await fetchImpl(BALANCE_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
	if (res.status !== 200) throw new Error(`HTTP ${res.status}${res.status === 401 ? "（key 无效或已过期）" : ""}`);
	const data = await res.json();
	const balances = (Array.isArray(data.balance_infos) ? data.balance_infos : []).filter((info) => typeof info.currency === "string").map((info) => ({
		currency: info.currency,
		total: info.total_balance ?? "?",
		granted: info.granted_balance ?? "?",
		toppedUp: info.topped_up_balance ?? "?"
	}));
	if (balances.length === 0) throw new Error("响应里没有余额条目");
	return {
		available: data.is_available === true,
		balances
	};
}
/**
* The chat reply: one line per currency (only non-zero buckets get the
* breakdown; a drained key shows the 0.00 instead of hiding behind it),
* service availability, the live billing phase, and the query moment.
*/
function formatBalanceReply(result, now = /* @__PURE__ */ new Date()) {
	const stamp = new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	}).format(now);
	const rows = result.balances.map((balance) => {
		if (balance.granted !== "0.00" && balance.granted !== "0") return `- ${balance.currency}：**${balance.total}**（赠送 ${balance.granted} + 充值 ${balance.toppedUp}）`;
		return `- ${balance.currency}：**${balance.total}**`;
	});
	return [
		`**DeepSeek 余额**（查询于北京时间 ${stamp} · 服务${result.available ? "✅ 可用" : "⛔ 平台标记不可用"}）`,
		...rows,
		"",
		pricingHumanLine(now)
	].join("\n");
}
//#endregion
//#region lib/types/user-guide.js
/**
* The user-facing guide (the `/manual` command's content).
*
* Written for the human in the chat, not the operator: what the bot is, how
* to talk to it, every command with one example line, and the fleet/account/
* billing facts that prevent support questions. Single source for the chat
* surface; `docs/用户手册.md` mirrors it for repo readers.
* @module dsh-lark-bridge/user-guide
*/
const USER_GUIDE = `**使用说明**

**一、这是什么**
我是跑在 DeepSeek Harness 上的编码智能体，通过本桥接进飞书。同一个飞书应用背后是 web + desktop 双端舰队——**同一时刻只有活跃端回复**（防双回复），另一端待命。待命端收到 \`/help\`、\`/bot devices\` 这类只读排障命令时会回一句告诉你活跃端是谁，其它消息仍由活跃端应答。

**二、日常怎么用**
- 直接说话就是派活：「帮我看看 X 项目」「跑一下测试」「把这个报告改成英文」。
- 文件、图片直接拖进聊天：发来的文件自动落到工作区；让我发文件给你，我会用 send_file。
- 长任务会先回一句「收到」，过程有思考过程卡片（工具结果只显示头几行，完整内容在会话记录里）；每轮结束会有一句「✅ 本轮完成 · N 次工具调用 · 用时 M」；想中途喊停发 \`/stop\`。
- 长任务跑到一半想改方向，直接再发一条消息：可能排到这一轮之后处理，也可能在下一步就生效（看部署设置 \`busyPolicy\`）；想整轮放弃发 \`/stop\`。
- 我会主动用 feishu_notify 报里程碑和定时任务结果，不用盯屏。
- 网页端：\`http://127.0.0.1:18787\`（开机自启；跑的是和飞书端同一套会话库）。启动 token 每次重启都换，浏览器没 cookie 时裸开会 401——先打开启动日志里 \`dsh web: http://127.0.0.1:18787/?token=…\` 那行一次（会种下长效 cookie），之后裸地址和仓库 \`bin/open-dsh-web.cmd\` 都能直达。

**三、命令速查**
会话控制：\`/stop\` 停止当前任务 · \`/preset\` 切模式（标准/代码/极简/创造） · \`/plan\` 计划模式 · \`/compact\` 压缩历史 · \`/clear\` 清上下文 · \`/new\` 新会话
观测：\`/context\` token 压力 · \`/audit\` 操作审计 · \`/jobs\` 后台任务 · \`/schedules\` 定时提醒 · \`/sessions\` 会话历史
配置：\`/model\` 看换默认模型（只影响新会话） · \`/think\` 看换本会话思考强度（下一步即生效，\`/think reset\` 回默认） · \`/tools\` 看能力全景/禁用/恢复工具 · \`/permission <模式>\` 权限（⚠️ 不带参数只显示状态，不是菜单） · \`/config\` 桥配置 · \`/skills\` 技能清单 · \`/ws\` 工作区 · \`/plugins\` 插件
反馈：\`/feedback\` · \`/help\` 命令列表 · \`/manual\` 本说明

**四、钱袋（DeepSeek 计费）**
- \`/balance\` 查余额（含查询时刻和当前峰/谷档）。
- 高峰=北京时间周一至五 9:00–12:00、14:00–18:00，价格翻倍；其余（午休、晚间、周末）半价。批量重活我会优先排进谷价时段。

**五、换飞书账号（两步）**
1. 发 \`/bot account\` → 弹出账号库卡片 → 点目标账号的「✅使用」。
2. 生效：本端发 \`/restart\`；desktop 端重启 DSH Desktop。
存新账号：\`/bot account save <名字>\`；忘了谁在库里：直接发 \`/bot account\` 看卡片。

**六、设备舰队（多机/多端）**
- \`/bot devices\` 全家福：哪台在线、谁是活跃端、云端台账。
- \`/bot activate\` 让**本端**接管应答（原活跃端自动退避）；\`/bot retire\` 本端退位。
- 换机迁移：旧机 \`/bot export include-secrets --to-feishu\` → 新机 \`/bot import --from-feishu apply\` → 旧机 \`/bot retire\`，零拷贝。
- \`/bot name <名字>\` 给设备起可读名；\`/bot peers\` 看在线对端。

**七、故障排查**
- 发消息没反应：先 \`/bot devices\` 看活跃端在不在；活跃端掉线会自动改选，等 3 分钟或手动 \`/bot activate\`。
- 回「活跃端是 XX，本端已退避」：正常，说明另一端在管事；想换到本机就 \`/bot activate\`。
- 命令面板（输入框点 /）和实际不符：面板由活跃端维护，让活跃端重进一次会话即可重同步。
- 卡在等确认：看有没有带按钮的卡片没点；文字列的选项不是菜单，直接发对应命令。
- desktop 端让你手输模型 key：说明共享铺设缺失或 key 轮换了——告诉我重铺一次即可，铺完永久生效。

**八、权限提醒**
当前部署若是 danger-full-access（全自动）：命令直接执行不弹卡，我和你拥有同等文件权限——只在信任的环境这么开。
`;
/**
* The harness home the record lives in: `DSH_HOME` when set, else `~/.dsh`.
* Local on purpose — the notice serves the machine whose process restarted.
* @param home - override for tests.
* @returns the directory path (not created here).
*/
function restartNoticeHome(home) {
	return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), ".dsh");
}
/**
* Path of the pending-restart record.
* @param home - override for tests.
* @returns the record file path.
*/
function restartNoticePath(home) {
	return path.join(restartNoticeHome(home), ".restart-notice.json");
}
/**
* Record one restart request. Best effort: a restart must never be blocked by
* a failed bookkeeping write.
* @param chatId - the chat to notify on the next boot.
* @param home - override for tests.
* @returns true when the record was written.
*/
function writeRestartRequest(chatId, home) {
	try {
		const file = restartNoticePath(home);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({
			chatId,
			requestedAt: Date.now()
		}), "utf8");
		return true;
	} catch {
		return false;
	}
}
/**
* Read the record, dropping one that outlived its TTL (an old restart is old
* news — this also covers a restart that never came back).
* @param home - override for tests.
* @param now - clock override for tests.
* @returns the request, or null when none is pending.
*/
function readRestartRequest(home, now = Date.now()) {
	let raw;
	try {
		raw = readFileSync(restartNoticePath(home), "utf8");
	} catch {
		return null;
	}
	try {
		const value = JSON.parse(raw);
		if (typeof value.chatId !== "string" || value.chatId === "" || typeof value.requestedAt !== "number") {
			rmSync(restartNoticePath(home), { force: true });
			return null;
		}
		const request = {
			chatId: value.chatId,
			requestedAt: value.requestedAt
		};
		const age = now - request.requestedAt;
		if (age > 9e5 || age < -6e4) {
			rmSync(restartNoticePath(home), { force: true });
			return null;
		}
		return request;
	} catch {
		rmSync(restartNoticePath(home), { force: true });
		return null;
	}
}
/**
* Drop the pending record once its notice has been delivered.
* @param home - override for tests.
*/
function clearRestartRequest(home) {
	rmSync(restartNoticePath(home), { force: true });
}
/**
* The restored line: when the service came back and how long it was away.
* @param request - the pending request.
* @param now - delivery time, milliseconds.
* @returns markdown for the chat.
*/
function restartNoticeLine(request, now = Date.now()) {
	const at = new Date(now).toLocaleTimeString("zh-CN", { hour12: false });
	const seconds = Math.max(0, Math.round((now - request.requestedAt) / 1e3));
	return `✅ 重启完成：服务已于 ${at} 恢复，本次重启共约 ${seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`}（自 /restart 起算）。`;
}
/**
* Deliver the pending notice once, if any: reads, sends, clears.
* @param port - the channel's outbound surface.
* @param report - operator log for a failed delivery (the record is kept for retry).
* @param options - home/time overrides for tests.
* @returns 'sent' when this call delivered it, 'none' without a record, 'retry' on a failed send.
*/
async function deliverRestartNotice(port, report, options = {}) {
	const request = readRestartRequest(options.home, options.now ?? Date.now());
	if (request === null) return "none";
	try {
		await port.send(request.chatId, { markdown: restartNoticeLine(request, options.now ?? Date.now()) });
	} catch (error) {
		report(`dsh-lark-bridge: restart notice delivery failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
		return "retry";
	}
	clearRestartRequest(options.home);
	return "sent";
}
/**
* Boot-side delivery loop: the transport is usually still connecting right
* after a restart, so attempts repeat until the notice is delivered, the
* attempts run out, or the record goes stale. The timer is unref'd — it must
* never hold the process open on its own.
* @param port - the channel's outbound surface.
* @param report - operator log sink.
* @param options - home/interval/attempt overrides for tests.
* @returns a stopper that cancels the loop.
*/
function scheduleRestartNotice(port, report, options = {}) {
	const intervalMs = options.intervalMs ?? 15e3;
	const maxAttempts = options.maxAttempts ?? 20;
	let attempts = 0;
	let stopped = false;
	let inFlight = false;
	let timer;
	const stop = () => {
		stopped = true;
		if (timer !== void 0) clearInterval(timer);
	};
	const tick = () => {
		if (stopped || inFlight) return;
		inFlight = true;
		attempts += 1;
		deliverRestartNotice(port, report, options.home === void 0 ? {} : { home: options.home }).then((result) => {
			inFlight = false;
			if (result === "retry" && attempts < maxAttempts) return;
			stop();
		}, () => {
			inFlight = false;
			stop();
		});
	};
	timer = setInterval(tick, intervalMs);
	timer.unref?.();
	tick();
	return stop;
}
//#endregion
//#region lib/types/notices.js
/**
* Low-frequency session events rendered as one-off chat lines.
*
* The remaining events dsh logs that a chat user benefits from hearing are
* small and one-shot: a subagent child opening, a scheduled task being
* created or deleted, a DeepSeek search firing, and a model-call retry. Each
* maps to a single short line — no card, no state — so the chat stays a
* readable stream. `session/title` is deliberately NOT rendered: the Web UI
* uses it for its session list, and a messaging chat has no list surface.
* @module dsh-lark-bridge/notices
*/
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
/**
* The tail of a job's output, normalised for chat.
*
* The END of a run is where the answer lands — the head is usually setup noise
* and progress spam — so a long output is cut from the FRONT and says how much
* it dropped, rather than being truncated from the back into uselessness.
*/
function outputTail(output, limit = DEFAULT_LIMITS.jobTailChars) {
	if (output === void 0) return "";
	const trimmed = output.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
	if (trimmed === "") return "";
	if (trimmed.length <= limit) return trimmed;
	return `…（前 ${trimmed.length - limit} 字省略）\n${trimmed.slice(-limit)}`;
}
/**
* A background job's terminal line (from the registry's `settled` event).
*
* Naming only the command tells the reader nothing they did not already know
* when it started — the answer is the job's OUTPUT. The caller reads the
* retained tail off the ring and hands it in here.
*/
/**
* A one-line form of a job label. `tool-bash` labels carry the command line
* verbatim — often several lines — and a notice that opens with all of it
* buries the one line a reader needs.
*/
function labelLine(label, limit = 80) {
	const lines = label.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	const first = lines[0] ?? "";
	if (first === "") return "";
	const chars = Array.from(first);
	const clipped = chars.length > limit ? chars.slice(0, limit).join("") : first;
	return lines.length > 1 || chars.length > limit ? `${clipped}…` : clipped;
}
/**
* How long the job ran, for the completion notice. The snapshot carries only
* `startedAt`, so the caller passes the milliseconds it measured at
* settlement — the one number a reader always wants and never had.
*/
function durationLine(durationMs) {
	if (durationMs === void 0 || !Number.isFinite(durationMs) || durationMs < 0) return "";
	const seconds = Math.round(durationMs / 1e3);
	if (seconds < 60) return `（耗时 ${seconds} 秒）`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `（耗时 ${minutes} 分 ${seconds % 60} 秒）`;
	return `（耗时 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分）`;
}
function jobDoneLine(job, tailChars = DEFAULT_LIMITS.jobTailChars) {
	const mark = job.status === "completed" ? "✅" : job.status === "killed" ? "⏹️" : "❌";
	const detail = job.detail === void 0 || job.detail === "" ? "" : `（${job.detail}）`;
	const label = labelLine(job.label);
	const took = durationLine(job.durationMs);
	const head = `${mark} 后台任务完成：${label === "" ? job.kind : label}${detail}${took} [${job.id}]`;
	const tail = outputTail(job.output, tailChars);
	return tail === "" ? head : `${head}\n\`\`\`\n${tail}\n\`\`\``;
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
/** 千分位，中文数字习惯。 */
function num(value) {
	return value.toLocaleString("zh-CN");
}
/**
* 上下文占用的预警文案。
*
* 原来写的是「总量 X tokens / 会话表面 Y」——「会话表面」是宿主字段
* `surfaceTokens` 的直译，读者从中看不出它指的是"你俩聊过的内容"，更看不出
* 总量与它之间的差额是工具说明这类常驻开销。差额恰恰是关键：真正超线时，
* 压历史能降的是前半段，压不掉的是后半段。
* @param data - 当前总量、其中的聊天内容、以及预警线。
* @returns 发到聊天里的那一段。
*/
function tokenPressureLine(data) {
	const other = data.total - data.surface;
	return `${`⚠️ 上下文偏重了：一共约 ${num(data.total)} token，其中聊天内容 ${num(data.surface)}`}${other > 0 ? `，其余 ${num(other)} 是工具说明等固定开销\n已超过 ${num(data.threshold)} 的建议压缩线。` : `\n已超过 ${num(data.threshold)} 的建议压缩线。`}${other > 0 ? "/compact 能压掉聊天内容那部分；工具说明是常驻的，压不掉——要压它只能少挂工具（换极简模式、关掉不用的 MCP）。" : "长任务建议先 `/compact` 压缩，或让 agent 收尾当前阶段。"}`;
}
/**
* `/context` 的回复：占用多少，以及占在哪。
*
* 一行总数对"要不要压缩"够用，对"压了有没有用"不够：一台挂满 MCP 的机器，
* 工具说明就能占掉小一半，这时压历史是白费力气。所以有分组就摊开说。
* @param data - 总量、聊天内容、可选的三段拆分。
* @returns 回复正文（markdown）。
*/
function contextPressureLine(data) {
	const rows = [`上下文占用：合计约 ${num(data.total)} token`];
	if (data.breakdown === void 0) rows.push(`· 其中聊天内容约 ${num(data.surface)}`);
	else {
		rows.push(`· 聊天内容约 ${num(data.breakdown.messageTokens)}`);
		rows.push(`· 系统提示约 ${num(data.breakdown.systemTokens)}`);
		rows.push(`· 工具说明约 ${num(data.breakdown.toolsTokens)}`);
	}
	if (data.total > 6e5) rows.push("", "⚠️ 已经很重了：除了 `/compact`，更有效的是减负——换极简模式、或关掉不常用的 MCP 服务，工具说明这才降得下来。");
	else if (data.total > 12e4) rows.push("", "⚠️ 偏高，长任务建议先 `/compact` 压缩历史。");
	else if (data.total > 6e4) rows.push("", "📈 在长，超过 12 万后建议压缩。");
	return rows.join("\n");
}
//#endregion
//#region lib/types/think.js
/**
* Per-session reasoning effort: `/think`.
*
* The effort a turn runs at is not something the bridge can set on the agent.
* The loop resolves it as `options.reasoningEffort ?? persisted header`, and
* the options come from the deployment's default at creation time — so
* rewriting that default, which is all `/model` can do, reaches the NEXT
* session and leaves every running one where it was. A chat needs two things a
* command can give it: a way to READ what the next request will actually send,
* and a way to CHANGE it without opening a new session.
*
* The change rides the host's own `agent/request` waterfall — the same seam the
* web UI's model picker uses (`installModelSelection`): the resolved envelope
* is rewritten on its way to the adapter, so a switch lands on the next step
* rather than the next session. The choice is recorded as a durable
* `model/selection` event, the exact event shape that surface writes, so a
* resumed session and a web-UI client read the same fact instead of two.
* @module dsh-lark-bridge/think
*/
/**
* Levels offered when no adapter publishes its own.
*
* These are the levels the DeepSeek adapters ship (off/low/high/max). The list
* is a fallback, not the truth: a route that describes itself wins, because
* offering a level the provider rejects turns a settings command into a failed
* turn.
*/
const FALLBACK_EFFORTS = [
	"off",
	"low",
	"high",
	"max"
];
/**
* Parse one `/think` line.
* @param line - the trimmed command line, leading slash included.
* @returns what the line asked for; an empty argument means "show".
*/
function parseThinkLine(line) {
	const arg = (new RegExp(`^/think(?:\\s+(.*))?$`, "i").exec(line.trim())?.[1] ?? "").trim().toLowerCase();
	if (arg === "") return { kind: "show" };
	if (arg === "reset" || arg === "default" || arg === "auto") return { kind: "reset" };
	return {
		kind: "set",
		effort: arg
	};
}
/**
* Read the last model selection one session recorded.
*
* The scan is a plain array walk — the host serves `eventAt` straight out of
* the loaded log — so it costs nothing measurable on the path that opens a
* session, and it keeps the choice in the session instead of in a second store
* that could drift from it.
* @param session - the session whose log to scan.
* @returns the newest recorded selection, or undefined when none exists.
*/
function lastSelection(session) {
	let found;
	for (let seq = 0; seq < session.seq; seq++) {
		const event = session.eventAt(seq);
		if (event?.type !== "model/selection") continue;
		const data = event.data;
		if (data !== void 0 && typeof data === "object") found = data;
	}
	return found;
}
/**
* Resolve the levels one route accepts.
* @param llm - the llm runtime, when composed.
* @param provider - the route's provider.
* @param model - the route's model.
* @returns the adapter's own list when it has one, the fallback otherwise.
*/
async function effortCatalog(llm, provider, model) {
	if (llm !== void 0 && provider !== void 0 && provider !== "" && model !== void 0 && model !== "") try {
		const reasoning = (await llm.resolveModelInfo(provider, model)).reasoning;
		if (reasoning !== void 0 && reasoning.efforts.length > 0) return {
			levels: reasoning.efforts.map((effort) => ({
				id: effort.id,
				...effort.name === void 0 ? {} : { name: effort.name }
			})),
			...reasoning.defaultEffort === void 0 ? {} : { defaultEffort: reasoning.defaultEffort },
			source: "adapter"
		};
	} catch {}
	return {
		levels: FALLBACK_EFFORTS.map((id) => ({ id })),
		source: "fallback"
	};
}
/**
* The live per-session effort choices, and the request hook that applies them.
*
* One instance serves the whole bridge: every agent's `setup` installs a hook
* that reads this table by session id, so a choice made in a chat applies to
* that chat's agent and to no other.
*/
var EffortOverrides = class {
	bySession = /* @__PURE__ */ new Map();
	/** Advertised levels per route, so the capability lookup runs once per model. */
	accepted = /* @__PURE__ */ new Map();
	ctx;
	/**
	* @param ctx - the bridge's context, used to reach the llm runtime lazily —
	*   a profile that mounts the llm row later still gets a correct answer.
	*/
	constructor(ctx) {
		this.ctx = ctx;
	}
	/**
	* The override in force for one session.
	* @param sessionId - the session to look up.
	* @returns the chosen effort, or undefined when the session follows the default.
	*/
	get(sessionId) {
		return this.bySession.get(sessionId);
	}
	/**
	* Re-read one session's choice from its own log.
	*
	* Called when an agent is composed: a resumed session must come back at the
	* effort its human chose, not at the deployment default.
	* @param session - the session being opened.
	*/
	restore(session) {
		const recorded = lastSelection(session);
		if (recorded === void 0) return;
		if (recorded.reasoningEffort === void 0) this.bySession.delete(session.id);
		else this.bySession.set(session.id, recorded.reasoningEffort);
	}
	/**
	* Record one session's choice, durably when the host can append.
	* @param session - the session the choice belongs to.
	* @param selection - the provider/model it applies to, plus the effort
	*   (`undefined` clears the override and returns the session to the default).
	*/
	set(session, selection) {
		if (selection.reasoningEffort === void 0) this.bySession.delete(session.id);
		else this.bySession.set(session.id, selection.reasoningEffort);
		session.append?.("model/selection", selection);
	}
	/**
	* Install the request-side override on one agent's scope.
	* @param agentCtx - the agent's scoped context.
	* @param sessionId - the session this agent drives.
	*/
	install(agentCtx, sessionId) {
		const override = async (_payload, next) => {
			const resolved = await next();
			const wanted = this.bySession.get(sessionId);
			if (wanted === void 0) return resolved;
			if (!await this.accepts(resolved.provider, resolved.model, wanted)) return resolved;
			return {
				...resolved,
				reasoningEffort: wanted
			};
		};
		agentCtx.on("agent/request", override);
	}
	/**
	* Whether one route advertises an effort.
	*
	* Unknown routes pass: a provider that publishes no reasoning metadata may
	* still accept the field, and refusing on silence would make the command
	* useless on exactly the deployments that need it.
	*/
	async accepts(provider, model, effort) {
		const key = `${provider}/${model}`;
		const cached = this.accepted.get(key);
		if (cached !== void 0) return cached.has(effort);
		const llm = this.ctx.get("llm");
		if (llm === void 0) return true;
		try {
			const efforts = (await llm.resolveModelInfo(provider, model)).reasoning?.efforts;
			if (efforts === void 0 || efforts.length === 0) return true;
			const ids = new Set(efforts.map((level) => level.id));
			this.accepted.set(key, ids);
			return ids.has(effort);
		} catch {
			return true;
		}
	}
};
/** Render the levels one catalog offers, in the order the adapter gave them. */
function levelList(catalog) {
	return catalog.levels.map((level) => `\`${level.id}\``).join(" · ");
}
/**
* Handle `/think [level|reset]`: show or change this session's reasoning effort.
* @param line - the trimmed command line.
* @param agent - the chat's agent (owns the session being changed).
* @param overrides - the live override table, when the bridge wired one.
* @param llm - the llm runtime, when composed (for the route's own levels).
* @param defaultModel - the deployment default, for the "follow the default" line.
* @returns the reply for the chat.
*/
async function runThinkCommand(line, agent, overrides, llm, defaultModel) {
	if (overrides === void 0) return {
		reply: "⚠️ 本部署没有启用思考强度控制，`/think` 不可用。",
		resolved: false
	};
	const session = agent.session;
	const intent = parseThinkLine(line);
	const header = session.requestHeader?.()?.config;
	const configured = defaultModel?.currentSelection();
	const provider = header?.provider ?? configured?.provider;
	const model = header?.model ?? configured?.model;
	const catalog = await effortCatalog(llm, provider, model);
	const current = overrides.get(session.id);
	if (intent.kind === "show") {
		const effective = current ?? header?.reasoningEffort;
		const origin = current !== void 0 ? "本会话设置" : header?.reasoningEffort === void 0 ? "未显式设置，由模型决定" : "上一次请求实际使用";
		const fallback = configured?.reasoningEffort;
		return {
			reply: [
				"**思考强度**（本会话）",
				`当前：${effective === void 0 ? "未设置" : `\`${effective}\``}（${origin}）`,
				`可选：${levelList(catalog)}${catalog.source === "fallback" ? "（模型未声明，按 DeepSeek 通用档位）" : ""}`,
				`部署默认：${fallback === void 0 ? "未设置" : `\`${fallback}\``}`,
				"",
				`切换：\`/${THINK_COMMAND} <档位>\` · 回到默认：\`/${THINK_COMMAND} reset\``,
				"改动对下一步请求即生效，不用 `/new`。"
			].join("\n"),
			resolved: true
		};
	}
	const route = {
		provider,
		model
	};
	if (route.provider === void 0 || route.provider === "" || route.model === void 0 || route.model === "") return {
		reply: "⚠️ 还不知道本会话用哪个模型，等这轮请求跑完再试 `/think`。",
		resolved: false
	};
	if (intent.kind === "reset") {
		overrides.set(session, {
			provider: route.provider,
			model: route.model
		});
		const back = configured?.reasoningEffort;
		return {
			reply: `✅ 已回到部署默认${back === void 0 ? "（未设置，由模型决定）" : `（\`${back}\`）`}，下一步请求生效。`,
			resolved: true
		};
	}
	if (!catalog.levels.some((level) => level.id === intent.effort)) return {
		reply: `⚠️ 没有 \`${intent.effort}\` 这一档。\n可选：${levelList(catalog)}`,
		resolved: false
	};
	overrides.set(session, {
		provider: route.provider,
		model: route.model,
		reasoningEffort: intent.effort
	});
	return {
		reply: `✅ 思考强度已设为 \`${intent.effort}\`，下一步请求即生效（不用 \`/new\`）。回到默认：\`/${THINK_COMMAND} reset\`。`,
		resolved: true
	};
}
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
* chat. Exported for tests to stub.
*
* The delay is carried by the CHILD, not by a timer here: this process is
* about to be killed, so a `setTimeout` in it would die with the reply still
* in flight. That means each platform needs its own way to wait, and the one
* this used to hardcode — `/bin/sh -c 'sleep 2.5 && …'` — does not exist on
* Windows at all. `spawn('/bin/sh', …)` there fails with ENOENT before the
* command ever runs, so `/restart` could never work on Windows no matter what
* `restartCommand` was configured to. PowerShell is the Windows equivalent
* that is always present (5.1 ships with the OS), and `Start-Sleep` is its
* `sleep`.
*/
let scheduleRestart = (shell) => {
	import("node:child_process").then(({ spawn }) => {
		const windows = process.platform === "win32";
		spawn(windows ? "powershell.exe" : "/bin/sh", windows ? [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Start-Sleep -Milliseconds 2500; ${shell}`
		] : ["-c", `sleep 2.5 && ${shell}`], {
			detached: true,
			stdio: "ignore",
			windowsHide: windows
		}).unref();
	});
};
/**
* Records the chat that asked for a restart so the next boot can report when
* the service came back (src/restart-notice.ts). Exported for tests to stub.
*/
let recordRestartRequest = (chatId) => writeRestartRequest(chatId);
/** List what this chat accepts. Not a host command: the list is per surface. */
const HELP_COMMAND = "help";
/** Switch the agent's preset (standard / code / minimal / cordis). */
const PRESET_COMMAND = "preset";
/** List this chat's stored sessions. */
const SESSIONS_COMMAND = "sessions";
/**
* What THIS session is: identity, model route, size, where it lives.
*
* `sessions` (plural) lists the chat's history and `context` reports token
* pressure; neither answers "which session am I talking to right now, on what
* model, since when, and how big has it grown". Every one of those facts was
* already reachable through some other command or not at all, so a reader
* trying to explain unexpected behaviour — a wrong model answering, a stale
* context, a session that reset without warning — had to reconstruct it from
* several replies and timestamps. One command that states them together is
* the difference between diagnosing that in one glance and in ten messages.
*/
const SESSION_COMMAND = "session";
/** Query the DeepSeek platform balance the deployment bills through. */
const BALANCE_COMMAND = "balance";
/** The full user guide, in chat. */
const MANUAL_COMMAND = "manual";
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
/**
* View or change THIS session's reasoning effort.
*
* Lives beside `/model` because the two answer the same question at different
* scopes: `/model` moves the deployment default (new sessions), `/think` moves
* the session in front of you (next request). The implementation is in
* `src/think.ts`; the name lives here because this module is the single list
* every surface — `/help`, the panel, the docs gate — reads it from.
*/
const THINK_COMMAND = "think";
/** 一张回复最多列几个工作区／会话，多出来的只说数量。 */
const WS_ROWS_MAX = 20;
const SESSION_ROWS_MAX = 20;
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
function helpText(commands, agent, locale = "zh", config, feedback) {
	const own = [
		`\`/${STOP_COMMAND}\` — ${describeCommand(STOP_COMMAND, locale, "Stop the current task")}`,
		...config?.restartCommand ? [`\`/${RESTART_COMMAND}\` — ${describeCommand(RESTART_COMMAND, locale, "Restart the host process")}`] : [],
		`\`/new\` — ${describeCommand("new", locale, "Start a new session")}`,
		`\`/${PRESET_COMMAND}\` — ${describeCommand(PRESET_COMMAND, locale, "View or switch mode")}`,
		`\`/${SESSIONS_COMMAND}\` — ${describeCommand(SESSIONS_COMMAND, locale, "View session history")}`,
		`\`/${SESSION_COMMAND}\` — ${describeCommand(SESSION_COMMAND, locale, "Inspect the current session")}`,
		`\`/${TOOLS_COMMAND}\` — ${describeCommand(TOOLS_COMMAND, locale, "View, deny, or allow tools")}`,
		`\`/${SCHEDULES_COMMAND}\` — ${describeCommand(SCHEDULES_COMMAND, locale, "View scheduled reminders")}`,
		`\`/${JOBS_COMMAND}\` — ${describeCommand(JOBS_COMMAND, locale, "View background jobs")}`,
		`\`/${CONTEXT_COMMAND}\` — ${describeCommand(CONTEXT_COMMAND, locale, "View context pressure")}`,
		`\`/${SKILLS_COMMAND}\` — ${describeCommand(SKILLS_COMMAND, locale, "List / inspect discoverable skills")}`,
		`\`/${MODEL_COMMAND}\` — ${describeCommand(MODEL_COMMAND, locale, "View or switch the default model")}`,
		`\`/${THINK_COMMAND}\` — ${describeCommand(THINK_COMMAND, locale, "View or change this session’s reasoning effort")}`,
		`\`/bot\` — ${describeCommand("bot", locale, "Bridge dual-end status, settings, plugin sync")}`,
		`\`/${BALANCE_COMMAND}\` — ${describeCommand(BALANCE_COMMAND, locale, "DeepSeek API balance")}`,
		...feedback === void 0 ? [] : [`\`/${FEEDBACK_COMMAND}\` — ${describeCommand(FEEDBACK_COMMAND, locale, "Record feedback about this session")}`],
		`\`/${MANUAL_COMMAND}\` — ${describeCommand(MANUAL_COMMAND, locale, "The full user guide")}`,
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
async function runCommandLine(line, agent, commands, signal, presets = void 0, persistence = void 0, chatId = void 0, deniedTools = void 0, schedules = void 0, audits = void 0, config = void 0, sessionPresets = void 0, sessionQuery = void 0, jobs = void 0, feedback = void 0, lastAssistantMessageId = void 0, tokenMeter = void 0, skills = void 0, defaultModel = void 0, configModel = void 0, workspaces = void 0, currentCwd = void 0, loaderEntries = void 0, sync = void 0, tools = void 0, toolScope = void 0, cwdBound = false, extras = void 0) {
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
			reply: "🔁 正在重启：预计 2 分钟内恢复；恢复后我会在这里报一声。" + (chatId === void 0 || recordRestartRequest(chatId) ? "" : "\n⚠️ 注意：恢复回执未能写入磁盘（可能收不到那条「已恢复」）。"),
			resolved: true
		};
	}
	if (name === "preset") return runPresetCommand(trimmed, agent, presets, sessionPresets);
	if (name === "sessions") return runSessionsCommand(agent, persistence, chatId, trimmed.slice(9).trim(), sessionQuery, config?.limits ?? DEFAULT_LIMITS);
	if (name === "session") return runSessionCommand(agent, tokenMeter, config, extras);
	if (name === "jobs") return runJobsCommand(agent, jobs);
	if (name === "feedback") return runFeedbackCommand(trimmed, agent, feedback, lastAssistantMessageId);
	if (name === "context") return runContextCommand(agent, tokenMeter, extras?.ctx);
	if (name === "tools") return runToolsCommand(trimmed, deniedTools, tools, toolScope);
	if (name === "schedules") return runSchedulesCommand(agent, schedules, config?.limits ?? DEFAULT_LIMITS);
	if (name === "audit") return runAuditCommand(agent, audits);
	if (name === "skills") return runSkillsCommand(trimmed, skills, config?.limits ?? DEFAULT_LIMITS);
	if (name === "bot") {
		if (sync === void 0) return {
			reply: "⚠️ 本部署未启用双端同步（缺少 sync 上下文）。",
			resolved: false
		};
		return runBotCommand(trimmed, sync);
	}
	if (name === "manual") return {
		reply: USER_GUIDE,
		resolved: true
	};
	if (name === "balance") {
		const key = process.env.DEEPSEEK_API_KEY;
		if (key === void 0 || key === "") return {
			reply: "⚠️ 本端环境没有 `DEEPSEEK_API_KEY`，查不了余额。web 端由启动脚本导出；desktop 端看应用自身的 provider 配置。",
			resolved: true
		};
		try {
			return {
				reply: formatBalanceReply(await fetchDeepseekBalance(key)),
				resolved: true
			};
		} catch (error) {
			return {
				reply: `⚠️ 余额查询失败：${error instanceof Error ? error.message : String(error)}`,
				resolved: true
			};
		}
	}
	if (name === "model") return runModelCommand(trimmed, defaultModel, configModel, config?.modelCatalog);
	if (name === "think") return runThinkCommand(trimmed, agent, extras?.efforts, extras?.llm, defaultModel);
	if (name === "ws") return runWsCommand(workspaces, currentCwd, cwdBound);
	if (name === "plugins") return runPluginsCommand(loaderEntries);
	if (name === "config") return runConfigCommand(config);
	if (name === "help") return {
		reply: helpText(commands, agent, config?.locale ?? "zh", config, feedback),
		resolved: true
	};
	if (commands === void 0) return {
		reply: `⚠️ 本部署没有组合命令运行时，\`/${name}\` 无法执行。`,
		resolved: false
	};
	const execute = commands.execute;
	const attachmentsSlot = new Proxy([], { get(target, property, receiver) {
		if (property in target) return Reflect.get(target, property, receiver);
		const member = signal[property];
		return typeof member === "function" ? member.bind(signal) : member;
	} });
	const execution = await execute.call(commands, agent, trimmed, attachmentsSlot, signal);
	if (execution === void 0) return {
		reply: `⚠️ 未知命令 \`/${name}\`。\n\n${helpText(commands, agent, config?.locale ?? "zh", config, feedback)}`,
		resolved: false
	};
	const { result } = execution;
	if (name === "compact" && typeof result.text === "string") {
		if (result.kind === "success") {
			const compacted = /^Compacted (\d+) history items \(~([\d,]+) tokens\)\.$/.exec(result.text);
			if (compacted !== null) {
				const tokens = Number(compacted[2].replace(/,/g, ""));
				return {
					reply: `📦 压缩完成：${compacted[1]} 条较早历史已换成摘要（释放约 ${tokens.toLocaleString("zh-CN")} tokens）。`,
					resolved: true
				};
			}
			if (result.text.startsWith("No compactable history")) return {
				reply: "📦 现在没有可压缩的历史（还没积累到可压缩的量，或刚好没有合适的切点）。",
				resolved: true
			};
		} else if (result.text.includes("not idle") || result.text.includes("already has an active")) return {
			reply: "⏳ 现在压不了：会话正在跑任务，或已有一次压缩在进行。等它空闲后再发 `/compact`。",
			resolved: true
		};
		else if (result.text.includes("cancelled")) return {
			reply: "⏹ 压缩已取消。",
			resolved: true
		};
	}
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
async function runSessionsCommand(agent, persistence, chatId, query = "", sessionQuery = void 0, limits = DEFAULT_LIMITS) {
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
		})).items.filter((hit) => hit.header.id.startsWith(`${SESSION_PREFIX$1}${chatId}`));
		if (owned.length === 0) return {
			reply: `**会话检索**\n没有找到与「${query}」匹配的本聊天记录。`,
			resolved: true
		};
		const rows = owned.map((hit) => {
			const when = hit.header.createdAt === void 0 ? "" : `${new Date(hit.header.createdAt).toLocaleString("zh-CN", { hour12: false })} `;
			const mark = hit.header.id === agent.session.id ? " ← 当前" : "";
			const wide = limits.searchSnippetChars;
			return `· ${when}${mark}「${hit.bestMatch.snippet.length <= wide ? hit.bestMatch.snippet : `${hit.bestMatch.snippet.slice(0, wide - 1)}…`}」`;
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
	const owned = (await persistence.list()).filter((header) => header.header.id.startsWith(`${SESSION_PREFIX$1}${chatId}`)).sort((a, b) => b.header.createdAt - a.header.createdAt);
	if (owned.length === 0) return {
		reply: "**会话历史**\n还没有本聊天的已保存会话。",
		resolved: true
	};
	const shownHeaders = owned.slice(0, SESSION_ROWS_MAX);
	const rows = shownHeaders.map((header) => {
		const when = new Date(header.header.createdAt).toLocaleString("zh-CN", { hour12: false });
		const mark = header.header.id === agent.session.id ? " ← 当前" : "";
		const facet = header.header.id.slice(`${SESSION_PREFIX$1}${chatId}`.length).replace(/^:/, "");
		const label = facet === "" ? "" : facet === header.header.id ? "其他" : /^r[0-9a-z]+$/.test(facet) ? "新会话" : facet;
		return `· ${when}${mark}${label === "" ? "" : `（${label}）`}`;
	});
	const more = owned.length > shownHeaders.length ? `\n…还有 ${owned.length - shownHeaders.length} 个更早的未列出（只显示最近 ${SESSION_ROWS_MAX} 个）。` : "";
	return {
		reply: `**会话历史**（${owned.length} 个）\n${rows.join("\n")}${more}\n\n发消息即继续最近的会话；\`/new\` 开新会话。`,
		resolved: true
	};
}
/**
* Handle `/session`: everything about the session this chat is talking to.
*
* Each block answers a question that otherwise costs several commands to
* settle: which session (identity), what answers here (route), how big it has
* grown (size), and where new work would land (location). The route comes from
* the session's own recorded request header, not the deployment config —
* those differ the moment `/model` or `/think` is used, and reporting the
* config would describe a request that was never sent.
* @param agent - the chat's live agent.
* @param tokenMeter - the token-meter service, when composed.
* @param config - the bridge's resolved configuration, when available.
* @param extras - seams reached on demand (route header, cwd binding).
* @returns the reply for the chat.
*/
function runSessionCommand(agent, tokenMeter, config, extras) {
	const { session } = agent;
	const rows = [`**当前会话**`, `· ID：\`${session.id}\``];
	const cwd = extras?.sessionCwd ?? config?.cwd;
	if (cwd !== void 0 && cwd !== "") rows.push(`· 目录：\`${cwd}\`${extras?.sessionCwdBound === true ? "（本聊天已绑定）" : ""}`);
	let route;
	try {
		const header = session.requestHeader?.();
		if (header !== void 0) route = `${header.config.provider}/${header.config.model}`;
		if (header?.config.reasoningEffort !== void 0) route = `${route}（思考强度 ${header.config.reasoningEffort}）`;
	} catch {}
	if (route === void 0 && config?.model !== void 0) route = `${config.provider ?? "默认"}/${config.model}（配置默认，尚未发出请求）`;
	if (route !== void 0) rows.push(`· 模型：${route}`);
	rows.push(`· 日志事件：${session.seq} 条`);
	if (tokenMeter !== void 0) try {
		const measure = tokenMeter.measure(session);
		const total = measure.totalTokens;
		const surface = measure.surfaceTokens;
		const overhead = Math.max(0, total - surface);
		rows.push(`· 上下文：约 ${total.toLocaleString("en-US")} tokens（闲聊内容 ${surface.toLocaleString("en-US")} + 固定开销 ${overhead.toLocaleString("en-US")}）`);
		const threshold = config?.tokenPressure.threshold;
		if (threshold !== void 0 && threshold > 0) {
			const percent = Math.round(total / threshold * 100);
			rows.push(`· 距提醒线：${percent}%（${threshold.toLocaleString("en-US")} tokens）`);
		}
	} catch {
		rows.push("· 上下文：（token 计量失败，先看 `/context`）");
	}
	rows.push(`· 状态：${agent.status === "running" ? "运行中" : "空闲"}`);
	if (config !== void 0) {
		const preset = extras?.sessionPreset ?? config.preset;
		if (preset !== void 0) rows.push(`· 模式：${preset}`);
		rows.push(`· 忙时策略：${BUSY_POLICY_LABELS[config.busyPolicy]}`);
	}
	return {
		reply: rows.join("\n"),
		resolved: true
	};
}
/** How `/config` names each `busyPolicy`, for a reader who does not know the enum. */
const BUSY_POLICY_LABELS = {
	queue: "排队（queue）",
	steer: "中途插话（steer）",
	inject: "上下文注入（inject）"
};
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
			`· 忙时策略：${BUSY_POLICY_LABELS[config.busyPolicy]}`,
			`· 会话维度：${config.sessionScope}`,
			`· 显示过程：${on(config.showProcess)}${config.hideProcessWhenDone ? "（完成后隐藏）" : ""}`,
			`· 消息时间戳：${on(config.showMessageTime)}（给模型看当前时间与间隔）`,
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
	const snapshots = jobs.list(agent.session.id);
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
async function runSkillsCommand(line, skills, limits = DEFAULT_LIMITS) {
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
		const body = skill.content.trim();
		return {
			reply: `**Skill · ${query}**\n\n${body.length > limits.skillPreviewChars ? `${body.slice(0, limits.skillPreviewChars)}\n…（截断）` : body}`,
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
* The comparison key two directory strings must share to mean the same place.
*
* A workspace record stores the canonical (realpath) path; a chat binding
* stores whatever the operator typed. `D:\Desktop\x`, `d:\desktop\x\` and
* `D:\DESKTO~1\x` all name one directory, and plain string equality calls them
* three. Normalising (absolute → platform case rules → no trailing separator)
* is what makes them meet.
*
* The key is then hashed rather than returned raw: literal directory paths are
* exactly what this repository's private-value form (`{{SECRET_…}}`, filled at
* build time) exists to keep out of committed output, and a build that inlines
* a comparison path would leak the operator's layout. The digest of a
* normalised path is all the comparison needs.
* @param dir - a directory string from the registry or from a chat binding.
* @returns an opaque key that is equal for two spellings of one directory.
*/
function workspaceKey(dir) {
	const normal = resolve(dir);
	const folded = process.platform === "win32" || process.platform === "darwin" ? normal.toLowerCase() : normal;
	return createHash("sha256").update(folded).digest("hex");
}
/**
* Handle `/ws`: list the registry's workspaces with the chat's current
* workspace marked. Read-only — unlike the PC UI there is nothing to switch
* here; the listing shows what exists and where new chats land. The registry
* is optional: a deployment without it (no workspace plugin composed) gets a
* clear refusal instead of a fake answer.
*
* `currentCwd` is the directory this chat's next session will start in — the
* chat's own binding when it has one, else the deployment cwd — NOT the
* deployment cwd alone. The two differ whenever `/ws use <dir>` ran: `/new`
* lands in the binding, so marking the deployment cwd as 「当前」 told the chat
* a directory it had left, and the closing line sent readers to edit
* cordis.patch.yml for a directory a binding would override anyway.
*
* The comparison is against the workspace record's canonical (realpath) path,
* so a binding written with different letter case, 8.3 short form, a junction
* or a trailing fence must still match. JS string equality misses all of
* those; hashing the canonical key is what catches them, and it keeps the
* comparison in this project's private `{{SECRET_…}}` form — no literal
* directory name survives in the bundle.
* @param workspaces - the host workspace-registry service, when composed.
* @param currentCwd - the directory this chat's next session starts in.
* @param bound - true when `currentCwd` came from the chat's own binding.
* @returns the reply for the chat.
*/
function runWsCommand(workspaces, currentCwd, bound = false) {
	if (workspaces?.list === void 0) return {
		reply: `⚠️ 本部署没有组合 workspace 插件，\`/ws\` 不可用。`,
		resolved: false
	};
	const wanted = currentCwd === void 0 ? void 0 : workspaceKey(currentCwd);
	const all = workspaces.list();
	const shown = all.slice(0, WS_ROWS_MAX);
	const rows = shown.map((w) => {
		const mark = wanted !== void 0 && workspaceKey(w.path) === wanted ? " ← 当前" : "";
		const title = w.id === w.path || !w.id ? "" : `（${w.id}）`;
		return `· \`${w.path}\`${title}${mark}`;
	});
	if (rows.length === 0) return {
		reply: `**工作区**：注册表为空。新会话将使用${bound ? "本群绑定的目录" : "部署目录"}${currentCwd === void 0 ? "" : ` \`${currentCwd}\``}（首次使用时自动注册）。`,
		resolved: true
	};
	const tail = currentCwd === void 0 ? "" : `\n\n新会话工作目录：\`${currentCwd}\`（${bound ? "由本群绑定 /ws use 决定" : "由部署配置 cwd 决定；改目录请编辑 cordis.patch.yml 后重启"}）。`;
	const more = all.length > shown.length ? `\n…还有 ${all.length - shown.length} 个未列出（\`/ws\` 只显示前 ${WS_ROWS_MAX} 个）。` : "";
	return {
		reply: `**已注册的工作区**（${all.length} 个）\n${rows.join("\n")}${more}${tail}`,
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
		const effort = cur.reasoningEffort === void 0 ? "" : `（推理强度 ${cur.reasoningEffort}）`;
		if (catalog && catalog.length > 0) return {
			reply: `**可选模型**（当前：${current}${effort}）\n${catalog.map((m, i) => {
				const mark = m === cur.model || `${cur.provider}/${m}` === current ? " ← 当前" : "";
				return `${i + 1}. ${m}${mark}`;
			}).join("\n")}\n\n切换：\`/${MODEL_COMMAND} <编号>\`（例如 \`/${MODEL_COMMAND} 1\`）`,
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
			...defaultModel.currentSelection(),
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
			...defaultModel.currentSelection(),
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
* Handle `/context`: show the session's current context token pressure, and
* where that pressure sits.
*
* The three-way split comes from the host's `contextBreakdown` projection,
* read through `sessionProjections`. It is optional on purpose: a host without
* the projection still answers with the total and the message portion, which
* is enough to decide "compress", just not enough to say what compressing
* would actually buy.
* @param agent - the chat's agent (owns the measured session).
* @param tokenMeter - the token-meter service, when composed.
* @param ctx - the bridge's context, used to reach the projection service.
* @returns the reply for the chat.
*/
function runContextCommand(agent, tokenMeter, ctx) {
	if (tokenMeter === void 0) return {
		reply: `⚠️ 本部署没有组合 token 计量服务，\`/${CONTEXT_COMMAND}\` 不可用。`,
		resolved: false
	};
	const measure = tokenMeter.measure(agent.session);
	let breakdown;
	try {
		const state = (ctx?.get("sessionProjections"))?.stateOf?.(agent.session, "contextBreakdown");
		if (state?.breakdown !== void 0 && state.breakdown.toolsTokens > 0) breakdown = state.breakdown;
	} catch {}
	return {
		reply: contextPressureLine({
			total: measure.totalTokens,
			surface: measure.surfaceTokens,
			breakdown
		}),
		resolved: true
	};
}
function runSchedulesCommand(agent, schedules, limits = DEFAULT_LIMITS) {
	const promptChars = limits.schedulePromptChars;
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
		return `· [${entry.kind === "after" ? "延时" : entry.kind === "at" ? "定点" : `周期(${entry.everySeconds ?? "?"}s)`}] ${entry.prompt.length > promptChars ? `${entry.prompt.slice(0, limits.schedulePromptChars)}…` : entry.prompt}`;
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
/**
* The tools visible in a scope, as the reader sees them.
*
* The seam is optional: a deployment that does not compose the listing
* shows the deny list alone, which is still an answer. A host that throws
* while enumerating is another deployment's problem, and the reader should
* not lose the deny list over it.
* @param tools - the tools service, when the deployment composes one.
* @param scope - the viewing scope; omitted views the global layer.
* @returns the visible tools, or undefined when the seam is absent.
*/
function toolInventory(tools, scope) {
	if (tools === void 0 || typeof tools.schemas !== "function") return void 0;
	try {
		const listed = tools.schemas(scope);
		if (!Array.isArray(listed)) return void 0;
		return listed.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.name === "string").map((entry) => ({
			name: entry.name,
			...typeof entry.description === "string" ? { description: entry.description } : {}
		}));
	} catch {
		return;
	}
}
/**
* The MCP servers a tool list shows, read off the host's namespace.
*
* The host registers an MCP server's tools as `mcp__<server>__<tool>`, so
* the servers are already in the names — no separate registry to ask for.
* @param tools - the visible tools, or undefined when the seam is absent.
* @returns the server names, sorted, without duplicates.
*/
function mcpServerNames(tools) {
	if (tools === void 0) return [];
	const servers = /* @__PURE__ */ new Set();
	for (const tool of tools) {
		const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(tool.name);
		if (match !== null) servers.add(match[1]);
	}
	return [...servers].sort();
}
function runToolsCommand(line, deniedTools, tools = void 0, toolScope = void 0) {
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
	const deniedBody = listed.length === 0 ? "当前没有禁用的工具。" : `当前禁用（${listed.length}）：\n${listed.map((t) => `· \`${t}\``).join("\n")}`;
	const inventory = toolInventory(tools, toolScope);
	const available = inventory === void 0 ? void 0 : inventory.filter((t) => !deniedTools.has(t.name));
	const availableBody = available === void 0 ? "" : available.length === 0 ? "\n当前作用域里没有可用的工具。" : `\n可用（${available.length}）：\n${available.map((t) => `· \`${t.name}\`${t.description === void 0 || t.description === "" ? "" : ` — ${t.description}`}`).join("\n")}`;
	const mcpServers = mcpServerNames(available);
	return {
		reply: `**工具开关**\n${deniedBody}${availableBody}${mcpServers.length === 0 ? "" : `\nMCP 服务器（${mcpServers.length}）：${mcpServers.map((s) => `\`${s}\``).join("、")}`}\n\n用法：\`/${TOOLS_COMMAND} deny <name>\` 禁用、\`/${TOOLS_COMMAND} allow <name>\` 恢复。`,
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
	const available = await presets.list().catch(() => []);
	const knownIds = available.length > 0 ? available.map((p) => p.id) : [...SHIPPED_PRESET_IDS];
	if (!knownIds.includes(wanted)) return {
		reply: `⚠️ 未知模式 \`${wanted}\`。可用：${knownIds.join("、")}。`,
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
/**
* The kind a file is delivered in, read from its extension.
*
* Only the containers the transport can actually carry in kind count as audio
* or video: it declares every such upload as an `opus` or `mp4` container and
* reads the duration out of an Ogg or MP4 stream, refusing the send when it
* finds neither. An mp3 named as a voice note therefore fails at upload, while
* a file attachment always arrives — so everything outside those two containers
* is a file. The extension is the only signal the model does not have to be
* taught, and an unknown one reads as a file, the shape that always works.
* @param fileName - the file's name.
* @returns the kind to deliver it in.
*/
function sendFileKindFor(fileName) {
	const ext = extensionOf(fileName);
	if (AUDIO_EXTENSIONS.has(ext)) return "audio";
	if (VIDEO_EXTENSIONS.has(ext)) return "video";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	return "file";
}
/** A name's lowercased extension, without the dot. */
function extensionOf(fileName) {
	return fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
}
/** Extensions delivered as a voice note: Ogg containers, the only ones it can time. */
const AUDIO_EXTENSIONS = /* @__PURE__ */ new Set(["ogg", "opus"]);
/** Extensions delivered as a video: MP4 containers, the only ones it can time. */
const VIDEO_EXTENSIONS = /* @__PURE__ */ new Set(["mp4", "m4v"]);
/** Extensions delivered as an image; image upload needs no duration. */
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp"
]);
/**
* Extensions that name a recording whose container the transport cannot carry.
* They arrive as files, and the caller is told so: a send that would have failed
* at upload must not look like a voice note that went out.
*/
const AUDIO_SHAPED_EXTENSIONS = /* @__PURE__ */ new Set([
	"mp3",
	"wav",
	"m4a",
	"aac",
	"flac",
	"amr"
]);
/** Extensions that name a clip whose container the transport cannot carry. */
const VIDEO_SHAPED_EXTENSIONS = /* @__PURE__ */ new Set([
	"mov",
	"mkv",
	"webm",
	"avi"
]);
/** Model-facing content renderer for the tool's canonical result. */
function renderSendFileResult(args, value) {
	if (value.ok && value.fileName !== void 0) {
		const sent = `已发送文件 \`${value.fileName}\` 到当前聊天。`;
		return [{
			type: "text",
			text: value.note === void 0 ? sent : `${sent}${value.note}`
		}];
	}
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
		description: "Send one file from the workspace as an attachment in the current chat. Use it to deliver finished artifacts to the human: HTML reports, PDFs, spreadsheets, images, logs. The human can open or download the file directly from the chat. Pass an absolute path, or a path relative to the workspace root. A recording or a clip plays in place only in a container the chat can carry — ogg or opus for a voice note, mp4 or m4v for a video. Every other media format (mp3, wav, m4a, aac, flac, amr, mov, mkv, webm, avi) arrives as a file attachment, and the result says when that happened.",
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
				},
				kind: {
					type: "string",
					enum: [
						"file",
						"image",
						"audio",
						"video"
					],
					description: "How to deliver it. Omit it and the extension decides: an ogg or opus recording arrives as a voice note, an mp4 or m4v clip as a video, an image as an image, everything else as a file. Naming a kind can narrow the shape (ask for a file or an image) but cannot widen it: a format the chat cannot carry in kind always arrives as a file, and the result says so."
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
					note: { type: "string" },
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
				const delivered = await capability.deliverBySession(sessionId, parsed);
				return delivered.note === void 0 ? {
					ok: true,
					fileName: delivered.fileName
				} : {
					ok: true,
					fileName: delivered.fileName,
					note: delivered.note
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
/** Model-facing name of each shape that needs a container. */
const MEDIA_LABEL = {
	audio: "语音",
	video: "视频"
};
/** The one container per shape the transport can carry. */
const MEDIA_CONTAINERS = {
	audio: "ogg/opus",
	video: "mp4/m4v"
};
/** How long a probe may take before the file is delivered as a plain attachment. */
const FFPROBE_TIMEOUT_MS = 8e3;
const execFileAsync = promisify(execFile);
/**
* Measure one file's duration in milliseconds, without making `ffprobe` a
* dependency: the transport times an Ogg or MP4 container itself, so a machine
* without the tool still sends those two in kind. What it cannot do is time a
* payload its parser trips over, which is why a failed measurement is reported
* rather than guessed.
* @param path - the file to measure.
* @returns the duration, or why there is none.
*/
async function probeDurationMs(path) {
	try {
		const { stdout } = await execFileAsync("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"csv=p=0",
			path
		], { timeout: FFPROBE_TIMEOUT_MS });
		const seconds = Number.parseFloat(stdout.trim());
		if (!Number.isFinite(seconds) || seconds <= 0) return { state: "failed" };
		return {
			state: "measured",
			ms: Math.round(seconds * 1e3)
		};
	} catch (error) {
		return error.code === "ENOENT" ? { state: "no-tool" } : { state: "failed" };
	}
}
/**
* Decide the shape of one delivery, measuring a duration where the transport
* needs one.
*
* A named kind can narrow the shape (a file always arrives) but never widen it:
* the transport declares a voice note as an `opus` container and a video as
* `mp4`, and rejects the send when it cannot time the payload — so asking for
* audio on an mp3 is a send that would fail, and a file attachment plus a note
* is the honest alternative.
* @param fileName - the delivered file's base name.
* @param asked - the caller's `kind`, when it named one.
* @param path - absolute path, for measuring.
* @param measure - the duration measurement to use.
*/
async function planDelivery(fileName, asked, path, measure) {
	if (asked === "file" || asked === "image") return { kind: asked };
	const deliverable = sendFileKindFor(fileName);
	const wanted = asked ?? claimedMediaKind(fileName) ?? deliverable;
	if (wanted === "file" || wanted === "image") return { kind: wanted };
	if (deliverable !== wanted) return {
		kind: "file",
		note: `${MEDIA_LABEL[wanted]}仅支持 ${MEDIA_CONTAINERS[wanted]} 容器，该文件已作为文件发送。`
	};
	const measured = await measure(path);
	if (measured.state === "failed") return {
		kind: "file",
		note: `读不出该文件的时长，${MEDIA_LABEL[wanted]}无法定时发送，已作为文件发送。`
	};
	return measured.state === "measured" ? {
		kind: wanted,
		duration: measured.ms
	} : { kind: wanted };
}
/** The media shape a name claims, whether or not the transport can carry it. */
function claimedMediaKind(fileName) {
	const ext = extensionOf(fileName);
	if (AUDIO_SHAPED_EXTENSIONS.has(ext)) return "audio";
	if (VIDEO_SHAPED_EXTENSIONS.has(ext)) return "video";
}
/**
* The line the chat gets when a delivery is refused.
*
* The tool result carries the error to the model, and the log carries it to the
* operator — but the person who asked for the file is looking at the chat, and
* without this line they see nothing at all. Silence there reads as "the agent
* forgot", which is the wrong fix to go looking for.
* @param fileName - the file that did not go out.
* @param detail - the transport's own message.
* @returns the notice to send into the chat.
*/
function sendFailureNotice(fileName, detail) {
	return `⚠️ 没有发出去：\`${fileName}\`\n\n${detail}${detail.includes("allowedFileDirs") ? "\n\n本地文件要发出去，得让部署配置里的 `outbound.allowedFileDirs` 包含它所在的目录。" : ""}`;
}
/**
* Deliver a file to a chat through the outbound transport. Resolves with the
* delivered file name, or rejects with a message the tool turns into a result.
*
* The media goes first and the caption second. The other order was a trap: the
* caption is a message of its own (a union `SendInput` cannot carry both), so a
* media send the transport refuses — a path outside `outbound.allowedFileDirs`
* is the usual one — left the chat holding a friendly line about a file that
* never arrived. Sending media first means a failure has nothing to contradict
* it, and the chat gets an explicit notice instead of a dangling caption.
* @param port - the outbound transport (replay-wrapped by the bridge).
* @param chatId - the target chat.
* @param cwd - workspace root, for resolving relative paths.
* @param args - the parsed tool arguments.
* @param measure - duration measurement for a voice note or a video; defaults to `ffprobe`.
*/
async function deliverFile(port, chatId, cwd, args, measure = probeDurationMs) {
	const absolute = resolve(cwd, args.path);
	if (!(await promises.stat(absolute).catch((error) => {
		throw new Error(`文件不存在或不可读：${args.path}（${error instanceof Error ? error.message : String(error)}）`);
	})).isFile()) throw new Error(`不是文件：${args.path}`);
	const fileName = absolute.split(/[\\/]/).pop() ?? "file";
	const caption = args.caption;
	const delivery = await planDelivery(fileName, args.kind, absolute, measure);
	const duration = delivery.duration;
	try {
		if (delivery.kind === "image") await port.send(chatId, { image: { source: absolute } });
		else if (delivery.kind === "audio") await port.send(chatId, duration === void 0 ? { audio: { source: absolute } } : { audio: {
			source: absolute,
			duration
		} });
		else if (delivery.kind === "video") await port.send(chatId, duration === void 0 ? { video: { source: absolute } } : { video: {
			source: absolute,
			duration
		} });
		else await port.send(chatId, { file: {
			source: absolute,
			fileName
		} });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		await port.send(chatId, { markdown: sendFailureNotice(fileName, detail) }).catch(() => void 0);
		throw new Error(`发送失败：${fileName}（${detail}）`);
	}
	if (caption !== void 0 && caption !== "") await port.send(chatId, { markdown: caption }).catch(() => void 0);
	return delivery.note === void 0 ? { fileName } : {
		fileName,
		note: delivery.note
	};
}
/** Inbound resource kinds the bridge persists, with their note flavour. */
const INBOUND_KINDS = {
	file: {
		label: "文件",
		icon: "📎"
	},
	audio: {
		label: "语音",
		icon: "🎤"
	},
	video: {
		label: "视频",
		icon: "🎬"
	},
	sticker: {
		label: "贴纸",
		icon: "🏷️"
	}
};
/**
* Whether a path is already taken.
*
* The synchronous form of this question blocks the event loop for the length of
* a `stat`, which on a Windows-bridged workspace is a round trip to the host —
* and this is asked on the inbound message path. Any error answers "not taken",
* the same reading the synchronous form gave.
* @param path - the candidate destination.
*/
async function pathTaken(path) {
	try {
		await promises.access(path);
		return true;
	} catch {
		return false;
	}
}
/**
* Names this process has already handed out, so two arrivals that carry the
* same file name cannot both be told "that one is free".
*
* The check on disk and the write that follows are separated by an await —
* the write is asynchronous on purpose, so the event loop runs other work in
* between. Two messages carrying the same name therefore both see the file
* as absent and both write to it, and the second one overwrites the first.
* Remembering the name here closes that window: the second arrival is told
* to use the next one.
*/
const handedOut = /* @__PURE__ */ new Set();
/** A destination that does not overwrite an earlier arrival with the same name. */
async function uniqueDest(base) {
	const claim = async (candidate) => {
		if (handedOut.has(candidate)) return false;
		handedOut.add(candidate);
		if (await pathTaken(candidate)) {
			handedOut.delete(candidate);
			return false;
		}
		return true;
	};
	if (await claim(base)) return base;
	const dot = base.lastIndexOf(".");
	const cut = dot > base.lastIndexOf("/") ? dot : base.length;
	const stem = base.slice(0, cut);
	const ext = base.slice(cut);
	for (let n = 2;; n += 1) {
		const candidate = `${stem}-${n}${ext}`;
		if (await claim(candidate)) return candidate;
	}
}
/**
* Download and save non-image resources from one chat message into the agent's
* workspace so the agent can read them with its own tools. Audio, video and
* stickers ride the same download path (`type: 'file'` — the SDK fetches any
* non-image resource by key); before this they were dropped silently and the
* model only ever saw a placeholder tag.
*/
async function saveInboundFiles(msg, download, workDir) {
	const files = msg.resources.filter((r) => Object.hasOwn(INBOUND_KINDS, r.type));
	if (files.length === 0) return {
		notes: [],
		paths: []
	};
	const notes = [];
	const paths = [];
	for (const file of files) {
		const flavour = INBOUND_KINDS[file.type];
		const cleaned = (file.fileName || `${file.type}_${file.fileKey.slice(0, 12)}`).replace(/[/\\]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "_");
		try {
			const dest = await uniqueDest(join(workDir, cleaned));
			const { buffer } = await download(msg.messageId, file.fileKey, "file");
			await promises.writeFile(dest, buffer);
			paths.push(dest);
			const savedName = dest.split(/[/\\]/).pop() ?? cleaned;
			notes.push(`${flavour.icon} 用户发送了${flavour.label}「${savedName}」，已保存到工作区`);
		} catch (e) {
			notes.push(`${flavour.icon} ${flavour.label} ${cleaned} 保存失败：${String(e).slice(0, 80)}`);
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
//#region lib/types/session-rotation.js
/**
* Session rotations: `/new` moves a conversation to a fresh session while the
* previous one stays stored. The mapping must survive a restart, so the store
* keeps `conversationKey → current session id` in the harness home; a
* conversation with no recorded rotation resolves to its original, derived id.
* @module dsh-lark-bridge/session-rotation
*/
/**
* The harness home the rotation file lives in: `DSH_HOME` when set, else
* `~/.dsh`. Local on purpose — a rotation names an id on this machine.
* @param home - override for tests.
* @returns the directory path (not created here).
*/
function rotationHome(home) {
	return home ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? homedir(), ".dsh");
}
/**
* Path of the rotation file.
* @param home - override for tests.
* @returns the file path.
*/
function rotationPath(home) {
	return path.join(rotationHome(home), "session-rotation.json");
}
/**
* The next rotated session id for one conversation: the derived id plus a
* sortable stamp and a random tail, so every rotation is a fresh id (two
* /new in the same millisecond must not collide) and the original stays
* addressable for history lookups.
* @param baseSessionId - the conversation's derived id (from `sessionIdFor`).
* @param now - clock override for tests.
* @param suffix - randomness override for tests.
* @returns the new session id.
*/
function rotatedSessionId(baseSessionId, now = Date.now(), suffix = randomUUID().replaceAll("-", "").slice(0, 4)) {
	return `${baseSessionId}:r${now.toString(36)}${suffix}`;
}
/** The stamp-plus-tail a rotation appends, so {@link baseSessionIdOf} can strip it. */
const ROTATION_SUFFIX = /:r[0-9a-z]+$/;
/**
* The conversation id a session id was derived from: the inverse of
* {@link rotatedSessionId} for the ids it produces, and the identity for every
* other id.
*
* `/new` creates the rotated id, but anything keyed by the conversation — the
* per-chat cwd binding, for one — was registered under the BASE id before the
* rotation. Callers that only ever see the session id need this to find it.
* @param sessionId - any session id.
* @returns the base id, or the input when it carries no rotation suffix.
*/
function baseSessionIdOf(sessionId) {
	const suffix = ROTATION_SUFFIX.exec(sessionId)?.[0];
	return suffix === void 0 ? sessionId : sessionId.slice(0, -suffix.length);
}
/**
* A JSON-backed {@link RotationStore}, cached in memory. A missing or
* unparsable file reads as "no rotations"; writes go through a rename so a
* crash mid-write cannot truncate the map.
* @param home - override for tests.
* @returns the store.
*/
function createRotationStore(home) {
	const file = rotationPath(home);
	let map;
	const load = () => {
		if (map !== void 0) return map;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			map = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
		} catch {
			map = {};
		}
		return map;
	};
	return {
		current(key) {
			const id = load()[key];
			return typeof id === "string" && id !== "" ? id : void 0;
		},
		record(key, sessionId) {
			const next = {
				...load(),
				[key]: sessionId
			};
			map = next;
			try {
				mkdirSync(path.dirname(file), { recursive: true });
				const tmp = `${file}.tmp`;
				writeFileSync(tmp, JSON.stringify(next), "utf8");
				renameSync(tmp, file);
				return true;
			} catch {
				return false;
			}
		}
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
* Error names the host's session-persistence seam gives a stored session that
* is THERE but cannot be opened. Matched by name, never by import: this
* package builds without the host's persistence packages (the same reason
* `host.ts` keeps structural copies), so `instanceof` is unavailable — while
* `name` is a string literal each host class sets in its constructor, which
* survives bundling and realm boundaries alike.
*/
const CORRUPT_LOG_NAME = "SessionPersistenceCorruptionError";
const UNREADABLE_FORMAT_NAME = "SessionFormatUnsupportedError";
const SESSION_EXISTS_NAME = "SessionAlreadyExistsError";
const SESSION_ABSENT_NAME = "SessionPersistenceNotFoundError";
/**
* Message fragments that name those same refusals for a rejection whose class
* was lost on the way up. Each is phrasing only these refusals produce.
*/
const CORRUPT_LOG_PHRASES = [
	"stored log is corrupt",
	"corrupt session log",
	"failed validation:"
];
const UNREADABLE_FORMAT_PHRASES = [
	"unknown to this harness",
	"upgrade the harness",
	"log format v"
];
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
	const seen = /* @__PURE__ */ new Set();
	const queue = [error];
	while (queue.length > 0 && seen.size < 8) {
		const current = queue.shift();
		if (current === void 0 || current === null || seen.has(current)) continue;
		seen.add(current);
		if (typeof current === "string") messages.push(current);
		else if (current instanceof Error) {
			names.push(current.name);
			messages.push(current.message);
			const { cause, errors } = current;
			if (cause !== void 0 && cause !== null) queue.push(cause);
			if (Array.isArray(errors)) queue.push(...errors);
		}
	}
	return {
		names,
		messages
	};
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
	const text = messages.join("\n");
	if (names.includes(CORRUPT_LOG_NAME) || CORRUPT_LOG_PHRASES.some((phrase) => text.includes(phrase))) return "corrupt";
	if (names.includes(UNREADABLE_FORMAT_NAME) || UNREADABLE_FORMAT_PHRASES.some((phrase) => text.includes(phrase))) return "format";
}
/**
* Whether one rejection is the host's "no stored session under this id".
* @param error - the rejection value.
* @returns true when nothing is stored there.
*/
function isAbsentSession(error) {
	const { names, messages } = errorChain(error);
	return names.includes(SESSION_ABSENT_NAME) || messages.some((message) => message.endsWith("not found"));
}
/**
* Whether one rejection is the host's "this id is taken".
* @param error - the rejection value.
* @returns true when a stored session already owns the id.
*/
function isExistingSession(error) {
	const { names, messages } = errorChain(error);
	return names.includes(SESSION_EXISTS_NAME) || messages.some((message) => message.includes("already exists"));
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
	const line = /line (\d+)/.exec(messages.join(" "))?.[1];
	let detail = (messages.at(-1) ?? "").replace(/\(raw log: [^)]*\)/g, "").replace(/^session "[^"]*"[:：]?\s*/, "").replace(/^corrupt session log:\s*/, "").replace(/^stored (session|log)[^:]*:\s*/, "").trim();
	if (line !== void 0) detail = detail.replace(new RegExp(`^.*?line ${line}[:：]\\s*`), "");
	if (detail.length > 180) detail = `${detail.slice(0, 179)}…`;
	return `${failure === "corrupt" ? "会话存档损坏" : failure === "format" ? "会话存档是当前版本读不了的格式，可能由更新版本的 harness 写成" : "会话存档存在但打不开"}${detail === "" ? "" : `（${line === void 0 ? "" : `第 ${line} 行：`}${detail}）`}。旧存档原样保留、没动过；下一条消息会自动开一个新会话，请把刚才的话再发一次。`;
}
/**
* Persist one resume rejection where an operator can still read it after the
* chat has forgotten it. Diagnostics must never mask the original failure.
* @param key - the conversation key whose session failed to resume.
* @param error - the rejection value.
*/
function recordResumeFailure(key, error) {
	try {
		appendFileSync("/tmp/dsh-session-crash.log", `[${(/* @__PURE__ */ new Date()).toISOString()}] resume ${key}\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n`);
	} catch {}
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
*
* A conversation whose stored session exists but cannot be opened is moved to
* a fresh session instead of being left unreachable — see {@link reach}.
*/
var ConversationSessions = class {
	scope;
	ladder;
	rotation;
	/** Resolved sessions by conversation key. */
	opened = /* @__PURE__ */ new Map();
	/** Conversation key per live session id, in binding order. */
	keys = /* @__PURE__ */ new Map();
	/** Acquisitions still walking the ladder, joined by concurrent messages. */
	opening = /* @__PURE__ */ new Map();
	/**
	* Conversation key → the session id it moved to, for a rotation record that
	* never reached disk. This is what keeps a move a move after a failed write.
	*/
	revived = /* @__PURE__ */ new Map();
	closed = false;
	/**
	* @param scope - the conversation facet every session is keyed by.
	* @param ladder - the host operations to walk.
	*/
	/** Rotations in flight, per conversation: a message landing mid-rotate
	* must wait for it, or it would bind the session being disposed. */
	rotating = /* @__PURE__ */ new Map();
	constructor(scope, ladder, rotation) {
		this.scope = scope;
		this.ladder = ladder;
		this.rotation = rotation;
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
		if (this.closed) throw new Error("dsh-lark-bridge: sessions are closed");
		const key = conversationKey(this.scope, msg);
		const inFlight = this.rotating.get(key);
		if (inFlight !== void 0) await inFlight.catch(() => {});
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
		if (this.closed) throw new Error("dsh-lark-bridge: sessions are closed");
		const key = conversationKey(this.scope, msg);
		if (this.rotating.has(key)) throw new Error("上一次开新会话还在进行中，稍等片刻再发 /new。");
		const task = this.performRotate(key);
		this.rotating.set(key, task);
		try {
			return await task;
		} finally {
			this.rotating.delete(key);
		}
	}
	/**
	* The body of {@link rotate}, serialized per conversation by its caller.
	* @param key - the conversation key to rotate.
	* @returns the fresh session plus whether the mapping reached disk.
	*/
	async performRotate(key) {
		if (this.closed) throw new Error("dsh-lark-bridge: sessions are closed");
		const newId = rotatedSessionId(sessionIdFor(key));
		const handle = await this.ladder.create(newId);
		if (this.closed) {
			await handle.dispose().catch((error) => {
				this.ladder.report(`dsh-lark-bridge: disposing the late rotation for ${key} failed: ${failureDetail(error)}`);
			});
			throw new Error(`dsh-lark-bridge: sessions closed while rotating ${key}`);
		}
		const persisted = this.rebind(key, newId);
		const previous = this.opened.get(key);
		if (previous !== void 0) {
			this.opened.delete(key);
			this.keys.delete(previous.handle.agent.session.id);
			if (previous.owned) await previous.handle.dispose().catch((error) => {
				this.ladder.report(`dsh-lark-bridge: disposing the pre-rotation session for ${key} failed: ${failureDetail(error)}`);
			});
		}
		const opened = {
			handle,
			owned: true
		};
		this.opened.set(key, opened);
		this.keys.set(handle.agent.session.id, key);
		return {
			...opened,
			persisted
		};
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
		const current = this.opened.get(key);
		if (current !== void 0) {
			if (opened.owned) await opened.handle.dispose().catch((error) => {
				this.ladder.report(`dsh-lark-bridge: disposing the superseded session for ${key} failed: ${failureDetail(error)}`);
			});
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
		this.ladder.report(`dsh-lark-bridge: session ${sessionId} cannot be opened (${failure}); conversation ${key} moves to ${fresh}${persisted ? "" : " — rotation not recorded, so a restart falls back to the unreadable id"}: ${failureDetail(error)}`);
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
		const sessionId = this.currentSessionId(key);
		const live = this.ladder.lookup(sessionId);
		if (live !== void 0) return {
			handle: live,
			owned: false
		};
		let resumeError;
		try {
			return {
				handle: await this.ladder.resume(sessionId),
				owned: true
			};
		} catch (error) {
			resumeError = error;
			recordResumeFailure(key, error);
			const failure = classifyArchive(error);
			if (failure !== void 0) throw this.quarantine(key, sessionId, failure, error);
			this.ladder.report(`dsh-lark-bridge: resuming session for ${key} failed, starting a new one: ${failureDetail(error)}`);
		}
		try {
			return {
				handle: await this.ladder.create(sessionId),
				owned: true
			};
		} catch (error) {
			if (!isExistingSession(error)) throw error;
			if (isAbsentSession(resumeError)) {
				const retried = await this.ladder.resume(sessionId).then((handle) => ({ handle }), (retryError) => ({ retryError }));
				if ("handle" in retried) return {
					handle: retried.handle,
					owned: true
				};
				resumeError = retried.retryError;
				recordResumeFailure(key, resumeError);
			}
			throw this.quarantine(key, sessionId, classifyArchive(resumeError) ?? "unreadable", resumeError);
		}
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
		return { toast: {
			type: "success",
			content: "回答已提交"
		} };
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
		"- `/help` 查看全部命令 · `/manual` 完整使用说明",
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
* @param identity - optional leading clause naming the bot as Feishu names it
*   (e.g. `「MyBot」（本端：web · web）`), so the very first line answers
*   "who — and which endpoint of it — am I talking to".
* @returns the markdown message to send into the chat.
*/
function onboardingText(posture, identity) {
	return [
		identity === void 0 ? "**你好，我是跑在飞书里的编码智能体（DeepSeek Harness）。**" : `**你好，我是飞书上的${identity}，一个跑在 DeepSeek Harness 里的编码智能体。**`,
		"",
		"直接说你要做的事，我会调用工具（终端/文件/搜索等）去完成。",
		"",
		`权限：${postureLine(posture)}`,
		"",
		commandGuide(posture),
		"",
		pricingHumanLine(),
		"",
		"开始吧——发一句话试试。"
	].join("\n");
}
/** The first-contact message, as a plain object for `port.send({ markdown })`. */
function onboardingMessage(env = process.env, identity) {
	return { markdown: onboardingText(permissionPosture(env), identity) };
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
//#region lib/types/feishu-tools.js
/**
* Native Feishu capabilities as agent-callable tools.
*
* The bridge already renders the agent TO the human; this module lets the
* agent act on Feishu itself — proactive messages into the current (or any
* known) chat, and the app's own cloud-drive space as a durable scratchpad.
* Both ride capabilities the channel already owns: outbound transport for
* messages, the FeishuCloud client (built for fleet arbitration/migration)
* for the drive. Tools follow the `send_file` factory pattern: plain
* definition objects, the outcome in the result, never a throw across the
* tool boundary.
* @module dsh-lark-bridge/feishu-tools
*/
/** Tool names, exported for tests and deny-list references. */
const FEISHU_NOTIFY_TOOL = "feishu_notify";
const FEISHU_DRIVE_WRITE_TOOL = "feishu_drive_write";
const FEISHU_DRIVE_READ_TOOL = "feishu_drive_read";
const FEISHU_DRIVE_LIST_TOOL = "feishu_drive_list";
const BIND_WORKSPACE_TOOL = "bind_workspace";
const asText = (value) => typeof value === "string" ? value : "";
/**
* The four definitions. `exec.agent.session.id` names the chat for
* `feishu_notify` the same way `send_file` resolves its delivery target.
*/
function createFeishuTools(deps) {
	const resolveChat = (exec, explicit) => {
		if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
		const sessionId = exec.agent?.session?.id;
		return sessionId === void 0 ? void 0 : deps.chatOfSession(sessionId);
	};
	const cloud = () => {
		if (deps.credentials === void 0) return void 0;
		return new FeishuCloud(deps.credentials, deps.fetchImpl);
	};
	return [
		{
			name: BIND_WORKSPACE_TOOL,
			description: "Bind THIS Feishu chat to a project directory, durably. The next `/new` in this chat starts there, so that directory's AGENTS.md is loaded — this is how a chat switches project memory. The running conversation keeps the directory it was created in, so tell the human to send /new. Pass dir=\"default\" to unbind and fall back to the deployment directory.",
			parameters: {
				type: "object",
				properties: { dir: {
					type: "string",
					description: "Absolute project directory, or \"default\" to unbind"
				} },
				required: ["dir"]
			},
			output: {
				schema: {
					type: "object",
					properties: {
						ok: { type: "boolean" },
						dir: { type: "string" },
						unbind: { type: "boolean" },
						note: { type: "string" },
						error: { type: "string" }
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: value.ok ? value.note ?? `已绑定到 \`${value.dir ?? "?"}\`。` : `绑定失败：${value.error ?? "未知错误"}`
				}]
			},
			async execute(args, exec) {
				const chatId = resolveChat(exec, void 0);
				if (chatId === void 0) return {
					ok: false,
					error: "cannot resolve this chat"
				};
				if (deps.bindChatCwd === void 0) return {
					ok: false,
					error: "this deployment cannot rebind a chat workspace"
				};
				const raw = asText(args.dir).trim().replace(/^["']|["']$/g, "");
				if (raw === "") return {
					ok: false,
					error: "dir is required"
				};
				if (raw.toLowerCase() === "default") {
					await deps.bindChatCwd(chatId, null);
					return {
						ok: true,
						unbind: true,
						note: "已解除绑定：下一个 /new 回到部署目录。"
					};
				}
				const target = resolve(raw);
				let isDirectory = false;
				try {
					isDirectory = statSync(target).isDirectory();
				} catch {}
				if (!isDirectory) return {
					ok: false,
					error: `目录不存在或不是目录：${target}`
				};
				await deps.bindChatCwd(chatId, target);
				return {
					ok: true,
					dir: target,
					note: `已绑定到 ${target}：发 /new 开新对话，之后就在这个项目里工作。`
				};
			}
		},
		{
			name: FEISHU_NOTIFY_TOOL,
			description: "Send a message to a Feishu chat through the bridge transport — including a chat DIFFERENT from the one this turn runs in. Use it for proactive pings the human should see now: a long task hit a milestone, a scheduled job finished, a background subagent needs attention. Without chat_id it posts into the CURRENT chat; the text is Feishu markdown.",
			parameters: {
				type: "object",
				properties: {
					text: {
						type: "string",
						description: "Message body, Feishu markdown (post text)"
					},
					chat_id: {
						type: "string",
						description: "Target chat id; omit to send into the current chat"
					}
				},
				required: ["text"]
			},
			output: {
				schema: {
					type: "object",
					properties: {
						ok: { type: "boolean" },
						chat_id: { type: "string" },
						error: { type: "string" }
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: value.ok ? `已发送到聊天 \`${value.chat_id ?? "?"}\`。` : `发送失败：${value.error ?? "未知错误"}`
				}]
			},
			async execute(args, exec) {
				const parsed = args;
				const text = asText(parsed.text);
				if (text.trim() === "") return {
					ok: false,
					error: "text 不能为空"
				};
				const chatId = resolveChat(exec, parsed.chat_id);
				if (chatId === void 0) return {
					ok: false,
					error: "无法确定目标聊天：当前会话未绑定聊天，且未传 chat_id"
				};
				try {
					await deps.port.send(chatId, { markdown: text });
					return {
						ok: true,
						chat_id: chatId
					};
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
		},
		{
			name: FEISHU_DRIVE_WRITE_TOOL,
			description: "Write (or overwrite) a text file in the Feishu app's own cloud-drive space — a durable spot reachable from any device with this Feishu app, independent of the workspace filesystem. Use it for handoff notes, fleet state, or artifacts the human wants to open inside Feishu.",
			parameters: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "File name in the app drive space (e.g. notes.md)"
					},
					content: {
						type: "string",
						description: "Full text content to store"
					}
				},
				required: ["name", "content"]
			},
			output: {
				schema: {
					type: "object",
					properties: {
						ok: { type: "boolean" },
						name: { type: "string" },
						error: { type: "string" }
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: value.ok ? `已写入飞书云空间：\`${value.name ?? "?"}\`。` : `写入失败：${value.error ?? "未知错误"}`
				}]
			},
			async execute(args) {
				const parsed = args;
				const name = asText(parsed.name);
				const content = typeof parsed.content === "string" ? parsed.content : "";
				if (name.trim() === "") return {
					ok: false,
					error: "name 不能为空"
				};
				const client = cloud();
				if (client === void 0) return {
					ok: false,
					error: "本端未配置飞书凭证，云空间不可用"
				};
				try {
					await client.putJson(name, content);
					return {
						ok: true,
						name
					};
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
		},
		{
			name: FEISHU_DRIVE_READ_TOOL,
			description: "Read one text file back from the Feishu app's cloud-drive space (the files `feishu_drive_write` stores). Returns null content when the name is unknown.",
			parameters: {
				type: "object",
				properties: { name: {
					type: "string",
					description: "File name in the app drive space"
				} },
				required: ["name"]
			},
			output: {
				schema: {
					type: "object",
					properties: {
						ok: { type: "boolean" },
						name: { type: "string" },
						content: { oneOf: [{ type: "string" }, { type: "null" }] },
						error: { type: "string" }
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: value.ok ? `已读取 \`${value.name ?? "?"}\`（${value.content === null || value.content === void 0 ? 0 : value.content.length} 字符）。` : `读取失败：${value.error ?? "未知错误"}`
				}]
			},
			async execute(args) {
				const name = asText(args.name);
				if (name.trim() === "") return {
					ok: false,
					error: "name 不能为空"
				};
				const client = cloud();
				if (client === void 0) return {
					ok: false,
					error: "本端未配置飞书凭证，云空间不可用"
				};
				try {
					return {
						ok: true,
						name,
						content: await client.getJson(name)
					};
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
		},
		{
			name: FEISHU_DRIVE_LIST_TOOL,
			description: "List the files currently stored in the Feishu app's cloud-drive space.",
			parameters: {
				type: "object",
				properties: {}
			},
			output: {
				schema: {
					type: "object",
					properties: {
						ok: { type: "boolean" },
						files: {
							type: "array",
							items: {
								type: "object",
								properties: {
									name: { type: "string" },
									modifiedMs: { type: "number" }
								}
							}
						},
						error: { type: "string" }
					},
					additionalProperties: false
				},
				render: (_args, value) => [{
					type: "text",
					text: value.ok ? `云空间共 ${value.files?.length ?? 0} 个文件。` : `列出失败：${value.error ?? "未知错误"}`
				}]
			},
			async execute() {
				const client = cloud();
				if (client === void 0) return {
					ok: false,
					error: "本端未配置飞书凭证，云空间不可用"
				};
				try {
					return {
						ok: true,
						files: (await client.list()).map((file) => ({
							name: file.name,
							modifiedMs: file.modifiedMs
						}))
					};
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
		}
	];
}
/** The prompt section text for the tools above (composeChatAgent registers it). */
function feishuToolsPromptSection() {
	return "Channel-native Feishu tools are registered for you: `feishu_notify` posts a message into this chat (or any chat_id you pass) outside your normal reply flow — use it for proactive pings from long or scheduled work, not as a substitute for your reply. `feishu_drive_write` / `feishu_drive_read` / `feishu_drive_list` store and fetch text files in the Feishu app's own cloud space, which survives across devices and machines — use them for handoff notes and state that must outlive this workspace. `bind_workspace` binds THIS chat to a project directory durably: the next `/new` starts there and loads that directory's AGENTS.md, which is how a chat switches project memory. Call it when the human asks to move this conversation to another project; then tell them to send `/new`, because the running conversation keeps its directory.";
}
//#endregion
//#region lib/types/bridge.js
/**
* The chat↔agent bridge: inbound Lark messages drive per-chat DSH agents,
* committed assistant output returns as chat messages, and host approval
* questions become interactive cards answered by button clicks.
* @module dsh-lark-bridge/bridge
*/
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
function boundCardText(text, maxChars = DEFAULT_LIMITS.approvalArgChars) {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
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
function composeChatAgent(agentCtx, config, extraTools = [], runtimeDenied = void 0, identityClause) {
	const tools = agentCtx.tools ?? agentCtx.get("tools");
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
	const clause = identityClause?.();
	prompt?.section({
		name: "dsh-lark-bridge:identity",
		order: 120,
		text: (clause === void 0 ? "" : `你是飞书上的${clause}。`) + "You are a coding agent running inside a Feishu/Lark chat via the DeepSeek Harness host. The person you are talking to is the user of this chat, not a machine. Reply in the same language they write in. You have the full coding-agent toolset of the host: you can read and edit files, run commands, and work on projects in the workspace. When you need a decision or want to ask a clarifying question, write it directly in your reply — their next message is the answer, and the chat keeps the conversation going. Do not describe your own architecture or ask what kind of interface you are running on; you are simply the bot in this chat. When the user asks who you are, answer with the Chinese name above (if present) — never invent a different name."
	});
	prompt?.section({
		name: "dsh-lark-bridge:interaction",
		order: 150,
		text: "To ask a question or seek approval for a plan, write it in your reply — their next message is the answer. " + (config.denyTools.length > 0 ? `These tools are unavailable here: ${[...new Set(config.denyTools)].join(", ")}.` : "")
	});
	if (extraTools.some((tool) => tool.name === "feishu_notify")) prompt?.section({
		name: "dsh-lark-bridge:feishu-tools",
		order: 121,
		text: feishuToolsPromptSection()
	});
	prompt?.section({
		name: "dsh-lark-bridge:pricing",
		order: 122,
		text: pricingPromptLine()
	});
	prompt?.section({
		name: "dsh-lark-bridge:background-tasks",
		order: 130,
		text: "Long-running commands (builds, installs, setup scripts, anything that may take minutes): ALWAYS pass run_in_background=true to the shell/exec tool. The host JobRegistry tracks the job and the bridge automatically sends a completion notice with the output tail into this chat when it settles — you do NOT need to poll. NEVER wrap a command in `while pgrep ...; do sleep N; done; tail ...` or similar polling loops: the wrapper itself becomes the process that gets killed by the turn timeout, and the tail/echo after the loop never runs. If you need to check on a background job later, use `/jobs` or read the log file the command was told to write to — do not block a turn waiting."
	});
}
/**
* Whether a standby endpoint answers this line in the chat.
*
* The fleet is single-writer: only the arbitration-active endpoint replies,
* and a standby stays silent on ordinary traffic so a phone client never
* talks over the machine that is actually answering. Silence is wrong for the
* two READ-ONLY lines the user guide sends a puzzled operator to (`/help` and
* `/bot devices`) — their entire job is to say where the fleet is, so
* swallowing them turns a healthy standby into "the bot is dead". Everything
* with an effect (and all prose) still gets nothing, so answering can never
* make a standby a second executor of the same command.
* @param text - the inbound message text exactly as received.
* @returns whether this line deserves a standby notice.
*/
function standbyAnswers(text) {
	const line = text.trim();
	const name = commandName(line);
	if (name === "help") return true;
	if (name !== "bot") return false;
	return (line.slice(4).trim().split(/\s+/)[0] ?? "") === "devices";
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
* How much of a quoted message the model is shown.
*
* A quote can be an entire bot answer. Repeating it verbatim buys nothing the
* session history does not already hold, and a long one would push the actual
* question out of the model's attention — so the head, and a marker.
*/
/**
* How long this chat had been quiet before the current turn started.
*
* Keyed by session id and held for the life of the process. A restart forgets
* it, which is the honest behaviour: after a restart the agent genuinely
* cannot say how long the chat was quiet, and inventing "刚刚" would be a lie
* the model then reasons from. Read-and-write in one call so the gap is always
* measured from the previous turn, never from this one.
*/
const lastTurnStarted = /* @__PURE__ */ new Map();
/**
* How long the chat was quiet before this turn, as a phrase for the model.
*
* Only the GAP comes from here. The absolute time belongs to the message
* stamp beside it (`showMessageTime`), and saying the same instant twice put
* two timestamps three seconds apart at the top of every message — which
* leaves the model to guess which one is "now". One line, one time, one gap:
* the gap is the part the stamp cannot carry, and it is the part that
* actually changes behaviour. A model resuming after eight hours should
* re-check state it assumed; one resuming after three minutes should not
* spend a turn doing it.
* @param sessionId - the session this turn belongs to.
* @param now - epoch milliseconds at turn start.
* @returns the phrase (e.g. `4 分钟前`), or '' when the gap is unknown or
*   too small to be worth a word.
*/
function sessionGapPhrase(sessionId, now) {
	const previous = lastTurnStarted.get(sessionId);
	lastTurnStarted.set(sessionId, now);
	if (previous === void 0) return "";
	const gap = elapsedPhrase(now - previous);
	return gap === "刚刚" ? "" : gap;
}
/**
* Render the message a chat message quotes back, as a block to prepend.
*
* 飞书的「引用」不是正文的一部分：入站事件只带 `parent_id`，被引用的那条要
* 另外调 `im.v1.message.get` 才能读到。不取它，模型看到的就是一句「这个你再
* 改改」加一片空白——它只能猜「这个」是什么，而人会以为它当然看得见。
*
* @param quoted - the referenced message, already fetched.
* @param maxChars - how much of its text to keep.
* @param showTime - whether to stamp when the quoted message was sent. A quote
*   read without its time turns "你引用的那条" into "whatever that was" — the
*   model cannot tell a reply to a two-minute-old message from a six-hour one.
* @returns the block and its trailing newline, or '' when there is nothing to show.
*/
function quotedPrefix(quoted, maxChars = DEFAULT_LIMITS.quoteChars, showTime = false) {
	if (quoted === void 0) return "";
	const body = quoted.content.trim();
	const who = quoted.senderName ?? quoted.senderId;
	const when = showTime ? messageTimeStamp(quoted.createTime) : void 0;
	const text = body !== "" ? body.length > maxChars ? `${body.slice(0, maxChars)}…（引用内容过长，已截断）` : body : quoted.resources.length > 0 ? "（这是一条图片/文件消息，没有文字内容）" : "（这条被引用的消息没有文字内容）";
	return `${when === void 0 ? `[引用 · ${who}]` : `[引用 · ${who} · ${when}]`}\n${text}\n[/引用]\n`;
}
/**
* Choose the inbox boundary for one chat message (issue #5).
*
* A message that lands while a turn is running used to be queued
* unconditionally: the chat read the wait as a hang, and the only way to change
* direction was `/stop`, which throws the running turn's work away. `steer`
* lands the message at the running driver's next step boundary, so a
* correction takes effect inside the turn it corrects.
*
* An idle agent keeps the original semantics — an ordinary follow-up turn that
* opens one — whatever the policy says, because there is nothing to steer.
*
* A policy the host cannot honour (an agent double with no `steer`, a host old
* enough to predate it) degrades to `queue` and says so: the message must still
* arrive, one turn later.
*
* @param busy - whether a turn is running (`agent.status === 'running'`).
* @param policy - the deployment's `busyPolicy`.
* @param agent - the live agent, inspected for the boundary it accepts.
* @returns the policy to apply and the receipt line for it.
*/
function busyDelivery(busy, policy, agent) {
	if (!busy) return {
		policy: "queue",
		receipt: ""
	};
	if (policy === "steer") return typeof agent.steer === "function" ? {
		policy: "steer",
		receipt: "🎯 已插话：下一个 step 边界生效，当前进度保留；要立即中止请发 /stop。"
	} : {
		policy: "queue",
		receipt: "⚠️ 本宿主不支持中途插话（steer），已退回排队：当前任务完成后处理这条。"
	};
	if (policy === "inject") return typeof agent.inject === "function" ? {
		policy: "inject",
		receipt: "📎 已作为上下文注入：模型下一步会读到，不打断当前任务。"
	} : {
		policy: "queue",
		receipt: "⚠️ 本宿主不支持上下文注入（inject），已退回排队：当前任务完成后处理这条。"
	};
	return {
		policy: "queue",
		receipt: "⏳ 已排队：当前任务完成后自动处理这条。"
	};
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
	const deliverDeclaredFile = async (sessionId, path, caption) => {
		const binding = bySession.get(sessionId);
		if (binding === void 0) throw new Error(`会话 ${sessionId} 不在当前聊天`);
		return deliverFile(replay, binding.chatId, cwd, {
			path,
			...caption === void 0 || caption === "" ? {} : { caption }
		});
	};
	/**
	* Deliver a file a child session declared into the chat that owns it.
	*
	* A child runs in its own session, so the session is not the one bound to
	* the chat; the chat is found through the child mapping instead. A file
	* nobody can place is reported rather than dropped without a word.
	*/
	const deliverChildDeclaredFile = async (chatId, path, caption) => {
		await deliverFile(replay, chatId, cwd, {
			path,
			...caption === void 0 || caption === "" ? {} : { caption }
		});
	};
	const feishuTools = createFeishuTools({
		port: replay,
		chatOfSession: (sessionId) => bySession.get(sessionId)?.chatId,
		bindChatCwd: (chatId, dir) => bindChatCwd(chatId, dir),
		chatCwd: (chatId) => chatCwd(chatId),
		credentials: config.appId !== void 0 && config.appSecret !== void 0 ? {
			appId: config.appId,
			appSecret: config.appSecret,
			...config.domain !== void 0 ? { domain: config.domain } : {}
		} : void 0
	});
	/**
	* Who the human is talking to, as Feishu itself names the app — quoted by
	* the model's self-description and the first-contact guide so the identity
	* question is answered before it is asked (fleet UX: endpoints and even
	* separate deployments echo similar names; the form/profile suffix tells
	* same-app ends apart). Best-effort: a failed lookup only hides the name.
	*/
	let botName;
	if (config.appId !== void 0 && config.appSecret !== void 0) new FeishuCloud({
		appId: config.appId,
		appSecret: config.appSecret,
		...config.domain !== void 0 ? { domain: config.domain } : {}
	}).botInfo().then((info) => {
		botName = info.name;
	}).catch(() => {});
	/** One clause naming this bot and which endpoint is answering. */
	const identityClause = () => {
		const syncCtx = getSyncContext();
		const where = syncCtx === void 0 ? "" : `（本端：${syncCtx.form} · ${syncCtx.profile}）`;
		return botName === void 0 ? void 0 : `「${botName}」${where}`;
	};
	const runtimeDeniedTools = new Set(config.denyTools);
	const scheduleRegistry = /* @__PURE__ */ new Map();
	/** Sessions whose registry was already rebuilt from their own log. */
	const seededSchedules = /* @__PURE__ */ new Set();
	/**
	* Apply one `schedule/change` payload to a session's registry.
	*
	* `create` records, `delete` forgets, `dispatch` fires a one-shot (drop it)
	* or ticks a repeating schedule (keep it for the next round). Split out of
	* the event handler so the log replay below applies exactly the same rules —
	* two implementations of "what is still scheduled" is how the two drift.
	*
	* @param byId - the session's registry.
	* @param data - the event payload.
	*/
	const applyScheduleChange = (byId, data) => {
		const id = data.schedule?.id ?? data.id;
		if (id === void 0) return;
		if (data.operation === "create" && data.schedule !== void 0) {
			byId.set(id, {
				id,
				kind: data.schedule.kind,
				prompt: data.schedule.prompt,
				...data.schedule.everySeconds === void 0 ? {} : { everySeconds: data.schedule.everySeconds },
				createdAt: Date.now()
			});
			return;
		}
		if (data.operation === "delete") byId.delete(id);
		else if (data.operation === "dispatch" && data.schedule?.kind === "after") byId.delete(id);
	};
	/**
	* Rebuild one session's schedule registry from its own log, once.
	*
	* The registry is fed by live `schedule/change` events, so a restart starts
	* empty — and a reminder created before this process booted never announces
	* itself again. That is not a corner case: a long-running deployment creates
	* reminders in one process and answers `/schedules` in the next, and the
	* command then reports "none" for reminders that are still firing.
	*
	* The schedule plugin owns the truth: its `list` is what actually fires, and
	* it survives restarts. The session log is only a fallback — it carries the
	* change events that happened to be appended, and a reminder created before
	* this process booted has none, which is exactly the case that broke.
	*
	* Either way the replay is silent on purpose: someone asking what is
	* scheduled must not be told again about every reminder ever created.
	*
	* @param session - the session to restore.
	*/
	const seedScheduleRegistry = async (session) => {
		if (seededSchedules.has(session.id)) return;
		seededSchedules.add(session.id);
		const byId = scheduleRegistry.get(session.id) ?? /* @__PURE__ */ new Map();
		const store = ctx.get("schedule");
		if (store?.list !== void 0) try {
			const records = await store.list({ sessionId: session.id });
			for (const record of records) byId.set(record.id, {
				id: record.id,
				kind: record.kind,
				prompt: record.prompt,
				...record.everySeconds === void 0 ? {} : { everySeconds: record.everySeconds },
				createdAt: Date.now()
			});
			if (byId.size > 0) scheduleRegistry.set(session.id, byId);
			return;
		} catch {}
		for (let seq = 0; seq < session.seq; seq++) {
			const event = session.eventAt(seq);
			if (event === void 0 || !isScheduleChangeEvent(event)) continue;
			applyScheduleChange(byId, event.data);
		}
		if (byId.size > 0) scheduleRegistry.set(session.id, byId);
	};
	/**
	* Call ids whose declared files were already delivered, per session.
	*
	* A turn can end with more than one declaration, and a host may replay
	* the event or nest calls, so the call id is what makes the delivery
	* exactly-once. The set is bounded by the number of declarations one
	* session makes, which is small.
	*/
	const presentedCalls = /* @__PURE__ */ new Map();
	const sessionPresets = /* @__PURE__ */ new Map();
	/**
	* Per-session reasoning effort chosen via /think.
	*
	* Unlike the preset choice above this one survives a restart: it is recorded
	* as a durable `model/selection` event on the session itself, and restored
	* when the agent is composed. The choice belongs to the session — `/sessions`
	* can bring that session back, and it must come back at the effort it was
	* left at.
	*/
	const effortOverrides = new EffortOverrides(ctx);
	const subagentTrackers = /* @__PURE__ */ new Map();
	/** One team card per chat, with the message id it updates in place. */
	const teamTrackers = /* @__PURE__ */ new Map();
	/** 外勤会话镜像 (P141)：未绑定且非子会话的独立会话，按会话节流推一行进度。 */
	const externalMirrorAt = /* @__PURE__ */ new Map();
	/**
	* When each child's last progress line reached the chat, per chat+child.
	*
	* A child's work is worth saying out loud, but every one of its tool
	* calls is not: a child that reads twenty files would otherwise put
	* twenty lines into the chat between the question and the answer. One
	* line per child per window is what a reader can actually use.
	*/
	const childProgressAt = /* @__PURE__ */ new Map();
	/** How often one child's progress reaches the chat, in milliseconds. */
	const CHILD_PROGRESS_WINDOW_MS = 3e4;
	/** childId → chatId. 0.1.5 runs every child in its OWN session — the id
	* `subagent/catalog` reports as `childId` IS that session id (verified against
	* this install: each of the 20 catalog ids had a matching session directory),
	* so a child's events arrive under a session that has no chat binding. This map
	* is how they find their panel row without touching the parent's display. */
	const childChat = /* @__PURE__ */ new Map();
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
	/** The last token total seen for a session, so the poll log only speaks when it changed. */
	const lastMeasured = /* @__PURE__ */ new Map();
	const cwd = resolve(config.cwd ?? process.cwd());
	/**
	* Per-chat cwd overrides, loaded once and kept in step with writes.
	*
	* A chat that ran `/ws use <dir>` keeps that directory across restarts and
	* across `/new`: the binding is the chat's, not the session's, because the
	* whole point is that the next conversation starts in the same project.
	*/
	let chatBindingsPromise;
	const chatBindings = () => {
		chatBindingsPromise ??= readChatWorkspaces();
		return chatBindingsPromise;
	};
	/**
	* The directory a chat's next session should start in.
	*
	* Bound chats win; everything else falls back to the deployment `cwd`. The
	* result is canonicalised because the workspace registry validates a session
	* header against a realpath, and an uncanonicalized variant is rejected.
	*
	* @param chatId - the chat asking.
	* @returns the absolute directory for its next session.
	*/
	const chatCwd = async (chatId) => {
		const bound = (await chatBindings())[chatId];
		return bound === void 0 ? cwd : resolve(bound);
	};
	/**
	* Bind one chat to a directory (or clear it with `null`) and drop the cached
	* workspace promise, so the next session resolves the new directory.
	*
	* @param chatId - the chat being rebound.
	* @param dir - absolute directory, or `null` to fall back to the deployment cwd.
	*/
	const bindChatCwd = async (chatId, dir) => {
		await writeChatWorkspace(chatId, dir);
		const bindings = await chatBindings();
		if (dir === null) delete bindings[chatId];
		else bindings[chatId] = dir;
	};
	/**
	* The directory each session id must start in, seeded before the ladder runs.
	*
	* `SessionLadder.create` receives only the session id — the chat it came from
	* is not part of the contract — so the bound directory is handed over here,
	* keyed by the id the acquire path is about to ask for.
	*/
	const pendingSessionCwd = /* @__PURE__ */ new Map();
	/**
	* Multi-agent panel plumbing — ONE updatable card per chat, keyed by the
	* child's own session id.
	*
	* Why `subagent/catalog` and not `subagent/descriptor`: 0.1.5 appends the
	* descriptor inside the CHILD's session (subagent-in-process-driver
	* `attachDescriptorAppend`), so a subscriber on the parent chat session never
	* receives it. The durable parent-side record is `subagent/catalog`
	* (`establishCatalogChild` → `parent.append`), and it carries
	* `childId / childCreatedAt / mode / label`. Wiring the panel to the
	* descriptor is why「多代理执行面板」never appeared while every gate stayed
	* green (2026-09-15).
	*/
	const CARD_UPDATE_MIN_MS = 4e3;
	const streamDebug = process.env.DSH_BRIDGE_STREAM_DEBUG === "1";
	const trackerFor = (chatId) => {
		let tracker = subagentTrackers.get(chatId);
		if (tracker === void 0) {
			tracker = createTracker();
			subagentTrackers.set(chatId, tracker);
		}
		return tracker;
	};
	/** Send the panel the first time, then keep it updated in place. */
	const flushSubagentCard = async (chatId, tracker, force) => {
		const now = Date.now();
		if (!force && tracker.updatedAt !== void 0 && now - tracker.updatedAt < CARD_UPDATE_MIN_MS) return;
		tracker.updatedAt = now;
		const card = render(tracker, now);
		if (tracker.messageId === void 0) {
			tracker.messageId = (await replay.send(chatId, { card })).messageId;
			return;
		}
		await port.updateCard(tracker.messageId, card);
	};
	/**
	* Send or refresh the team card for one chat.
	*
	* The card is sent once and updated in place afterwards, so a reader
	* watches one panel instead of scrolling a stream of team notices. The
	* throttle keeps a burst of team events from turning into a burst of card
	* updates.
	* @param chatId - the chat that leads the team.
	* @param force - update even inside the throttle window.
	*/
	const flushTeamCard = async (chatId, force) => {
		const tracker = teamTrackers.get(chatId);
		if (tracker === void 0) return;
		const now = Date.now();
		if (!force && tracker.updatedAt !== void 0 && now - tracker.updatedAt < CARD_UPDATE_MIN_MS) return;
		tracker.updatedAt = now;
		const card = renderTeamCard(tracker.state);
		if (tracker.messageId === void 0) {
			if (tracker.sending === true) {
				tracker.pending = true;
				return;
			}
			tracker.sending = true;
			try {
				tracker.messageId = (await replay.send(chatId, { card })).messageId;
			} finally {
				tracker.sending = false;
			}
			if (tracker.pending === true) {
				tracker.pending = false;
				await flushTeamCard(chatId, true);
			}
			return;
		}
		await port.updateCard(tracker.messageId, card);
	};
	/**
	* Fold a message one teammate relayed into another into the team card.
	*
	* The team package steers a member's message into the recipient's inbox
	* rather than recording a mailbox event, so the card's message list is
	* built from these relayed messages. A chat that has not seen a roster
	* event yet has no card to update, and the message is dropped with a note
	* rather than inventing a team the chat never led.
	*/
	const noteTeamRelayMessage = (chatId, event) => {
		if (!isTeamRelayMessageEvent(event)) return;
		const tracker = teamTrackers.get(chatId);
		if (tracker === void 0) return;
		addTeamRelayMessage(tracker.state, event.data.message, event.data.message.source.senderSessionId);
		flushTeamCard(chatId, true).catch(reportSendFailure);
	};
	const upsertSubagent = (chatId, id, descriptor, force = false) => {
		const tracker = trackerFor(chatId);
		addEntry(tracker, id, descriptor);
		flushSubagentCard(chatId, tracker, force).catch(reportSendFailure);
	};
	/** The panel's「最近在做的事」line: the tool's name plus its most telling string
	* argument (path / command / query). markActivity clips it to one card line. */
	const toolActivityLine = (name, args) => {
		const first = Object.values(args ?? {}).find((v) => typeof v === "string" && v.trim() !== "");
		return first === void 0 ? name : `${name} ${String(first)}`;
	};
	/**
	* Fold one activity sample into a child's row.
	*
	* Attribution here is EXACT rather than guessed: the child works in its own
	* session and callers pass that session id, which is the same id
	* `subagent/catalog` keyed the row with — so concurrent children can never
	* show one child's work under another child's name.
	*/
	const noteChildActivity = (chatId, childId, line) => {
		const tracker = subagentTrackers.get(chatId);
		if (tracker === void 0 || line.trim() === "") return;
		const entry = markActivity(tracker, childId, line);
		if (entry === void 0) return;
		if (streamDebug) notify(`dsh-lark-bridge: child ${childId}: ${line.slice(0, 60)}`);
		flushSubagentCard(chatId, tracker, entry.chunks <= 1).catch(reportSendFailure);
		if (config.announceSubagents === false) return;
		const key = `${chatId}|${childId}`;
		const now = Date.now();
		const last = childProgressAt.get(key);
		if (last !== void 0 && now - last < CHILD_PROGRESS_WINDOW_MS) return;
		childProgressAt.set(key, now);
		const label = entry.label.trim() === "" ? "子代理" : entry.label;
		replay.send(chatId, { markdown: `🔀 ${label} · ${line.trim()}` }).catch(reportSendFailure);
	};
	/**
	* A child's own session events are what the panel narrates.
	*
	* This routing is the whole point of the panel. Without it the card was
	* rendered once when `subagent/catalog` arrived and then froze at
	* 「进行中 · 0秒」for the child's entire run — the row existed, but the reader
	* still could not see what the child was doing.
	*/
	const noteChildSessionEvent = (chatId, childId, event) => {
		if (isTeamRelayMessageEvent(event)) {
			noteTeamRelayMessage(chatId, event);
			return;
		}
		if (isPresentedEvent(event) && config.presentBridge !== false) {
			const callId = event.data.callId;
			let seen = presentedCalls.get(childId);
			if (seen === void 0) {
				seen = /* @__PURE__ */ new Set();
				presentedCalls.set(childId, seen);
			}
			if (!seen.has(callId)) {
				seen.add(callId);
				(async () => {
					for (const file of event.data.files) {
						const caption = file.description === void 0 || file.description === "" ? `交付文件 · turn ${event.data.turn}` : file.description;
						try {
							await deliverChildDeclaredFile(chatId, file.path, caption);
						} catch (error) {
							const detail = error instanceof Error ? error.message : String(error);
							replay.send(chatId, { markdown: `⚠️ 交付文件 \`${file.path}\` 未能送达：${detail}` }).catch(reportSendFailure);
						}
					}
				})();
			}
			return;
		}
		if (isToolCallEvent(event)) {
			noteChildActivity(chatId, childId, toolActivityLine(event.data.name, event.data.arguments));
			return;
		}
		if (isAssistantMessageEvent(event)) {
			const text = event.data.message.content.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("");
			noteChildActivity(chatId, childId, text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "");
		}
	};
	setInterval(() => {
		const now = Date.now();
		for (const [chatId, tracker] of subagentTrackers) {
			if (runningEntries(tracker).length === 0) continue;
			if (tracker.updatedAt !== void 0 && now - tracker.updatedAt < 14e3) continue;
			flushSubagentCard(chatId, tracker, true).catch(reportSendFailure);
		}
	}, 15e3).unref?.();
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
				const measure = tokenMeter.measure(binding.session);
				total = measure.totalTokens;
				surface = measure.surfaceTokens;
			} catch (error) {
				ctx.logger.warn("token pressure measure failed for %s: %s", sessionId, error);
				continue;
			}
			const previous = lastMeasured.get(sessionId);
			if (previous === void 0 || previous !== total) {
				lastMeasured.set(sessionId, total);
				notify(`dsh-lark-bridge: token pressure poll session=${sessionId} total=${total} surface=${surface} threshold=${threshold}`);
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
	/**
	* Resolve (or register) the workspace record for one directory.
	*
	* Cached by DIRECTORY, not by chat: two chats in the same project share one
	* lookup, and a chat rebound to another project simply asks under a new key —
	* so a rebind can never be served by a stale promise.
	*
	* @param dir - the canonical directory a session starts in.
	* @returns the workspace record, or undefined when no registry is composed.
	*/
	const workspacePromises = /* @__PURE__ */ new Map();
	const chatWorkspace = (dir) => {
		const existing = workspacePromises.get(dir);
		if (existing !== void 0) return existing;
		const pending = (async () => {
			const registry = ctx.get("workspaceRegistry");
			if (registry === void 0) return void 0;
			return await registry.resolveByPath(dir) ?? await registry.create(dir);
		})().catch((error) => {
			notify(`dsh-lark-bridge: workspace lookup failed for ${dir}: ${String(error)}`);
		});
		workspacePromises.set(dir, pending);
		return pending;
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
	let disposeQuestions;
	try {
		const onQuestion = async (request, next) => {
			try {
				return await questions.provider.ask(request);
			} catch (error) {
				ctx.logger.warn("user-questions answerer failed, delegating: %s", error);
				return await next();
			}
		};
		disposeQuestions = ctx.on("user-questions/request", onQuestion);
	} catch (error) {
		notify(`dsh-lark-bridge: user-questions provider unavailable (${error instanceof Error ? error.message : String(error)})`);
		ctx.logger.warn("user-questions provider unavailable: %s", error);
	}
	/**
	* Resolve the provider/model for a new chat agent.
	*
	* The host's own selection comes first: it carries the choice `/model`
	* saved, and the config values are the deployment's initial defaults
	* rather than a lock. Reading the config first would make `/model` report
	* a switch that never reaches a new agent.
	*/
	const modelSelection = () => {
		const defaults = ctx.get("agentDefaultModel");
		if (defaults !== void 0) return defaults.currentSelection();
		if (config.provider !== void 0 || config.model !== void 0) return {
			provider: config.provider,
			model: config.model
		};
		throw new Error("dsh-lark-bridge: no model configured — set config.provider/model or compose the agentDefaultModel service");
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
		const toolScope = (presets === void 0 || presetId === void 0 ? void 0 : await presets.acquireScope(presetId))?.key;
		return {
			...presetId === void 0 ? {} : { presetId },
			...toolScope === void 0 ? {} : { toolScope },
			presentCall: createCallPresenter(ctx.get("tools"), toolScope),
			setup: async (agentCtx, agent) => {
				if (presets !== void 0 && presetId !== void 0) await presets.mount(agentCtx, presetId);
				composeChatAgent(agentCtx, config, [sendFileTool, ...feishuTools], runtimeDeniedTools, identityClause);
				if (agent !== void 0) {
					effortOverrides.restore(agent.session);
					effortOverrides.install(agentCtx, agent.session.id);
				}
				agentCtx.on("subagent/end", (info) => {
					const binding = bySession.get(sessionId);
					if (binding === void 0) return;
					const tracker = subagentTrackers.get(binding.chatId);
					childChat.delete(info.id);
					const settled = tracker?.entries.get(info.id);
					if (tracker !== void 0 && settleEntry(tracker, info.id, info.stopReason) !== void 0) flushSubagentCard(binding.chatId, tracker, true).catch(reportSendFailure);
					const delivery = settled === void 0 ? void 0 : deliveryText(settled);
					replay.send(binding.chatId, { markdown: delivery ?? subagentEndLine(info) }).catch(reportSendFailure);
				});
				const jobs = agentCtx.get("jobs");
				/**
				* The retained output of a settled job, for its completion notice.
				*
				* `readAt` is the non-consuming read: it leaves the cursor the agent
				* pulls from exactly where it is, so announcing a completion never
				* steals output the model still expects to see (a `read()` here would).
				* A notice without its tail still beats no notice, so any failure
				* degrades to "no tail" instead of throwing into the event stream.
				*/
				const jobOutput = (job) => {
					const coords = job.output;
					if (jobs === void 0 || coords === void 0 || coords.total <= coords.earliest) return "";
					try {
						return jobs.readAt(job.id, coords.earliest, sessionId).chunks.map((chunk) => chunk.text).join("");
					} catch (error) {
						console.warn(`[dsh-lark-bridge] 读取子任务 ${job.id} 的输出失败：${error instanceof Error ? error.message : String(error)}`);
						return "";
					}
				};
				jobs?.events?.subscribe({ owners: "scope" }, (event) => {
					if (event.type !== "settled") return;
					if (event.awaited) return;
					const snapshot = event.job;
					if (snapshot.status === "running" || snapshot.status === "stopping") return;
					const binding = bySession.get(sessionId);
					if (binding === void 0) return;
					const output = jobOutput(snapshot);
					const durationMs = Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0 ? Math.max(0, Date.now() - snapshot.startedAt) : void 0;
					const terminal = {
						id: snapshot.id,
						kind: snapshot.kind,
						label: snapshot.label,
						status: snapshot.status,
						...snapshot.detail === void 0 ? {} : { detail: snapshot.detail },
						...durationMs === void 0 ? {} : { durationMs },
						...output === "" ? {} : { output }
					};
					replay.send(binding.chatId, { markdown: jobDoneLine(terminal, config.limits.jobTailChars) }).catch(reportSendFailure);
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
			maybeSyncPendingPanel(handle.agent);
			return handle;
		},
		create: async (sessionId) => {
			const composition = await compositionFor(sessionId);
			const baseSessionId = baseSessionIdOf(sessionId);
			const dir = pendingSessionCwd.get(sessionId) ?? pendingSessionCwd.get(baseSessionId) ?? cwd;
			pendingSessionCwd.delete(sessionId);
			pendingSessionCwd.delete(baseSessionId);
			const workspace = await chatWorkspace(dir);
			const handle = await agents.create({
				sessionId,
				meta: {
					cwd: workspace?.path ?? dir,
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
			maybeSyncPendingPanel(handle.agent);
			return handle;
		},
		report: (line) => {
			ctx.logger.info(line);
		}
	}, createRotationStore());
	/**
	* The renderer for one session, opened on first use and kept until the fiber
	* unwinds: it holds the turn's streaming card, which outlives any one message.
	* @param sessionId - the session whose events it renders.
	* @param msg - the message that reached this session.
	* @returns the binding, the same object for every later message of the session.
	* @throws when the session's composition cannot be resolved.
	*/
	const bindingFor = async (sessionId, msg, session) => {
		const existing = bySession.get(sessionId);
		if (existing !== void 0) return existing;
		const { presentCall } = await compositionFor(sessionId);
		compositions.delete(sessionId);
		const binding = {
			chatId: msg.chatId,
			chatType: msg.chatType,
			renderer: renderFor(msg.chatId, presentCall),
			currentMessageId: void 0,
			session
		};
		bySession.set(sessionId, binding);
		if (config.onboarding && freshlyCreated.delete(sessionId)) replay.send(binding.chatId, onboardingMessage(process.env, identityClause())).catch(reportSendFailure);
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
			answer: createMessageRenderer(port, chatId, reportSendFailure),
			limits: config.limits
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
			const loader = ctx.get("loader");
			const entries = loader?.entries;
			if (entries === void 0) return void 0;
			return [...entries.call(loader)];
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
			name: SESSION_COMMAND,
			description: describeCommand(SESSION_COMMAND, locale, "Inspect the current session")
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
			name: BALANCE_COMMAND,
			description: describeCommand(BALANCE_COMMAND, locale, "DeepSeek API balance")
		},
		{
			name: MANUAL_COMMAND,
			description: describeCommand(MANUAL_COMMAND, locale, "The full user guide")
		},
		...ctx.get("messageFeedback") === void 0 ? [] : [{
			name: FEEDBACK_COMMAND,
			description: describeCommand(FEEDBACK_COMMAND, locale, "Record feedback about this session")
		}],
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
			name: THINK_COMMAND,
			description: describeCommand(THINK_COMMAND, locale, "View or change this session’s reasoning effort")
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
		{
			name: "bot",
			description: describeCommand("bot", locale, "Bridge dual-end status, settings, plugin sync")
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
			name: "new",
			description: describeCommand("new", locale, "Start a new session")
		},
		{
			name: HELP_COMMAND,
			description: describeCommand(HELP_COMMAND, locale, "Show available commands")
		}
	];
	/**
	* The panel belongs to the Feishu APP, and a fleet shares one app: when web
	* and desktop both boot, two differently composed host command sets would
	* rewrite the panel out from under each other, and the menu stops matching
	* whichever endpoint actually answers the commands. The arbitration's
	* active endpoint is therefore the single panel writer — standbys keep
	* their list to themselves and re-sync the moment they are promoted
	* (election, `/bot activate`), which the inbound path drives through
	* `maybeSyncPendingPanel`.
	*/
	let panelSyncPending = false;
	const ownPanel = async () => {
		const arbitration = await arbitrationForInbound();
		if (arbitration === null) return true;
		const syncCtx = getSyncContext();
		return isActiveEndpoint(arbitration, (await ensureDeviceId()).deviceId, syncCtx?.form ?? "web", syncCtx?.profile ?? "web");
	};
	const publishSlashPanel = (agent) => {
		if (!config.syncSlashCommands) return;
		(async () => {
			if (!await ownPanel()) {
				panelSyncPending = true;
				notify("dsh-lark-bridge: standby endpoint skipped slash-panel sync (the active endpoint owns the panel)");
				return;
			}
			panelSyncPending = false;
			const hosted = ctx.get("commands")?.list(agent) ?? [];
			const locale = config.locale;
			syncSlashPanel(port, [...hosted.map((descriptor) => ({
				name: descriptor.name,
				description: describeCommand(descriptor.name, locale, descriptor.description)
			})), ...channelCommands(locale)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), notify).then(({ added, removed }) => {
				if (added.length > 0) notify(`dsh-lark-bridge: registered /${added.join(", /")} on the bot's slash panel`);
				if (removed.length > 0) notify(`dsh-lark-bridge: removed /${removed.join(", /")} from the bot's slash panel`);
			});
		})();
	};
	/** A promoted standby re-syncs the panel once, on the next inbound message. */
	const maybeSyncPendingPanel = (agent) => {
		if (!panelSyncPending || !config.syncSlashCommands) return;
		ownPanel().then((mine) => {
			if (!mine) return;
			panelSyncPending = false;
			publishSlashPanel(agent);
		});
	};
	/** Aborts in-flight command executions when this bridge unwinds. */
	const commands = new AbortController();
	const lastSearchNoticeAt = /* @__PURE__ */ new Map();
	ctx.effect(() => () => {
		commands.abort();
	}, "dsh-lark-bridge:commands");
	const commandSignal = () => commands.signal;
	/**
	* Report a stage that overruns, naming it.
	*
	* The inbound handler awaits several things with no deadline (device state,
	* the cloud arbitration record, session acquisition). When one never
	* settles the handler parks for good: the message is acknowledged with a
	* reaction and then nothing happens — no reply, no error, no log — and only
	* a restart clears it. Naming the stage that overran turns that from
	* guesswork into a one-line diagnosis.
	*/
	const SLOW_STAGE_MS = 1e4;
	const stage = async (messageId, name, run) => {
		const timer = setInterval(() => notify(`dsh-lark-bridge: inbound ${messageId} still in stage=${name} after ${SLOW_STAGE_MS / 1e3}s`), SLOW_STAGE_MS);
		timer.unref?.();
		try {
			return await run();
		} finally {
			clearInterval(timer);
		}
	};
	const handleMessage = async (msg) => {
		notify(`dsh-lark-bridge: inbound ${msg.messageId} in ${msg.chatId}`);
		const refusal = refuseMessage(authorization, msg);
		if (refusal !== void 0) {
			notify(`dsh-lark-bridge: ignored a message in ${msg.chatId}: ${refusal}`);
			return;
		}
		if (msg.senderIsBot === true) return;
		if (msg.content.trim() === "") return;
		reactions?.ack(msg.messageId);
		if (msg.content.trim() !== "/bot activate") {
			if ((await stage(msg.messageId, "device-state", () => readDeviceState())).retired === true) {
				await port.send(msg.chatId, { markdown: "↪️ 本端已退位（设备已迁移）。如需在本机重新启用，请发 `/bot activate`。" }).catch(reportSendFailure);
				return;
			}
			const arbitration = await stage(msg.messageId, "arbitration", () => arbitrationForInbound());
			if (arbitration !== null) {
				const syncCtx = getSyncContext();
				const myIdentity = await stage(msg.messageId, "device-identity", () => ensureDeviceId());
				const myForm = syncCtx?.form ?? "web";
				const myProfile = syncCtx?.profile ?? "web";
				if (!isActiveEndpoint(arbitration, myIdentity.deviceId, myForm, myProfile)) {
					if (!(syncCtx !== void 0 && await claimIfActiveStale(syncCtx, arbitration))) {
						const where = arbitration.form === void 0 ? "" : `（${arbitration.form}${arbitration.profile === void 0 ? "" : `/${arbitration.profile}`}）`;
						notify(`dsh-lark-bridge: standby backed off a message in ${msg.chatId} (active: ${arbitration.activeName}${where})`);
						if (standbyAnswers(msg.content)) await port.send(msg.chatId, { markdown: `🛰️ 本端是待命端，活跃端是 **${arbitration.activeName}**${where}——命令由活跃端执行。这条只读命令请到活跃端发；想让本端接管，发 \`/bot activate\`。` }).catch(reportSendFailure);
						return;
					}
					notify(`dsh-lark-bridge: elected active endpoint ${myIdentity.deviceId} (${myForm}/${myProfile}; previous went silent)`);
				}
			}
		}
		postChronicle(config.chronicleEndpoint, {
			source: config.chronicleSource,
			text: msg.content,
			chatId: msg.chatId
		}, notify);
		try {
			pendingSessionCwd.set(sessionIdFor(conversationKey(config.sessionScope ?? "chat", msg)), await chatCwd(msg.chatId));
			const opened = await stage(msg.messageId, "session-acquire", () => sessions.acquire(msg));
			const binding = await stage(msg.messageId, "session-bind", () => bindingFor(opened.handle.agent.session.id, msg, opened.handle.agent.session));
			binding.currentMessageId = msg.messageId;
			const preemptive = msg.content.trim().toLowerCase();
			if (preemptive === "/stop") {
				opened.handle.agent.cancel("user-requested");
				notify(`dsh-lark-bridge: preemptive /stop for session ${opened.handle.agent.session.id}`);
				await port.send(msg.chatId, { markdown: "⏹ 已停止当前任务" }).catch(reportSendFailure);
				return;
			}
			const wsUse = /^\/ws\s+use(?:\s+(.+))?$/i.exec(msg.content.trim());
			if (wsUse !== null) {
				const asked = (wsUse[1] ?? "").trim().replace(/^["']|["']$/g, "");
				if (asked === "") {
					const current = await chatCwd(msg.chatId);
					await port.send(msg.chatId, { markdown: `📁 本会话绑定：\`${current}\`\n\n\`/ws use <目录>\` 切换 · \`/ws use default\` 解除绑定 · 切换后发 \`/new\` 开新对话生效` }).catch(reportSendFailure);
					return;
				}
				if (asked.toLowerCase() === "default") {
					await bindChatCwd(msg.chatId, null);
					await port.send(msg.chatId, { markdown: `📁 已解除绑定，本会话回到部署目录 \`${cwd}\`。发 \`/new\` 生效。` }).catch(reportSendFailure);
					return;
				}
				const target = resolve(asked);
				let isDirectory = false;
				try {
					isDirectory = statSync(target).isDirectory();
				} catch {}
				if (!isDirectory) {
					await port.send(msg.chatId, { markdown: `⚠️ 目录不存在或不是目录：\`${target}\`\n\n绑定未改动。` }).catch(reportSendFailure);
					return;
				}
				await bindChatCwd(msg.chatId, target);
				await port.send(msg.chatId, { markdown: `📁 本会话已绑定到 \`${target}\`。\n\n发 \`/new\` 开新对话，之后就在这个项目里工作——该目录的 \`AGENTS.md\` 会被加载。` }).catch(reportSendFailure);
				return;
			}
			if (preemptive === "/new" || preemptive === "/clear") {
				if (opened.handle.agent.status === "running") {
					await port.send(msg.chatId, { markdown: "⏳ 当前任务还在跑：先 /stop 或等它结束，再 /new 开新会话。" }).catch(reportSendFailure);
					return;
				}
				try {
					const rotated = await sessions.rotate(msg);
					notify(`dsh-lark-bridge: /new rotated ${msg.chatId} to session ${rotated.handle.agent.session.id}`);
					const warn = rotated.persisted ? "" : "\n⚠️ 但轮换记忆写入失败：重启后这条对话会退回旧历史，重要话题先别开。";
					await port.send(msg.chatId, { markdown: "🆕 已开新会话。下一条消息起就是新话题；旧会话保留在历史里（`/sessions` 可查）。" + warn }).catch(reportSendFailure);
				} catch (error) {
					await port.send(msg.chatId, { markdown: `⚠️ 开新会话失败：${error instanceof Error ? error.message : String(error)}` }).catch(reportSendFailure);
				}
				return;
			}
			if (isCommandLine(msg.content)) {
				const sessionId = opened.handle.agent.session.id;
				const presetBefore = sessionPresets.get(sessionId);
				let outcome;
				try {
					await seedScheduleRegistry(opened.handle.agent.session);
					outcome = await runCommandLine(msg.content, opened.handle.agent, ctx.get("commands"), commandSignal(), ctx.get("agentPresets"), ctx.get("sessionPersistence"), msg.chatId, runtimeDeniedTools, scheduleRegistry, auditStats, config, sessionPresets, ctx.get("sessionQuery"), ctx.get("jobs"), ctx.get("messageFeedback"), lastAssistantIds.get(sessionId), ctx.get("tokenMeter"), ctx.get("skills"), ctx.get("agentDefaultModel"), {
						...config.provider === void 0 ? {} : { provider: config.provider },
						...config.model === void 0 ? {} : { model: config.model }
					}, ctx.get("workspaceRegistry"), await chatCwd(msg.chatId), loaderEntries(), getSyncContext(), ctx.get("tools"), (await compositionFor(sessionId)).toolScope, (await chatBindings())[msg.chatId] !== void 0, {
						llm: ctx.get("llm"),
						efforts: effortOverrides,
						ctx,
						sessionCwd: await chatCwd(msg.chatId),
						sessionCwdBound: (await chatBindings())[msg.chatId] !== void 0,
						sessionPreset: sessionPresets.get(sessionId)
					});
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					notify(`dsh-lark-bridge: command execution failed for chat ${msg.chatId}: ${detail}`);
					ctx.logger.warn("command execution failed for chat %s: %s", msg.chatId, error);
					try {
						const stack = error instanceof Error ? error.stack ?? error.message : String(error);
						appendFileSync("/tmp/dsh-session-crash.log", `[${(/* @__PURE__ */ new Date()).toISOString()}] chat=${msg.chatId} command=${msg.content}\n${stack}\n\n`);
					} catch {}
					await port.send(msg.chatId, { text: `⚠️ 命令执行失败：${detail}` }).catch(reportSendFailure);
					return;
				}
				if (sessionPresets.get(sessionId) !== presetBefore) compositions.delete(sessionId);
				if (outcome.reply !== "") await replay.send(binding.chatId, { markdown: outcome.reply }).catch(reportSendFailure);
				if (outcome.card !== void 0) await replay.send(binding.chatId, { card: outcome.card }).catch(reportSendFailure);
				return;
			}
			const busyPlan = busyDelivery(opened.handle.agent.status === "running", config.busyPolicy, opened.handle.agent);
			if (busyPlan.receipt !== "") replay.send(binding.chatId, { markdown: busyPlan.receipt }).catch(reportSendFailure);
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
				const prefix = await stage(msg.messageId, "briefing", async () => briefingPrefix(config.briefingFile, opened.handle.agent.session.id, notify));
				const quoted = await stage(msg.messageId, "quote", async () => {
					const parentId = msg.replyToMessageId;
					if (parentId === void 0 || parentId === "" || parentId === msg.messageId) return "";
					if (msg.threadId !== void 0 && parentId === msg.threadId) return "";
					const fetchOne = port.fetchMessage;
					if (typeof fetchOne !== "function") return "";
					try {
						return quotedPrefix(await fetchOne.call(port, parentId), config.limits.quoteChars, config.showMessageTime);
					} catch (error) {
						notify(`dsh-lark-bridge: quoted message ${parentId} unreadable: ${error instanceof Error ? error.message : String(error)}`);
						return "";
					}
				});
				const allNotes = [...fileNotes];
				const sentAt = config.showMessageTime ? messageTimeStamp(msg.createTime) : void 0;
				const gap = config.showMessageTime ? sessionGapPhrase(opened.handle.agent.session.id, Date.now()) : "";
				const spoken = [
					quoted,
					sentAt === void 0 ? msg.content : `${gap === "" ? `[${sentAt}]` : `[${sentAt} · 距上一轮 ${gap}]`}\n${msg.content}`,
					...allNotes
				].filter((part) => part !== "").join("\n");
				const turn = chatUserMessage({
					...msg,
					content: spoken
				}, images);
				let content = prefix === "" ? turn.content : Object.freeze([{
					type: "text",
					text: prefix
				}, ...turn.content]);
				const parkedInject = busyPlan.policy === "inject" && opened.handle.agent.status !== "running";
				if (parkedInject) notify(`dsh-lark-bridge: inject downgraded to followup for session ${opened.handle.agent.session.id} (turn closed before delivery)`);
				const delivery = parkedInject ? "queue" : busyPlan.policy;
				const message = {
					...turn,
					content
				};
				if (delivery === "steer") opened.handle.agent.steer?.(message);
				else if (delivery === "inject") opened.handle.agent.inject?.(message);
				else opened.handle.agent.followup(message);
			}
		} catch (error) {
			notify(`dsh-lark-bridge: agent creation failed for chat ${msg.chatId}: ${String(error)}`);
			ctx.logger.warn("agent creation failed for chat %s: %s", msg.chatId, error);
			const stack = error instanceof Error ? error.stack ?? error.message : String(error);
			try {
				appendFileSync("/tmp/dsh-session-crash.log", `[${(/* @__PURE__ */ new Date()).toISOString()}] chat=${msg.chatId}\n${stack}\n\n`);
			} catch {}
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
			sent = await rawPort.send(binding.chatId, { card: approvalCard(request.toolName, request.reason, command === void 0 ? void 0 : boundCardText(command, config.limits.approvalArgChars), id) });
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
	/**
	* The account-switcher card's buttons: fleet-single-writer (both ends
	* receive every click; only the arbitration-active endpoint acts), then
	* operator authorization, then the same switch/forget the text command
	* runs. The result lands as a toast plus a chat line — the stale card
	* stays behind, the line is the truth.
	*/
	const handleAccountCardAction = async (evt, acct) => {
		const syncCtx = getSyncContext();
		if (syncCtx === void 0) return { toast: {
			type: "error",
			content: "同步层未就绪，稍后再试"
		} };
		const arbitration = await arbitrationForInbound();
		if (arbitration !== null) {
			if (!isActiveEndpoint(arbitration, (await ensureDeviceId()).deviceId, syncCtx.form, syncCtx.profile)) return { toast: {
				type: "info",
				content: "本端为待命端，已忽略（活跃端处理中）"
			} };
		}
		const refusal = refuseMessage(authorization, {
			senderId: evt.operator.openId,
			chatId: evt.chatId,
			chatType: "p2p"
		});
		if (refusal !== void 0) {
			notify(`dsh-lark-bridge: rejected an account-card click: ${refusal}`);
			return { toast: {
				type: "error",
				content: "你无权切换账号"
			} };
		}
		const outcome = acct.act === "use" ? await accountUseByName(syncCtx, acct.name) : await accountForgetByName(syncCtx, acct.name);
		replay.send(evt.chatId, { markdown: outcome.text }).catch(reportSendFailure);
		return { toast: {
			type: outcome.ok ? "success" : "error",
			content: outcome.ok ? acct.act === "use" ? `已切换到 ${acct.name}，重启后生效` : `已删除 ${acct.name}` : "没有这个账号，见聊天里的提示"
		} };
	};
	const handleCardAction = (evt) => {
		const questionResponse = questions.handleCardAction(evt);
		if (questionResponse !== void 0) return questionResponse;
		const acct = accountCardValue(evt.action.value);
		if (acct !== void 0) {
			handleAccountCardAction(evt, acct);
			return { toast: {
				type: "info",
				content: "正在处理…"
			} };
		}
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
		handleMessage(msg).catch((error) => {
			const detail = error instanceof Error ? error.message : String(error);
			notify(`dsh-lark-bridge: inbound handler failed for ${msg.messageId}: ${detail}`);
			ctx.logger.warn("inbound handler failed for %s: %s", msg.messageId, error);
			reactions?.fail(msg.messageId);
		});
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
	let disconnectedAt;
	ctx.effect(() => replay.on("reconnecting", () => {
		replay.setConnected(false);
		disconnectedAt ??= Date.now();
		notify("dsh-lark-bridge: connection lost, reconnecting — outbound is queued and will replay once restored");
		ctx.logger.warn("connection lost, reconnecting");
	}), "dsh-lark-bridge:on(reconnecting)");
	ctx.effect(() => replay.on("reconnected", () => {
		replay.setConnected(true);
		notify("dsh-lark-bridge: connection restored");
		ctx.logger.info("connection restored");
		const gapStart = disconnectedAt;
		disconnectedAt = void 0;
		if (gapStart === void 0) return;
		const gapMs = Date.now() - gapStart;
		if (gapMs < 3e4) return;
		const notice = `⚠️ 连接中断了约 ${gapMs < 12e4 ? `${Math.round(gapMs / 1e3)} 秒` : `${Math.round(gapMs / 6e4)} 分钟`}——期间发来的消息飞书不会补送，重要指令请重发。`;
		for (const chatId of new Set([...bySession.values()].map((binding) => binding.chatId))) replay.send(chatId, { markdown: notice }).catch(reportSendFailure);
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
	/**
	* Host contract mirror: 0.1.5 delivers live assistant streaming through the
	* Agent-scoped `agent/assistant-stream` event. Older harnesses appended an
	* `assistant/chunk` session event instead, and 0.1.5 dropped that producer —
	* the type survives only in the session-format migrations, so a renderer
	* that waits for it renders no reasoning at all while the run looks healthy.
	*
	* The frame union carries `turn`/`step` on `start` and only the `chunk` on
	* each `chunk` frame, so the pair is tracked per attempt and folded back in
	* before handing the renderer the event shape it already consumes.
	*/
	const attemptSteps = /* @__PURE__ */ new Map();
	ctx.on("agent/assistant-stream", ({ agent, frame }) => {
		const sessionId = agent.session.id;
		const binding = bySession.get(sessionId);
		if (binding === void 0) return;
		const owner = agents.get(sessionId);
		if (owner !== void 0 && owner !== agent) return;
		if (frame.type === "end") {
			attemptSteps.delete(frame.attemptId);
			return;
		}
		if (frame.type === "start") {
			attemptSteps.set(frame.attemptId, {
				turn: frame.turn,
				step: frame.step
			});
			return;
		}
		const at = attemptSteps.get(frame.attemptId) ?? {
			turn: 0,
			step: 0
		};
		binding.renderer.handle({
			type: "assistant/chunk",
			data: {
				turn: at.turn,
				step: at.step,
				chunk: frame.chunk
			}
		});
	});
	ctx.on("session/event", (session, event) => {
		const binding = bySession.get(session.id);
		if (binding === void 0) {
			const childOf = childChat.get(session.id);
			if (childOf !== void 0) {
				noteChildSessionEvent(childOf, session.id, event);
				return;
			}
			if (isPresentedEvent(event) && config.presentBridge !== false) {
				const callId = event.data.callId;
				let seen = presentedCalls.get(session.id);
				if (seen === void 0) {
					seen = /* @__PURE__ */ new Set();
					presentedCalls.set(session.id, seen);
				}
				if (!seen.has(callId)) {
					seen.add(callId);
					for (const file of event.data.files) {
						const caption = file.description === void 0 || file.description === "" ? `交付文件 · turn ${event.data.turn}` : file.description;
						const seenChats = /* @__PURE__ */ new Set();
						for (const b2 of bySession.values()) {
							if (seenChats.has(b2.chatId)) continue;
							seenChats.add(b2.chatId);
							replay.send(b2.chatId, { markdown: `📎 另一会话声明了交付文件：\`${file.path}\`${caption === "" ? "" : ` · ${caption}`}\n（该会话不属于当前聊天，文件未能送达本聊天）` }).catch(() => {});
						}
					}
				}
				return;
			}
			const notable = isStepStartEvent(event) || isTurnEndEvent(event);
			const nowMs = Date.now();
			const last = externalMirrorAt.get(session.id);
			if (notable && (last === void 0 || nowMs - last >= 6e4)) {
				externalMirrorAt.set(session.id, nowMs);
				const turn = event.data.turn;
				const reason = event.data.reason?.kind;
				const label = isTurnEndEvent(event) ? `✅ T${turn ?? "?"} 完成（${reason ?? "?"}）` : `T${turn ?? "?"} 进行中`;
				const seenChats = /* @__PURE__ */ new Set();
				for (const b of bySession.values()) {
					if (seenChats.has(b.chatId)) continue;
					seenChats.add(b.chatId);
					replay.send(b.chatId, { markdown: `⚙️ [会话 ${session.id.slice(0, 8)}] ${label}` }).catch(() => {});
				}
			}
			return;
		}
		if (isTurnEndEvent(event)) {
			const panel = subagentTrackers.get(binding.chatId);
			if (panel !== void 0 && settleRunningOneShots(panel) > 0) flushSubagentCard(binding.chatId, panel, true).catch(reportSendFailure);
		}
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
		if (isSubagentCatalogEvent(event)) {
			childChat.set(event.data.childId, binding.chatId);
			if (config.announceSubagents !== false) {
				const label = event.data.label === void 0 || event.data.label.trim() === "" ? "未命名任务" : event.data.label.trim();
				replay.send(binding.chatId, { markdown: `🔀 派出子代理 · ${label}\n（进展会实时更新，完成后一并汇报）` }).catch(reportSendFailure);
			}
			upsertSubagent(binding.chatId, event.data.childId, {
				mode: event.data.mode,
				...event.data.label === void 0 ? {} : { label: event.data.label }
			}, true);
		}
		if (isTeamRelayMessageEvent(event)) noteTeamRelayMessage(binding.chatId, event);
		if (isTeamMemberEvent(event) || isTeamTaskEvent(event) || isTeamMessageEvent(event) || isTeamMessageDeliveredEvent(event)) {
			const teamId = event.data.teamId;
			let tracker = teamTrackers.get(binding.chatId);
			if (tracker === void 0 || tracker.state.teamId !== teamId) {
				tracker = { state: createTeamState(teamId) };
				teamTrackers.set(binding.chatId, tracker);
			}
			if (isTeamMemberEvent(event)) addTeamMember(tracker.state, event.data.member);
			else if (isTeamTaskEvent(event)) addTeamTask(tracker.state, event.data.task);
			else if (isTeamMessageEvent(event)) addTeamMessage(tracker.state, event.data.message);
			else markTeamMessageDelivered(tracker.state, event.data.messageId);
			flushTeamCard(binding.chatId, true).catch(reportSendFailure);
		}
		if (isPresentedEvent(event)) {
			if (config.presentBridge !== false) {
				const callId = event.data.callId;
				let seen = presentedCalls.get(session.id);
				if (seen === void 0) {
					seen = /* @__PURE__ */ new Set();
					presentedCalls.set(session.id, seen);
				}
				if (!seen.has(callId)) {
					seen.add(callId);
					(async () => {
						for (const file of event.data.files) {
							const caption = file.description === void 0 || file.description === "" ? `交付文件 · turn ${event.data.turn}` : file.description;
							try {
								await deliverDeclaredFile(session.id, file.path, caption);
							} catch (error) {
								const detail = error instanceof Error ? error.message : String(error);
								replay.send(binding.chatId, { markdown: `⚠️ 交付文件 \`${file.path}\` 未能送达：${detail}` }).catch(reportSendFailure);
							}
						}
					})();
				}
			}
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
			const sessionId = session.id;
			const byId = scheduleRegistry.get(sessionId) ?? /* @__PURE__ */ new Map();
			applyScheduleChange(byId, event.data);
			if (byId.size === 0) scheduleRegistry.delete(sessionId);
			else scheduleRegistry.set(sessionId, byId);
		}
		if (isWebSearchRequestEvent(event)) {
			const nowMs = Date.now();
			const last = lastSearchNoticeAt.get(binding.chatId);
			if (last === void 0 || nowMs - last >= 9e4) {
				lastSearchNoticeAt.set(binding.chatId, nowMs);
				replay.send(binding.chatId, { markdown: webSearchLine() }).catch(reportSendFailure);
			}
		}
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
//#region lib/types/form.js
/**
* Runtime form detection: which surface this plugin instance serves.
* @module dsh-lark-bridge/form
*/
/**
* Resolve this instance's form. `DSH_FORM` keeps its explicit override role
* (the WSL systemd unit sets it), but the Desktop 2.0.0 app hosts the harness
* inside its Electron main process and sets no DSH_* environment at all — the
* Electron runtime marker is the one signal that is always present there. A
* bare `dsh web` process stays the web form it always was.
*
* The profile default follows the form: the Desktop app manages a profile
* literally named `desktop`, so an instance that does not name one inherits
* the right profile instead of pretending to be `web`.
*/
function detectRuntimeForm() {
	const explicit = process.env.DSH_FORM;
	if (explicit === "desktop" || explicit === "web") return explicit;
	if (process.versions.electron !== void 0) return "desktop";
	return "web";
}
/** The profile an instance runs under when nothing names one explicitly. */
function defaultProfileFor(form) {
	return form === "desktop" ? "desktop" : "web";
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
* Every reaction call is bounded.
*
* Reactions are cosmetic — they tell the user the message landed. They must
* never be able to hold up the turn, and the carrier gives no deadline of its
* own. A stalled reaction call happens to sit BEFORE the first instrumented
* stage of the inbound handler, so when it hangs the message is acknowledged
* and then nothing happens at all: no reply, no error, no diagnostic.
*/
const REACTION_TIMEOUT_MS = 1e4;
/**
* Race a promise against a deadline.
* @param work - the carrier call to bound.
* @param ms - how long it may take before it is abandoned.
* @param what - name used in the timeout error.
* @returns the call's result, or a rejection at the deadline.
*/
function withDeadline(work, ms, what) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`dsh-lark-bridge: ${what} timed out after ${ms}ms`)), ms);
		timer.unref?.();
		work.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
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
		source: "dsh-lark-bridge",
		resolveSenderNames: true
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
			return await withDeadline(nativeAddReaction(messageId, emojiType), REACTION_TIMEOUT_MS, `addReaction(${emojiType})`);
		},
		async removeReaction(messageId, reactionId) {
			await withDeadline(nativeRemoveReaction(messageId, reactionId), REACTION_TIMEOUT_MS, "removeReaction");
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
		const port = internals.createPort(resolved, authorization);
		installBridge(ctx, resolved, port, internals.notify, authorization);
		scheduleRestartNotice(port, internals.notify);
	};
	/**
	* Dual-end sync layer: control API + peer heartbeat. Failures degrade to a
	* log line — a dead sync layer must never take the Feishu channel down.
	*/
	const startSyncLayer = (resolved) => {
		if (!active) return;
		const form = detectRuntimeForm();
		const profile = process.env.DSH_PROFILE ?? defaultProfileFor(form);
		const bridgeVersion = process.env.npm_package_version ?? JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version ?? "dev";
		const harnessHome = process.env.DSH_HOME ?? (process.env.HOME === void 0 ? void 0 : `${process.env.HOME}/.dsh`);
		const token = `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		let started = false;
		startControlApi({
			profile,
			form,
			bridgeVersion,
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
				manifestSnapshot().then((manifest) => heartbeat(selfEntry(form, profile, bridgeVersion, server.port, token, manifest), harnessHome)).catch(() => {});
			};
			publish();
			const timer = setInterval(publish, 15e3);
			timer.unref?.();
			const syncContext = {
				home: harnessHome,
				form,
				profile,
				bridgeVersion,
				controlPort: server.port,
				controlToken: token,
				harnessHome,
				credentials: resolved.appId !== void 0 && resolved.appSecret !== void 0 ? {
					appId: resolved.appId,
					appSecret: resolved.appSecret,
					...resolved.domain !== void 0 ? { domain: resolved.domain } : {}
				} : void 0
			};
			setSyncContext(syncContext);
			const renewPresenceTimer = setInterval(() => void Promise.resolve().then(() => bot_command_exports).then((m) => m.renewPresence(syncContext)).catch(() => {}), 6e4);
			renewPresenceTimer.unref?.();
			Promise.resolve().then(() => bot_command_exports).then((m) => m.renewPresence(syncContext)).catch(() => {});
			ctx.logger.info("dual-end sync layer up: profile=%s form=%s control=127.0.0.1:%s", profile, form, server.port);
			ctx.effect(() => () => {
				clearInterval(timer);
				clearInterval(renewPresenceTimer);
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
