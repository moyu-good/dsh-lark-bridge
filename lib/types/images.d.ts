/**
 * Images a chat message carried. Sending a screenshot is how someone shows a
 * problem, so an image the model never receives is worse than a missing
 * feature: the model answers as if it had seen one. Every image that cannot be
 * attached therefore leaves a note in the text instead of disappearing.
 * @module dsh-lark-bridge/images
 */
import type { NormalizedMessage } from '@larksuite/channel';
import type { HostAttachments, HostContentBlock } from './host.ts';
/** The inbound half of the transport these images come from. */
export interface ImagePort {
    /** Download one resource of a received message, with the transport's own media type. */
    downloadResourceWithMeta(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<{
        buffer: Uint8Array;
        contentType?: string;
    }>;
}
/** What one message's images became. */
export interface CollectedImages {
    /** Image blocks ready to ride the user message. */
    readonly blocks: HostContentBlock[];
    /** One line per image the model will NOT see, so it never answers blind. */
    readonly notes: string[];
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
export declare function collectImages(msg: NormalizedMessage, port: ImagePort, attachments: HostAttachments | undefined, enabled: boolean, reason?: string): Promise<CollectedImages>;
//# sourceMappingURL=images.d.ts.map