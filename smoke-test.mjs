#!/usr/bin/env node
/**
 * dsh-lark-bridge smoke test — verifies the WS long connection + message round-trip
 * WITHOUT starting a full dsh agent (fast, low-footprint).
 *
 * Usage: node smoke-test.mjs <appId> <appSecret>
 * Prints connection status, waits for one inbound message, echoes it back.
 */
import { createLarkChannel } from '@larksuite/channel'

const appId = process.argv[2]
const appSecret = process.argv[3]
if (!appId || !appSecret) {
  console.error('usage: node smoke-test.mjs <appId> <appSecret>')
  process.exit(2)
}

console.log('[smoke] creating channel appId=%s', appId)
const channel = createLarkChannel({
  appId,
  appSecret,
  policy: { requireMention: false, dmMode: 'open' },
  source: 'dsh-lark-bridge-smoke',
})

let connected = false
channel.on('reconnecting', () => console.log('[smoke] reconnecting…'))
channel.on('reconnected', () => {
  connected = true
  console.log('[smoke] reconnected ✓')
})
channel.on('error', (err) => console.error('[smoke] transport error:', err))
channel.on('reject', (evt) => console.log('[smoke] rejected:', evt.reason))

channel.on('message', async (evt) => {
  console.log('[smoke] message received:')
  console.log('  messageId:', evt.messageId)
  console.log('  chatId:', evt.chatId)
  console.log('  chatType:', evt.chatType)
  console.log('  senderId:', evt.senderId)
  console.log('  contentType:', evt.rawContentType)
  console.log('  content:', String(evt.content).slice(0, 200))
  console.log('  mentionedBot:', evt.mentionedBot)
  if (evt.rawContentType === 'text') {
    try {
      const parsed = JSON.parse(evt.content)
      await channel.send(evt.chatId, { text: `[smoke-echo] ${parsed.text ?? ''}` })
      console.log('[smoke] echo sent ✓')
    } catch (e) {
      console.error('[smoke] send failed:', e)
    }
  }
})

try {
  await channel.connect()
  connected = true
  console.log('[smoke] WS connected ✓  (send a text message to the bot now)')
} catch (e) {
  console.error('[smoke] connect failed:', e)
  process.exit(1)
}

// Keep alive 120s then exit.
setTimeout(async () => {
  console.log('[smoke] timeout, disconnecting')
  await channel.disconnect()
  process.exit(0)
}, 120_000)
