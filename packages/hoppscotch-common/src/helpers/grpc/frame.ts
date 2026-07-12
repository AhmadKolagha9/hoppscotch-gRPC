import * as E from "fp-ts/Either"

/**
 * grpc-web message framing per docs/specs/grpc/01-GRPC-PROTOCOL-SPEC.md §3:
 * [1 byte flags][4 bytes big-endian length][message bytes]
 * Only the MSB of the flags byte is defined (data vs trailer frame); the LSB
 * is used here to track the "compressed" bit called out in the spec, even
 * though Hoppscotch itself never emits compressed frames.
 */
export const GRPC_WEB_FRAME_HEADER_LENGTH = 5

const TRAILER_FLAG = 0x80
const COMPRESSED_FLAG = 0x01

export type GRPCWebFrame = {
  type: "data" | "trailer"
  compressed: boolean
  payload: Uint8Array
}

export type GRPCWebFrameError =
  | { type: "INCOMPLETE_FRAME_HEADER" }
  | { type: "INCOMPLETE_FRAME_PAYLOAD" }
  | { type: "TRAILER_NOT_LAST_FRAME" }

const isTrailerFlag = (flags: number) => (flags & TRAILER_FLAG) !== 0
const isCompressedFlag = (flags: number) => (flags & COMPRESSED_FLAG) !== 0

export const encodeFrame = (
  payload: Uint8Array,
  options: { trailer?: boolean; compressed?: boolean } = {}
): Uint8Array => {
  const flags =
    (options.trailer ? TRAILER_FLAG : 0x00) |
    (options.compressed ? COMPRESSED_FLAG : 0x00)

  const frame = new Uint8Array(GRPC_WEB_FRAME_HEADER_LENGTH + payload.length)
  const view = new DataView(frame.buffer)

  view.setUint8(0, flags)
  view.setUint32(1, payload.length, false)
  frame.set(payload, GRPC_WEB_FRAME_HEADER_LENGTH)

  return frame
}

/**
 * Trailers are an HTTP/1-style header block (`key: value\r\n`, no
 * terminating blank line) carried as the payload of the final,
 * MSB-flagged frame — not real HTTP/2 trailers.
 */
export const encodeTrailerFrame = (
  trailers: Record<string, string>
): Uint8Array => {
  const text = Object.entries(trailers)
    .map(([key, value]) => `${key.toLowerCase()}: ${value}\r\n`)
    .join("")

  return encodeFrame(new TextEncoder().encode(text), { trailer: true })
}

export const parseTrailerMetadata = (
  payload: Uint8Array
): Record<string, string> => {
  const text = new TextDecoder().decode(payload)
  const metadata: Record<string, string> = {}

  for (const line of text.split("\r\n")) {
    if (!line) continue

    const separatorIndex = line.indexOf(":")
    if (separatorIndex === -1) continue

    const key = line.slice(0, separatorIndex).trim().toLowerCase()
    const value = line.slice(separatorIndex + 1).trim()

    metadata[key] = value
  }

  return metadata
}

/**
 * Parses a complete (non-streamed) grpc-web body into its frames, enforcing
 * that a trailer frame — if present — is the last frame in the body per
 * protocol spec §3.3.
 */
export const decodeFrames = (
  body: Uint8Array
): E.Either<GRPCWebFrameError, GRPCWebFrame[]> => {
  const frames: GRPCWebFrame[] = []
  let offset = 0
  let sawTrailer = false

  while (offset < body.length) {
    if (sawTrailer) {
      return E.left({ type: "TRAILER_NOT_LAST_FRAME" })
    }

    if (body.length - offset < GRPC_WEB_FRAME_HEADER_LENGTH) {
      return E.left({ type: "INCOMPLETE_FRAME_HEADER" })
    }

    const header = body.subarray(offset, offset + GRPC_WEB_FRAME_HEADER_LENGTH)
    const flags = header[0]
    const length = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength
    ).getUint32(1, false)

    offset += GRPC_WEB_FRAME_HEADER_LENGTH

    if (body.length - offset < length) {
      return E.left({ type: "INCOMPLETE_FRAME_PAYLOAD" })
    }

    const payload = body.slice(offset, offset + length)
    offset += length

    const trailer = isTrailerFlag(flags)
    frames.push({
      type: trailer ? "trailer" : "data",
      compressed: isCompressedFlag(flags),
      payload,
    })

    if (trailer) sawTrailer = true
  }

  return E.right(frames)
}

export const concatBytes = (...chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/**
 * Stateful, incremental counterpart to `decodeFrames` for reading frames off
 * a live response body stream (server-streaming append behavior per feature
 * spec §5). Feed it chunks as they arrive; it yields whichever complete
 * frames those chunks make available and buffers the remainder.
 */
export class GRPCWebFrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0)
  private sawTrailer = false

  push(chunk: Uint8Array): E.Either<GRPCWebFrameError, GRPCWebFrame[]> {
    this.buffer = concatBytes(this.buffer, chunk)

    const frames: GRPCWebFrame[] = []

    while (this.buffer.length >= GRPC_WEB_FRAME_HEADER_LENGTH) {
      if (this.sawTrailer) {
        return E.left({ type: "TRAILER_NOT_LAST_FRAME" })
      }

      const flags = this.buffer[0]
      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        GRPC_WEB_FRAME_HEADER_LENGTH
      ).getUint32(1, false)

      if (this.buffer.length < GRPC_WEB_FRAME_HEADER_LENGTH + length) break

      const payload = this.buffer.slice(
        GRPC_WEB_FRAME_HEADER_LENGTH,
        GRPC_WEB_FRAME_HEADER_LENGTH + length
      )
      this.buffer = this.buffer.slice(GRPC_WEB_FRAME_HEADER_LENGTH + length)

      const trailer = isTrailerFlag(flags)
      frames.push({
        type: trailer ? "trailer" : "data",
        compressed: isCompressedFlag(flags),
        payload,
      })

      if (trailer) this.sawTrailer = true
    }

    return E.right(frames)
  }

  /** Call once the underlying stream reaches EOF to catch truncated/trailing bytes. */
  finish(): E.Either<GRPCWebFrameError, void> {
    if (this.buffer.length === 0) return E.right(undefined)

    return this.sawTrailer
      ? E.left({ type: "TRAILER_NOT_LAST_FRAME" })
      : E.left({ type: "INCOMPLETE_FRAME_PAYLOAD" })
  }

  isComplete(): boolean {
    return this.sawTrailer
  }
}

export type GRPCStatus = {
  code: number
  message: string
  metadata: Record<string, string>
  /** True when the status came from HTTP headers rather than an in-body trailer frame. */
  trailersOnly: boolean
}

export type GRPCStatusError = { type: "MISSING_GRPC_STATUS" }

const decodeGrpcMessage = (message: string): string => {
  try {
    return decodeURIComponent(message)
  } catch {
    return message
  }
}

const lowerCaseKeys = (
  headers: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )

/**
 * Resolves the terminal grpc-status/grpc-message for a response, handling
 * the Trailers-Only shape (protocol spec §3.4) where the body carries no
 * trailer frame at all and the status instead arrives on the HTTP headers.
 */
export const resolveGRPCStatus = (
  httpHeaders: Record<string, string>,
  frames: GRPCWebFrame[]
): E.Either<GRPCStatusError, GRPCStatus> => {
  const trailerFrame = frames.find((frame) => frame.type === "trailer")

  if (trailerFrame) {
    const metadata = parseTrailerMetadata(trailerFrame.payload)
    const code = metadata["grpc-status"]

    if (code === undefined) return E.left({ type: "MISSING_GRPC_STATUS" })

    return E.right({
      code: Number(code),
      message: metadata["grpc-message"]
        ? decodeGrpcMessage(metadata["grpc-message"])
        : "",
      metadata,
      trailersOnly: false,
    })
  }

  const normalizedHeaders = lowerCaseKeys(httpHeaders)
  const code = normalizedHeaders["grpc-status"]

  if (code === undefined) return E.left({ type: "MISSING_GRPC_STATUS" })

  return E.right({
    code: Number(code),
    message: normalizedHeaders["grpc-message"]
      ? decodeGrpcMessage(normalizedHeaders["grpc-message"])
      : "",
    metadata: normalizedHeaders,
    trailersOnly: true,
  })
}
