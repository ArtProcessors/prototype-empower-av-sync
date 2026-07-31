/**
 * Minimal ambient WebCodecs declarations — just the surface StreamingBufferEngine uses.
 * (This TypeScript's lib.dom doesn't ship WebCodecs yet, and we'd rather not add a dep.)
 */
interface AudioDecoderConfig {
  codec: string
  sampleRate: number
  numberOfChannels: number
  description?: BufferSource
}

interface AudioDataCopyToOptions {
  planeIndex: number
  frameOffset?: number
  frameCount?: number
  format?: 'f32' | 'f32-planar' | 's16' | 's16-planar' | 'u8' | 'u8-planar' | 's32' | 's32-planar'
}

declare class AudioData {
  readonly format: string | null
  readonly sampleRate: number
  readonly numberOfFrames: number
  readonly numberOfChannels: number
  readonly duration: number
  readonly timestamp: number
  allocationSize(options: AudioDataCopyToOptions): number
  copyTo(destination: BufferSource, options: AudioDataCopyToOptions): void
  close(): void
}

interface EncodedAudioChunkInit {
  type: 'key' | 'delta'
  timestamp: number
  duration?: number
  data: BufferSource
}
declare class EncodedAudioChunk {
  constructor(init: EncodedAudioChunkInit)
  readonly type: 'key' | 'delta'
  readonly timestamp: number
  readonly duration: number | null
}

interface AudioDecoderInit {
  output: (data: AudioData) => void
  error: (error: DOMException) => void
}
declare class AudioDecoder {
  constructor(init: AudioDecoderInit)
  readonly state: 'unconfigured' | 'configured' | 'closed'
  readonly decodeQueueSize: number
  configure(config: AudioDecoderConfig): void
  decode(chunk: EncodedAudioChunk): void
  flush(): Promise<void>
  reset(): void
  close(): void
  static isConfigSupported(config: AudioDecoderConfig): Promise<{ supported: boolean }>
}
