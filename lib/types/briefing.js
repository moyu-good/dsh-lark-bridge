/**
 * Session-start briefing injection: prepend a situation file's contents to
 * the FIRST user message of each session (per process lifetime). This gives
 * every chat agent ambient situational awareness — who the user is, what is
 * in flight across the fleet — without trusting model cooperation to fetch it.
 *
 * Contract: read errors are logged and degrade to "no briefing"; the file is
 * small and re-read per injection so external refreshers are picked up live.
 */
import { readFileSync } from 'node:fs';
const briefedSessions = new Set();
export function briefingPrefix(file, sessionId, log) {
    if (!file)
        return '';
    const key = `${file}\u0000${sessionId}`;
    if (briefedSessions.has(key))
        return '';
    briefedSessions.add(key);
    try {
        const text = readFileSync(file, 'utf-8').trim();
        if (text === '')
            return '';
        return `[System briefing — auto-injected context]\n${text}\n[/System briefing]\n\n`;
    }
    catch (e) {
        log(`dsh-lark-bridge: briefing read failed: ${String(e)}`);
        return '';
    }
}
//# sourceMappingURL=briefing.js.map