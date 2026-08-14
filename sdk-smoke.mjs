#!/usr/bin/env node
/**
 * 对比测试：用 @larksuiteoapi/node-sdk 官方 createLarkChannel 连嘟嘟嘟
 * 与 opencode 桥完全相同的用法，验证事件是否能收到。
 */
import { createLarkChannel, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk'

const appId = process.argv[2]
const appSecret = process.argv[3]

console.log('[sdk-smoke] creating channel via node-sdk official createLarkChannel')
const channel = createLarkChannel({
  appId,
  appSecret,
  domain: Domain.Feishu,
  source: 'sdk-smoke-test',
  loggerLevel: LoggerLevel.info,
  policy: {
    dmMode: 'open',
    requireMention: false,
    respondToMentionAll: false,
  },
  safety: {
    chatQueue: { enabled: false },
  },
  includeRawEvent: true,
  outbound: {
    streamThrottleMs: 400,
  },
  wsConfig: {
    pingTimeout: 3,
  },
  handshakeTimeoutMs: 8000,
})

let connected = false
channel.on('reconnecting', () => console.log('[sdk-smoke] reconnecting…'))
channel.on('reconnected', () => {
  connected = true
  console.log('[sdk-smoke] reconnected ✓')
})
channel.on('error', (err) => console.error('[sdk-smoke] transport error:', err?.message || err))
channel.on('reject', (evt) => console.log('[sdk-smoke] rejected:', evt?.reason))

channel.on('message', (evt) => {
  console.log('[sdk-smoke] ⭐ MESSAGE RECEIVED:')
  console.log('  messageId:', evt.messageId)
  console.log('  chatId:', evt.chatId)
  console.log('  senderId:', evt.senderId)
  console.log('  content:', typeof evt.content === 'string' ? evt.content.slice(0, 200) : JSON.stringify(evt.content)?.slice(0, 200))
})

channel.connect()
  .then(() => {
    connected = true
    console.log('[sdk-smoke] WS connected ✓ (send a message to 嘟嘟嘟 now)')
  })
  .catch((err) => {
    console.error('[sdk-smoke] connect failed:', err?.message || err)
    process.exit(1)
  })

// 90 秒超时
setTimeout(() => {
  console.log('[sdk-smoke] timeout (90s), disconnecting')
  channel.disconnect().catch(() => {})
  process.exit(0)
}, 90000)
