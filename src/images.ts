/**
 * Images a chat message carried. Sending a screenshot is how someone shows a
 * problem, so an image the model never receives is worse than a missing
 * feature: the model answers as if it had seen one. Every image that cannot be
 * attached therefore leaves a note in the text instead of disappearing.
 * @module dsh-lark-bridge/images
 */

import type { NormalizedMessage, ResourceDescriptor } from '@larksuite/channel'
import type { HostAttachments, HostContentBlock } from './host.ts'

/** The inbound half of the transport these images come from. */
export interface ImagePort {
  /** Download one resource of a received message, with the transport's own media type. */
  downloadResourceWithMeta(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<{ buffer: Uint8Array; contentType?: string }>
}

/** What one message's images became. */
export interface CollectedImages {
  /** Image blocks ready to ride the user message. */
  readonly blocks: HostContentBlock[]
  /** One line per image the model will NOT see, so it never answers blind. */
  readonly notes: string[]
}

/**
 * The media type to declare for stored bytes: the transport's own, when it
 * names one the store accepts, else the file name's extension.
 * @param contentType - transport-reported type, possibly parameterized.
 * @param fileName - the sender's file name, when the message carried one.
 * @param accepted - media types this deployment's store accepts.
 * @returns the media type to declare, or undefined when nothing matches.
 */
function mediaTypeOf(
  contentType: string | undefined,
  fileName: string | undefined,
  accepted: readonly string[],
): string | undefined {
  const declared = contentType?.split(';')[0]?.trim().toLowerCase()
  if (declared !== undefined && accepted.includes(declared)) return declared
  const extension = fileName?.toLowerCase().split('.').pop()
  const fromName = extension === 'jpg' || extension === 'jpeg'
    ? 'image/jpeg'
    : extension === undefined ? undefined : `image/${extension}`
  return fromName !== undefined && accepted.includes(fromName) ? fromName : undefined
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
export async function collectImages(
  msg: NormalizedMessage,
  port: ImagePort,
  attachments: HostAttachments | undefined,
  enabled: boolean,
  reason = 'attachImages 未开启',
): Promise<CollectedImages> {
  const images = msg.resources.filter((resource: ResourceDescriptor) => resource.type === 'image')
  if (images.length === 0) return { blocks: [], notes: [] }
  if (!enabled) {
    // The model is told, because a sender who attaches a screenshot is talking
    // about it — and answering as though it were visible is the worst outcome.
    return {
      blocks: [],
      notes: [`（用户发送了 ${images.length} 张图片，本渠道未向模型传递图片：${reason}）`],
    }
  }
  if (attachments === undefined) {
    return { blocks: [], notes: [`（用户发送了 ${images.length} 张图片，但本部署没有组合附件存储，模型看不到它们）`] }
  }

  const limits = attachments.imageLimits
  const blocks: HostContentBlock[] = []
  const notes: string[] = []
  let budget = limits.maxMessageImageBytes
  for (const [index, image] of images.entries()) {
    if (index >= limits.maxImagesPerMessage) {
      notes.push(`（还有 ${images.length - index} 张图片超出单条消息上限，未附加）`)
      break
    }
    try {
      const { buffer, contentType } = await port.downloadResourceWithMeta(msg.messageId, image.fileKey, 'image')
      const mediaType = mediaTypeOf(contentType, image.fileName, limits.mediaTypes)
      if (mediaType === undefined) {
        notes.push(`（一张图片的格式 ${contentType ?? '未知'} 不被支持，未附加）`)
        continue
      }
      if (buffer.byteLength > limits.maxImageBytes || buffer.byteLength > budget) {
        notes.push('（一张图片超出大小上限，未附加）')
        continue
      }
      const ref = await attachments.saveImage({
        data: buffer,
        mediaType,
        ...image.fileName === undefined ? {} : { name: image.fileName },
      })
      budget -= buffer.byteLength
      blocks.push({ type: 'image', attachment: ref })
    } catch (error) {
      // The model must know an image existed even when it cannot be shown one.
      notes.push(`（一张图片附加失败：${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  return { blocks, notes }
}
