/**
 * Fire-and-forget posting of accepted inbound messages to an external
 * chronicle ledger. Contract: the ledger is best-effort by design — a down or
 * slow endpoint must never delay, fail, or otherwise influence message
 * handling. The bridge does not await, retry, or queue: one POST attempt with
 * a short timeout, failures logged on the operator console.
 */
export const postChronicle = (endpoint, payload, log = () => { }) => {
    if (!endpoint)
        return;
    try {
        fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(3_000),
            keepalive: true,
        })
            .then((r) => {
            if (!r.ok)
                log(`dsh-lark-bridge: chronicle post failed: HTTP ${r.status}`);
        })
            .catch((e) => log(`dsh-lark-bridge: chronicle post failed: ${String(e)}`));
    }
    catch (e) {
        log(`dsh-lark-bridge: chronicle post failed: ${String(e)}`);
    }
};
//# sourceMappingURL=chronicle.js.map