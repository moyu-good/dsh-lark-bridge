/**
 * The `/bot` command: bridge identity, cross-form settings, and plugin sync —
 * the chat-facing surface of the dual-end sync feature (see
 * docs/design/设计卡_双端设置与同步.md). Text-first, matching the bridge's
 * other control commands; every mutating subcommand echoes masked secrets.
 * @module dsh-lark-bridge/sync/bot-command
 */
import { exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { maskSecret, readSettings, updateSettings, SHARED_KEYS } from "./settings-store.js";
import { heartbeat, listPeers, selfEntry, PEER_TTL_MS } from "./peers.js";
import { readProfileManifest } from "./profile-manifest.js";
import { buildSyncPlan, applySyncPlan } from "./plugin-sync.js";
import { fetchPeerManifest } from "./control-api.js";
let activeContext;
/**
 * Publish the runtime-built sync context. The bridge's command dispatcher
 * reads it via {@link getSyncContext}; the module-singleton pattern matches
 * `setRestartScheduler` in commands.ts.
 */
export function setSyncContext(context) {
    activeContext = context;
}
/** The runtime-published sync context, when the runtime wired one. */
export function getSyncContext() {
    return activeContext;
}
/** The subcommands `/bot` accepts. */
const SUBCOMMANDS = new Set(['set', 'unset', 'peers', 'sync-plugins']);
/**
 * Handle `/bot [subcommand …]`. Returns the reply for the chat; every secret
 * is masked before it leaves this module.
 */
export async function runBotCommand(line, ctx) {
    const arg = line.slice(1 + 'bot'.length).trim();
    const [sub, ...rest] = arg.split(/\s+/);
    const subcommand = sub ?? '';
    if (subcommand === '')
        return statusReply(ctx);
    if (subcommand === 'set')
        return setReply(ctx, rest);
    if (subcommand === 'unset')
        return unsetReply(ctx, rest);
    if (subcommand === 'peers')
        return peersReply(ctx);
    if (subcommand === 'sync-plugins')
        return syncPluginsReply(ctx, rest);
    return {
        reply: `⚠️ 未知子命令 \`${subcommand}\`。可用：${[...SUBCOMMANDS].map((s) => `\`${s}\``).join(' / ')}（无参数 = 状态面板）`,
        resolved: false,
    };
}
async function statusReply(ctx) {
    const peers = await listPeers(ctx.home);
    const settings = await readSettings(ctx.home);
    const sharedKeys = Object.keys(settings);
    const peerRows = peers.length === 0
        ? '（无其他端在线——对端桥未运行或未装本插件）'
        : peers.map((p) => {
            const age = Math.round((Date.now() - p.ts) / 1000);
            return `- **${p.profile}**（${p.form}）v${p.bridgeVersion} @ ${p.host}${p.port === undefined ? '' : ` :${p.port}`}（心跳 ${age}s 前）`;
        }).join('\n');
    const settingRows = sharedKeys.length === 0
        ? '（共享设置为空——双端配置尚未建立）'
        : sharedKeys.map((key) => {
            const value = settings[key] ?? '';
            const masked = key.toLowerCase().includes('secret') || key.toLowerCase().includes('appid')
                ? maskSecret(value)
                : value;
            return `- ${key}: \`${masked}\``;
        }).join('\n');
    return {
        reply: [
            `**桥 · 双端状态**`,
            `- 本端：**${ctx.profile}**（${ctx.form}）v${ctx.bridgeVersion}`,
            `- 在线对端（${PEER_TTL_MS / 1000}s 心跳窗口）：`,
            peerRows,
            `- 共享设置（${syncDirHint()}）：`,
            settingRows,
            '',
            '子命令：`/bot set <key> <value>` / `/bot unset <key>` / `/bot peers` / `/bot sync-plugins [apply]`',
        ].join('\n'),
        resolved: true,
    };
}
async function setReply(ctx, rest) {
    const [key, value] = [rest[0], rest.slice(1).join(' ')];
    if (key === undefined || value === '') {
        return {
            reply: `⚠️ 格式：\`/bot set <key> <value>\`。可设键：${SHARED_KEYS.map((k) => `\`${k}\``).join(' / ')}`,
            resolved: false,
        };
    }
    if (!isSharedKey(key)) {
        return { reply: `⚠️ \` ${key} \` 不是可共享键。可用：${SHARED_KEYS.map((k) => `\`${k}\``).join(' / ')}`, resolved: false };
    }
    const next = await updateSettings(ctx.home, (current) => ({ ...current, [key]: value }));
    const transport = key === 'appId' || key === 'appSecret' || key === 'domain';
    const echo = key.toLowerCase().includes('secret') || key.toLowerCase().includes('appid')
        ? maskSecret(value)
        : value;
    return {
        reply: [
            `✅ \`${key}\` 已写入共享设置（\`${echo}\`）。`,
            transport
                ? '⚠️ 该字段影响飞书连接——两端桥在下次重启/重连后生效。'
                : '其他端在下次读取时自动生效。',
            `当前共 ${Object.keys(next).length} 个共享键。`,
        ].join('\n'),
        resolved: true,
    };
}
async function unsetReply(ctx, rest) {
    const key = rest[0];
    if (key === undefined || !isSharedKey(key)) {
        return { reply: `⚠️ 格式：\`/bot unset <key>\`。可用：${SHARED_KEYS.map((k) => `\`${k}\``).join(' / ')}`, resolved: false };
    }
    await updateSettings(ctx.home, (current) => {
        if (!(key in current))
            return undefined;
        const next = { ...current };
        delete next[key];
        return next;
    });
    return { reply: `✅ \`${key}\` 已从共享设置移除（本端 profile 注入值将重新生效）。`, resolved: true };
}
async function peersReply(ctx) {
    const mine = selfEntry(ctx.form, ctx.profile, ctx.bridgeVersion, ctx.controlPort, ctx.controlToken);
    const peers = await heartbeat(mine, ctx.home);
    if (peers.length === 0) {
        return { reply: '**在线对端**：无。对端装桥并运行后，30s 内会出现在这里。', resolved: true };
    }
    const rows = peers.map((p) => `- **${p.profile}**（${p.form}）v${p.bridgeVersion} @ ${p.host}${p.port === undefined ? '' : ` :${p.port}`}${p.token === undefined ? '' : ' 🔑'}`);
    return { reply: `**在线对端**\n${rows.join('\n')}`, resolved: true };
}
async function syncPluginsReply(ctx, rest) {
    const apply = rest.includes('apply');
    const mine = selfEntry(ctx.form, ctx.profile, ctx.bridgeVersion, ctx.controlPort, ctx.controlToken);
    const peers = await heartbeat(mine, ctx.home);
    const peer = peers.find((p) => p.manifest !== undefined)
        ?? peers.find((p) => p.port !== undefined && p.token !== undefined)
        ?? peers[0];
    if (peer === undefined) {
        return { reply: '⚠️ 无在线对端可同步。对端桥需运行且通过心跳互见。', resolved: false };
    }
    // Manifest travels in-band with the heartbeat; the control API is the
    // fallback for older peers that only expose the endpoint.
    let there = peer.manifest === undefined
        ? null
        : { ...peer.manifest, mtimeMs: peer.ts };
    if (there === null) {
        if (peer.port === undefined || peer.token === undefined) {
            return { reply: `⚠️ 对端 **${peer.profile}** 既无带内清单也未暴露 control API，无法同步。`, resolved: false };
        }
        there = await fetchPeerManifest(peer.port, peer.token);
    }
    if (there === null) {
        return { reply: `⚠️ 对端 **${peer.profile}** 的 control API 不可达（:${peer.port}）。`, resolved: false };
    }
    const here = await readProfileManifest(ctx.harnessHome ?? defaultHarnessHome(), ctx.profile);
    if (here === null) {
        return { reply: `⚠️ 本端 profile \`${ctx.profile}\` 的 package.json 不存在于 ${ctx.harnessHome ?? '~/.dsh'}。`, resolved: false };
    }
    const plan = buildSyncPlan(here, there);
    if (plan.steps.length === 0) {
        return { reply: `✅ 与 **${peer.profile}** 的插件清单已一致（共享 ${plan.inSync.length} 个包）。`, resolved: true };
    }
    const stepRows = plan.steps.map((step) => step.kind === 'add'
        ? `- 安装 \`${step.spec}\`（\`${step.command}\`）`
        : `- 启用 bundle \`${step.bundle}\`（已装未启用——需人工确认）`);
    if (!apply) {
        return {
            reply: [
                `**同步预览（dry-run）**：从 **${peer.profile}** 采纳 ${plan.steps.length} 项变更：`,
                ...stepRows,
                '',
                `确认执行请发：\`/bot sync-plugins apply\``,
            ].join('\n'),
            resolved: true,
        };
    }
    const runner = ctx.runCommand ?? defaultRunner;
    const result = await applySyncPlan(plan, runner);
    const lines = [
        `**同步执行完毕**：成功 ${result.ran.length}，跳过 ${result.skipped.length}，失败 ${result.failures.length}`,
        ...result.ran.map((s) => `✅ ${s.spec}`),
        ...result.skipped.map((s) => `⏸ \`${s.bundle}\`（已装未启用，请人工确认）`),
        ...result.failures.map((f) => `⚠️ ${f.step.spec}：${f.error}`),
    ];
    return { reply: lines.join('\n'), resolved: true };
}
function isSharedKey(key) {
    return SHARED_KEYS.includes(key);
}
function syncDirHint() {
    return '`~/.dsh/dsh-lark-bridge/settings.json`';
}
function defaultHarnessHome() {
    return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}
/** Production runner: upstream CLI, 2-minute ceiling per package. */
const defaultRunner = (command) => new Promise((resolve, reject) => {
    exec(command, { timeout: 120_000 }, (error) => {
        if (error !== null)
            reject(error);
        else
            resolve();
    });
});
//# sourceMappingURL=bot-command.js.map