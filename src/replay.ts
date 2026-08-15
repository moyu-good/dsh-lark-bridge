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

import type { OutboundPort } from './outbound.ts'
import type { MarkdownStreamController, SendInput, SendOptions, SendResult } from '@larksuite/channel'

/**
 * The transport surface {@link createReplayPort} wraps: outbound chat sends
 * plus the lifecycle the wrapper must not swallow. `on` stays the underlying
 * transport's (the wrapper adds no inbound events), and connect/disconnect
 * pass through so the caller drives the real connection.
 */
export interface ReplayPort extends OutboundPort {
  updateCard(messageId: string, card: object): Promise<void>
  connect(): Promise<void>
  disconnect(): Promise<void>
  on(name: string, handler: (...args: never[]) => unknown): () => void
}

/** The stream call's input shape, matching {@link OutboundPort.stream}. */
interface StreamInput {
  markdown: (controller: MarkdownStreamController) => Promise<void>
}

/** One queued outbound call, in the order the caller issued it. */
interface QueuedCall {
  readonly kind: 'send' | 'stream' | 'updateCard'
  readonly to?: string
  readonly input?: SendInput | StreamInput
  readonly opts?: SendOptions
  readonly messageId?: string
  readonly card?: object
}

/** The transport surface {@link createReplayPort} wraps. */
export interface ReplayPort extends OutboundPort {
  updateCard(messageId: string, card: object): Promise<void>
}

/** A replay-enabled transport: the wrapped port plus the connection-state hook. */
export interface ReplayAwarePort extends ReplayPort {
  /** Tell the wrapper the connection state changed. `true` = live, `false` = down. */
  setConnected(live: boolean): void
  /** How many calls are queued waiting for a live connection. */
  pending(): number
}

/**
 * Wrap a transport so outbound calls survive a connection gap.
 * @param port - the underlying transport.
 * @param onFlushFailure - report one queued call that failed to re-send.
 * @param notify - operator console line for queue lifecycle.
 * @returns the replay-aware port.
 */
export function createReplayPort(
  port: ReplayPort,
  onFlushFailure: (error: unknown) => void,
  notify: (line: string) => void,
): ReplayAwarePort {
  let live = true
  let queue: QueuedCall[] = []
  let flushing: Promise<void> | undefined

  const queuedSendResult = (): SendResult => ({ messageId: `queued-${queue.length}` })

  const enqueueSend = (to: string, input: SendInput, opts: SendOptions | undefined): SendResult => {
    queue.push({ kind: 'send', to, input, ...opts === undefined ? {} : { opts } })
    return queuedSendResult()
  }
  const enqueueStream = (to: string, input: StreamInput, opts: SendOptions | undefined): SendResult => {
    queue.push({ kind: 'stream', to, input, ...opts === undefined ? {} : { opts } })
    return queuedSendResult()
  }
  const enqueueUpdate = (messageId: string, card: object): void => {
    queue.push({ kind: 'updateCard', messageId, card })
  }

  const flush = async (): Promise<void> => {
    if (!live || flushing !== undefined || queue.length === 0) return
    flushing = (async () => {
      const batch = queue
      queue = []
      notify(`dsh-lark-bridge: replaying ${batch.length} queued message(s) after reconnect`)
      for (const call of batch) {
        try {
          switch (call.kind) {
            case 'send':
              await port.send(call.to!, call.input as SendInput, call.opts)
              break
            case 'stream':
              await port.stream(call.to!, call.input as StreamInput, call.opts)
              break
            case 'updateCard':
              await port.updateCard(call.messageId!, call.card!)
              break
          }
        } catch (error) {
          // A call that still fails stays queued for the next live window;
          // the caller sees nothing (fire-and-forget), so only the console does.
          onFlushFailure(error)
          queue.push(call)
        }
      }
    })().finally(() => { flushing = undefined })
    await flushing
  }

  const wrapped: ReplayAwarePort = {
    ...bindPortMethods(port) as unknown as Pick<ReplayAwarePort, 'connect' | 'disconnect' | 'on'>,
    async send(to, input, opts) {
      if (!live) return enqueueSend(to, input, opts)
      try {
        return await port.send(to, input, opts)
      } catch (error) {
        onFlushFailure(error)
        return enqueueSend(to, input, opts)
      }
    },
    async stream(to, input, opts) {
      if (!live) return enqueueStream(to, input, opts)
      try {
        return await port.stream(to, input, opts)
      } catch (error) {
        onFlushFailure(error)
        return enqueueStream(to, input, opts)
      }
    },
    async updateCard(messageId, card) {
      if (!live) {
        enqueueUpdate(messageId, card)
        return
      }
      try {
        await port.updateCard(messageId, card)
      } catch (error) {
        onFlushFailure(error)
        enqueueUpdate(messageId, card)
      }
    },
    setConnected(next: boolean) {
      live = next
      if (next) void flush().catch(onFlushFailure)
    },
    pending: () => queue.length,
  }
  return wrapped as unknown as ReplayAwarePort
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
function bindPortMethods(port: ReplayPort): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(port)) {
    const value = (port as unknown as Record<string, unknown>)[key]
    copy[key] = typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(port) : value
  }
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(port))) {
    if (key === 'constructor') continue
    const value = (port as unknown as Record<string, unknown>)[key]
    if (typeof value === 'function') copy[key] = (value as (...args: never[]) => unknown).bind(port)
  }
  return copy
}
