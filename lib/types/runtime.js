/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module dsh-lark-bridge/runtime
 */
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLarkChannel, registerApp } from '@larksuite/channel';
import { Config, resolveConfig } from "./config.js";
import { installBridge } from "./bridge.js";
import { beginOnboarding } from "./onboarding.js";
import { describeAuthorization, resolveAuthorization } from "./authorization.js";
import { setSyncContext } from "./sync/bot-command.js";
import { readSettings } from "./sync/settings-store.js";
import { startControlApi } from "./sync/control-api.js";
import { heartbeat, selfEntry } from "./sync/peers.js";
/** The app-config endpoint for the bot's slash-command panel; the SDK has no method for it. */
const SLASH_COMMAND_API = '/open-apis/application/v7/app_slash_commands';
/**
 * The thinking-process endpoint: `POST` opens one, `PUT` appends events, and a
 * terminal `RUN_FINISHED` closes it without a further call.
 */
const COT_API = '/open-apis/im/v1/message_cot';
/** The user-settings namespace holding this plugin's section (onboarded credentials included). */
const SETTINGS_NAMESPACE = 'dsh-lark-bridge';
/**
 * Narrow a resolved configuration to one carrying live credentials.
 * @param config - resolved plugin configuration.
 * @returns whether both credential fields are non-empty strings.
 */
function hasCredentials(config) {
    return typeof config.appId === 'string' && config.appId !== ''
        && typeof config.appSecret === 'string' && config.appSecret !== '';
}
/**
 * Create the production Lark transport from resolved configuration.
 * @param config - resolved plugin configuration with credentials.
 * @returns the real `@larksuite/channel` client behind the bridge's port surface.
 */
export function createLarkChannelPort(config, authorization) {
    // Transport-level defense in depth. The plugin's own inbound check is the
    // authority (it runs where the agent is driven), but leaving the transport at
    // its `dmMode: 'open'` default would let unauthorized traffic reach this
    // process at all — and an allowlist the transport enforces never depends on
    // this plugin's handler being reached.
    const policy = { requireMention: config.requireMention };
    // Only narrow when a deployment asked to. Who may open a conversation with
    // the bot at all is the app's visibility scope, set in the developer console;
    // restricting again here by default would duplicate that decision.
    if (authorization.directSenders.size > 0) {
        policy.dmMode = 'allowlist';
        policy.dmAllowlist = [...authorization.directSenders];
    }
    if (config.groupAllowlist.length > 0)
        policy.groupAllowlist = config.groupAllowlist;
    const options = {
        appId: config.appId,
        appSecret: config.appSecret,
        policy,
        source: 'dsh-lark-bridge',
    };
    if (config.domain !== undefined)
        options.domain = config.domain;
    // Local file delivery is default-deny at the transport: a filesystem-path
    // file source (e.g. a generated HTML file) is rejected unless the operator
    // allowed its directory via `outbound.allowedFileDirs`. Pass the resolved
    // allowlist through so `send_file` actually works for generated artifacts.
    if (config.outbound?.allowedFileDirs !== undefined) {
        options.outbound = { allowedFileDirs: config.outbound.allowedFileDirs };
    }
    // App-level keepalive watchdog: the SDK pings, but a connection that looks
    // alive while quietly stuck (half-open socket, zombie network) otherwise
    // sits silent forever. The watchdog probes and force-reconnects; only an
    // unrecoverable state fires the callback, so a chat that cannot reach the
    // bot has a paper trail instead of silence.
    options.keepalive = {
        enabled: true,
        intervalMs: 15_000,
        onUnrecoverable: (error) => {
            const detail = error instanceof Error ? error.message : String(error);
            process.stderr.write(`dsh-lark-bridge: connection unrecoverable — restarting the process is likely needed: ${detail}\n`);
        },
    };
    const channel = createLarkChannel(options);
    // The transport's own reaction methods must be captured BEFORE the
    // Object.assign below shadows them with the port wrappers: a wrapper whose
    // body references `channel.addReaction` would otherwise resolve to ITSELF
    // after the assign, recursing until the stack blows.
    const nativeAddReaction = channel.addReaction.bind(channel);
    const nativeRemoveReaction = channel.removeReaction.bind(channel);
    // The slash-command panel has no SDK method; it is a plain app-config API,
    // reached through the transport's own authenticated client.
    const raw = channel.rawClient;
    return Object.assign(channel, {
        async listSlashCommands() {
            // The collection route requires a paging query; without one it 404s.
            const response = await raw.request({
                method: 'GET',
                url: `${SLASH_COMMAND_API}?page_size=50`,
            });
            return (response.data?.items ?? [])
                .filter((item) => typeof item.command === 'string' && typeof item.command_id === 'string')
                .map(item => ({
                command: item.command,
                commandId: item.command_id,
                ...item.description?.default_value === undefined ? {} : { description: item.description.default_value },
            }));
        },
        async deleteSlashCommand(commandId) {
            await raw.request({ method: 'DELETE', url: `${SLASH_COMMAND_API}/${commandId}` });
        },
        async createCot(chatId, options) {
            const response = await raw.request({
                method: 'POST',
                url: `${COT_API}?receive_id_type=chat_id`,
                data: {
                    receive_id: chatId,
                    ...options.replyTo === undefined ? {} : { origin_message_id: options.replyTo },
                    cot_hidden: options.hidden,
                    // A thinking process is not news: it must not raise an unread badge
                    // or pull the conversation to the top of the list on every turn.
                    enable_badge: false,
                    update_feed_rank: false,
                },
            });
            const cotId = response.data?.cot_id;
            const messageId = response.data?.message_id;
            if (cotId === undefined || messageId === undefined) {
                throw new Error('dsh-lark-bridge: the platform returned no cot_id/message_id');
            }
            return { cotId, messageId };
        },
        async writeCotEvents(handle, events) {
            await raw.request({
                method: 'PUT',
                url: COT_API,
                data: { events, message_id: handle.messageId, cot_id: handle.cotId },
            });
        },
        async createSlashCommand(command, description) {
            await raw.request({
                method: 'POST',
                url: SLASH_COMMAND_API,
                data: { command, description: { default_value: description } },
            });
        },
        async addReaction(messageId, emojiType) {
            // The channel's own addReaction must be captured BEFORE Object.assign
            // overwrites it with this wrapper — referencing `channel.addReaction`
            // here after the assign resolves to this method itself and recurses
            // until the stack blows.
            return await nativeAddReaction(messageId, emojiType);
        },
        async removeReaction(messageId, reactionId) {
            await nativeRemoveReaction(messageId, reactionId);
        },
    });
}
/** Substitutable production boundaries; tests replace them with fakes. */
export const internals = {
    createPort: createLarkChannelPort,
    registerApp,
    notify: (line) => void process.stderr.write(`${line}\n`),
};
/**
 * Apply the plugin to its Cordis context. With credentials configured (entry
 * config or a stored settings section) the transport connects directly;
 * without them the official QR registration flow runs first and persists the
 * scanned credentials through the host `settings` service when one is composed.
 * @param ctx - Scoped plugin context; requires the `agents` service.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx, config) {
    let active = true;
    let started = false;
    ctx.effect(() => () => { active = false; }, 'dsh-lark-bridge:lifetime');
    /**
     * Install the bridge once credentials are known, stating this channel's reach
     * on the console: who it serves is a security fact its operator must see, and
     * a groups-only channel (no owner configured yet) is a valid deployment.
     */
    const start = (resolved) => {
        if (!active || started)
            return;
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
        if (!active)
            return;
        const form = process.env.DSH_FORM === 'desktop' ? 'desktop' : 'web';
        const profile = process.env.DSH_PROFILE ?? 'web';
        // Under systemd the process is launched bare (`node .../bin.js`), so
        // npm_package_version is unset there — read the bridge's own manifest
        // instead, which is true in both npm-script and bare-process launches.
        const bridgeVersion = process.env.npm_package_version
            ?? JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version
            ?? 'dev';
        const harnessHome = process.env.DSH_HOME
            ?? (process.env.HOME === undefined ? undefined : `${process.env.HOME}/.dsh`);
        const token = `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        let started = false;
        void startControlApi({
            profile,
            form,
            bridgeVersion,
            manifest: () => import("./sync/profile-manifest.js").then((m) => m.readProfileManifest(harnessHome ?? `${os.homedir()}/.dsh`, profile)),
        }, token, resolved.controlPort).then((server) => {
            if (!active) {
                void server.close();
                return;
            }
            started = true;
            const manifestSnapshot = () => import("./sync/profile-manifest.js").then(async (m) => {
                const read = await m.readProfileManifest(harnessHome ?? `${os.homedir()}/.dsh`, profile);
                return read === null ? undefined : { profile: read.profile, dependencies: read.dependencies, bundles: read.bundles };
            }).catch(() => undefined);
            const publish = () => {
                void manifestSnapshot().then((manifest) => heartbeat(selfEntry(form, profile, bridgeVersion, server.port, token, manifest), harnessHome)).catch(() => { });
            };
            publish();
            const timer = setInterval(publish, 15_000);
            timer.unref?.();
            setSyncContext({
                home: harnessHome,
                form,
                profile,
                bridgeVersion,
                controlPort: server.port,
                controlToken: token,
                harnessHome,
                credentials: resolved.appId !== undefined && resolved.appSecret !== undefined
                    ? { appId: resolved.appId, appSecret: resolved.appSecret, ...(resolved.domain !== undefined ? { domain: resolved.domain } : {}) }
                    : undefined,
            });
            ctx.logger.info('dual-end sync layer up: profile=%s form=%s control=127.0.0.1:%s', profile, form, server.port);
            ctx.effect(() => () => {
                clearInterval(timer);
                void server.close();
            }, 'dsh-lark-bridge:sync-lifetime');
        }).catch((error) => {
            ctx.logger.error('dual-end sync layer failed to start (channel unaffected): %s', error instanceof Error ? error.message : error);
        });
        if (!started)
            return;
    };
    const bootstrap = async () => {
        // Loader siblings mount concurrently; whether the optional settings
        // service exists is only decided once the application settles.
        await ctx.get('loader')?.await();
        if (!active)
            return;
        let resolved = resolveConfig(config);
        let persist = async (_app) => false;
        const settings = ctx.get('settings');
        if (settings !== undefined) {
            try {
                const scope = settings.register(SETTINGS_NAMESPACE, Config, { base: config });
                resolved = resolveConfig(scope.get());
                persist = async (credentials) => {
                    await scope.update(credentials);
                    return true;
                };
            }
            catch (error) {
                ctx.logger.error('settings registration failed; continuing with entry config only: %s', error instanceof Error ? error.message : error);
            }
        }
        // Cross-profile overlay (dual-end sync): the shared settings file is what
        // the operator last touched from EITHER form, so it wins per key over the
        // profile injection and the host settings scope. Credentials are honored
        // too - an operator who sets them via /bot set intends both ends to adopt
        // them; running two bridges on ONE Feishu app double-delivers events,
        // which is the operator's explicit choice, not ours.
        try {
            const shared = await readSettings();
            const touched = Object.keys(shared).length;
            if (touched > 0) {
                resolved = resolveConfig({ ...resolved, ...shared });
                ctx.logger.info('dual-end sync: %d shared key(s) overlaid onto the boot config', touched);
            }
        }
        catch (error) {
            ctx.logger.error('dual-end sync: shared settings overlay failed: %s', error instanceof Error ? error.message : error);
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
            onCredentials: app => { start({ ...base, ...app }); },
            appId: resolved.appId,
            ...internals.reissueFloorMs === undefined ? {} : { reissueFloorMs: internals.reissueFloorMs },
        });
    };
    void bootstrap().catch((error) => {
        ctx.logger.error('dsh-lark-bridge bootstrap failed: %s', error instanceof Error ? error.message : error);
    });
}
//# sourceMappingURL=runtime.js.map