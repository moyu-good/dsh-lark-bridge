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
import qrcode from 'qrcode-terminal';
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
    source: 'dsh-lark-bridge',
    appPreset: {
        name: 'DSH Agent',
        desc: 'DSH 会话机器人',
    },
};
/** The rejection code the flow reports when nobody scanned before the code expired. */
const EXPIRED_CODE = 'expired_token';
/**
 * Shortest gap between two issued codes.
 *
 * A code that ran its course already took its full validity window, so this
 * never delays a real re-issue. It bounds the one case that would otherwise
 * spin: a platform that reports a code expired the moment it is issued.
 */
const REISSUE_FLOOR_MS = 60_000;
/**
 * Read the flow's own rejection code.
 * @param error - the rejection value, of any shape.
 * @returns the code, or undefined for a rejection that carries none.
 */
function rejectionCode(error) {
    if (typeof error !== 'object' || error === null || !('code' in error))
        return undefined;
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
}
/**
 * Render one rejection as an operator-readable reason.
 * @param error - the rejection value, which is usually neither an `Error` nor a string.
 * @returns the message, the `code: description` pair, or the stringified value.
 */
function rejectionDetail(error) {
    if (error instanceof Error)
        return error.message;
    const code = rejectionCode(error);
    if (code === undefined)
        return String(error);
    const { description } = error;
    return typeof description === 'string' ? `${code}: ${description}` : code;
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
            qrcode.generate(url, { small: true }, (drawn) => { resolve(drawn); });
        }
        catch {
            // Showing the URL alone still completes registration; the drawing is a
            // convenience for whoever has a phone rather than a logged-in browser.
            resolve(undefined);
        }
    });
}
/** Sleep, resolving early when the flow unwinds. */
async function delay(ms, signal) {
    if (ms <= 0 || signal.aborted)
        return;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            resolve();
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * Start the QR onboarding flow as a fiber-owned effect. The pending scan is
 * withdrawn on disposal; a completed scan persists first, then hands the
 * credentials to `onCredentials` unless the fiber already unwound. An expired
 * code is replaced by a fresh one for as long as this fiber lives.
 * @param run - the surfaces to drive and the sinks to report through.
 */
export function beginOnboarding(run) {
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
            ...appId === undefined || appId === '' ? {} : { appId },
            signal,
            onQRCodeReady({ url, expireIn }) {
                const minutes = String(Math.round(expireIn / 60));
                announce(round === 0
                    ? `dsh-lark-bridge: 未配置应用凭证。用飞书扫下面的二维码创建应用（或在已登录飞书的浏览器打开链接），${minutes} 分钟内有效：`
                    : `dsh-lark-bridge: 上一个二维码已过期，这是第 ${String(round + 1)} 个，同样 ${minutes} 分钟内有效：`);
                void drawQrCode(url).then((drawn) => {
                    if (signal.aborted)
                        return;
                    // The drawing goes to the console alone: it is 29 lines of block
                    // characters, and the logger already carries the URL that identifies
                    // this code.
                    if (drawn !== undefined)
                        notify(`\n${drawn}`);
                    announce(`  ${url}\n`);
                });
            },
        });
        void (async () => {
            for (let round = 0; !signal.aborted; round++) {
                const startedAt = Date.now();
                let result;
                try {
                    result = await issue(round);
                }
                catch (error) {
                    if (signal.aborted)
                        return;
                    if (rejectionCode(error) !== EXPIRED_CODE) {
                        announce(`dsh-lark-bridge: 应用注册失败：${rejectionDetail(error)}（重启进程可重新发起）`);
                        return;
                    }
                    await delay(floorMs - (Date.now() - startedAt), signal);
                    continue;
                }
                if (signal.aborted)
                    return;
                const scanned = result.user_info?.open_id;
                const credentials = {
                    appId: result.client_id,
                    appSecret: result.client_secret,
                    ...scanned === undefined || scanned === '' ? {} : { registeredBy: scanned },
                };
                const persisted = await persist(credentials).catch((error) => {
                    announce(`dsh-lark-bridge: 凭证持久化失败：${rejectionDetail(error)}`);
                    return false;
                });
                if (signal.aborted)
                    return;
                announce(persisted
                    ? `dsh-lark-bridge: 应用 ${credentials.appId} 注册成功，凭证已写入用户设置。`
                        + (credentials.registeredBy === undefined
                            ? ''
                            : ` 注册者：${credentials.registeredBy}（需要收窄时可填入 senderAllowlist / approvers）。`)
                    : `dsh-lark-bridge: 应用 ${credentials.appId} 注册成功，但当前组合没有 settings 存储——`
                        + '凭证仅本次进程有效。要跨重启保留，请设置 LARK_APP_ID/LARK_APP_SECRET。');
                onCredentials(credentials);
                return;
            }
        })().catch((error) => {
            if (signal.aborted)
                return;
            announce(`dsh-lark-bridge: 应用注册失败：${rejectionDetail(error)}（重启进程可重新发起）`);
        });
        return () => { controller.abort(); };
    }, 'dsh-lark-bridge:onboarding');
}
//# sourceMappingURL=onboarding.js.map