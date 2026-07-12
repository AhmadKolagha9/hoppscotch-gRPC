import * as E from "fp-ts/Either"

/**
 * Content-type / header negotiation per docs/specs/grpc/01-GRPC-PROTOCOL-SPEC.md §2, §5.
 */

export type GRPCWebMessageFormat = "proto" | "json"
export type GRPCWebBodyEncoding = "binary" | "text"

export type GRPCWebContentTypeOptions = {
  /** Defaults to "proto" — the spec's default when unspecified. */
  format?: GRPCWebMessageFormat
  /** "text" is the base64 grpc-web-text fallback, kept only for testing legacy servers. */
  encoding?: GRPCWebBodyEncoding
}

export const buildGRPCWebContentType = (
  options: GRPCWebContentTypeOptions = {}
): string => {
  const format = options.format ?? "proto"
  const encoding = options.encoding ?? "binary"

  const base =
    encoding === "text" ? "application/grpc-web-text" : "application/grpc-web"

  return `${base}+${format}`
}

export type GRPCWebContentTypeError = { type: "INVALID_CONTENT_TYPE" }

const CONTENT_TYPE_PATTERN = /^application\/grpc-web(-text)?(\+(proto|json))?$/

/** Parses a response Content-Type header value; treats a bare `application/grpc-web` as `+proto` per spec §2. */
export const parseGRPCWebContentType = (
  contentType: string
): E.Either<
  GRPCWebContentTypeError,
  { format: GRPCWebMessageFormat; encoding: GRPCWebBodyEncoding }
> => {
  const match = contentType.trim().toLowerCase().match(CONTENT_TYPE_PATTERN)

  if (!match) return E.left({ type: "INVALID_CONTENT_TYPE" })

  return E.right({
    encoding: match[1] ? "text" : "binary",
    format: (match[3] as GRPCWebMessageFormat | undefined) ?? "proto",
  })
}

/**
 * Builds the full header set Hoppscotch's grpc-web client must send per
 * protocol spec §5. `User-Agent` is deliberately omitted — browsers own that
 * header and refuse to let scripts set it. Caller-supplied metadata is
 * merged in last-write-wins so grpc-web transport headers can't be shadowed
 * by user-entered metadata of the same name.
 */
export const buildGRPCWebRequestHeaders = (
  metadata: Record<string, string>,
  clientVersion: string,
  options: GRPCWebContentTypeOptions = {}
): Record<string, string> => {
  const contentType = buildGRPCWebContentType(options)

  return {
    ...metadata,
    "content-type": contentType,
    accept: contentType,
    "x-user-agent": `grpc-web-hoppscotch/${clientVersion}`,
  }
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** One-shot base64 encode for the grpc-web-text body encoding (protocol spec §2). */
export const encodeGRPCWebTextBody = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export type GRPCWebTextDecodeError = { type: "INVALID_BASE64" }

/**
 * One-shot base64 decode for a complete grpc-web-text body. Streaming
 * (chunk-at-a-time) base64 decoding isn't implemented — protocol spec §2
 * marks grpc-web-text as a legacy-server testing fallback, not required for
 * MVP, so incremental server-streaming reads aren't supported for this
 * encoding; use binary framing for streaming RPCs.
 */
export const decodeGRPCWebTextBody = (
  base64: string
): E.Either<GRPCWebTextDecodeError, Uint8Array> => {
  if (base64.length === 0) return E.right(new Uint8Array(0))

  const sanitized = base64.replace(/\s/g, "")
  const isValid =
    sanitized.length % 4 === 0 &&
    [...sanitized].every((char) => BASE64_CHARS.includes(char) || char === "=")

  if (!isValid) return E.left({ type: "INVALID_BASE64" })

  try {
    const binary = atob(sanitized)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return E.right(bytes)
  } catch {
    return E.left({ type: "INVALID_BASE64" })
  }
}
