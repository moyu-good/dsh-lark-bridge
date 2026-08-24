/**
 * Fire-and-forget posting of accepted inbound messages to an external
 * chronicle ledger. Contract: the ledger is best-effort by design — a down or
 * slow endpoint must never delay, fail, or otherwise influence message
 * handling. The bridge does not await, retry, or queue: one POST attempt with
 * a short timeout, failures logged on the operator console.
 */
export type ChroniclePayload = {
    /** Who served this message (deployment-chosen channel name). */
    source: string;
    /** The user-visible text of the message. */
    text: string;
    /** Chat the message arrived in, when known (`oc_…`). */
    chatId?: string;
};
export declare const postChronicle: (endpoint: string | undefined, payload: ChroniclePayload, log?: (line: string) => void) => void;
//# sourceMappingURL=chronicle.d.ts.map