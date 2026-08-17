/**
 * Minimal ambient WebCodecs declarations — just the surface
 * StreamingBufferEngine uses. (This TypeScript's lib.dom doesn't ship
 * WebCodecs yet, and we'd rather not add a dep.)
 *
 * @see https://www.w3.org/TR/webcodecs/
 */

/** Track parameters an {@link AudioDecoder} is configured with. */
interface AudioDecoderConfig {
  /** Codec string, e.g. `mp4a.40.2` for AAC-LC. */
  codec: string
  /** Sample rate of the encoded audio, in Hz. */
  sampleRate: number
  /** Channel count of the encoded audio. */
  numberOfChannels: number
  /** Codec-private data — the AAC AudioSpecificConfig for `mp4a.40.*`. */
  description?: BufferSource
}

/** Which samples {@link AudioData.copyTo} should write out, and in what form. */
interface AudioDataCopyToOptions {
  /** Plane to copy: the channel index for any `*-planar` format. */
  planeIndex: number
  /** First frame to copy; defaults to the start of the plane. */
  frameOffset?: number
  /** How many frames to copy; defaults to the rest of the plane. */
  frameCount?: number
  /** Sample format to convert to; defaults to the buffer's own format. */
  format?:
    | 'f32'
    | 'f32-planar'
    | 's16'
    | 's16-planar'
    | 'u8'
    | 'u8-planar'
    | 's32'
    | 's32-planar'
}

/** One decoded chunk of PCM handed to `AudioDecoderInit.output`. */
declare class AudioData {
  /** Sample format, or `null` once the buffer has been closed. */
  readonly format: string | null
  /** Sample rate of this buffer, in Hz. */
  readonly sampleRate: number
  /** Frames per channel in this buffer. */
  readonly numberOfFrames: number
  /** Channel count of this buffer. */
  readonly numberOfChannels: number
  /** Length of this buffer, in microseconds. */
  readonly duration: number
  /** Presentation timestamp of the first frame, in microseconds. */
  readonly timestamp: number
  /** Bytes {@link copyTo} needs for `options`. */
  allocationSize(options: AudioDataCopyToOptions): number
  /** Copy samples out into `destination`. */
  copyTo(destination: BufferSource, options: AudioDataCopyToOptions): void
  /** Release the underlying memory; every property then reads as empty. */
  close(): void
}

/** Constructor arguments for {@link EncodedAudioChunk}. */
interface EncodedAudioChunkInit {
  /** Whether the chunk decodes standalone (`key`) or not (`delta`). */
  type: 'key' | 'delta'
  /** Presentation timestamp, in microseconds. */
  timestamp: number
  /** Length of the chunk, in microseconds. */
  duration?: number
  /** The encoded bytes. */
  data: BufferSource
}

/** One encoded frame queued into an {@link AudioDecoder}. */
declare class EncodedAudioChunk {
  constructor(init: EncodedAudioChunkInit)
  /** Whether the chunk decodes standalone (`key`) or not (`delta`). */
  readonly type: 'key' | 'delta'
  /** Presentation timestamp, in microseconds. */
  readonly timestamp: number
  /** Length of the chunk in microseconds, or `null` when unknown. */
  readonly duration: number | null
}

/** Constructor callbacks for {@link AudioDecoder}. */
interface AudioDecoderInit {
  /** Receives each decoded buffer; the callee must `close()` it. */
  output: (data: AudioData) => void
  /** Receives a fatal decode error, after which the decoder is unusable. */
  error: (error: DOMException) => void
}

/** Hardware/software audio decoder driven off the main thread. */
declare class AudioDecoder {
  constructor(init: AudioDecoderInit)
  /** Lifecycle state; `decode()` is only legal while `configured`. */
  readonly state: 'unconfigured' | 'configured' | 'closed'
  /** Chunks queued but not yet decoded — the backpressure signal. */
  readonly decodeQueueSize: number
  /** Apply a track configuration, moving the decoder to `configured`. */
  configure(config: AudioDecoderConfig): void
  /** Queue an encoded chunk for decoding. */
  decode(chunk: EncodedAudioChunk): void
  /** Resolve once every queued chunk has been emitted to `output`. */
  flush(): Promise<void>
  /** Drop the queue and return to `unconfigured`. */
  reset(): void
  /** Release the decoder for good. */
  close(): void
  /** Whether the platform can decode `config`. */
  static isConfigSupported(
    config: AudioDecoderConfig,
  ): Promise<{ supported: boolean }>
}
