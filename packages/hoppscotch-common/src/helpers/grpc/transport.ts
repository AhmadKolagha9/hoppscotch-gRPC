import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import { pipe } from "fp-ts/function"
import {
  GRPCWebFrame,
  GRPCWebFrameDecoder,
  GRPCWebFrameError,
  GRPCStatus,
  GRPCStatusError,
  concatBytes,
  encodeFrame,
  resolveGRPCStatus,
} from "./frame"
import {
  GRPCWebContentTypeOptions,
  buildGRPCWebRequestHeaders,
} from "./contentType"

/**
 * fetch-based grpc-web transport. This intentionally bypasses
 * `KernelInterceptorService` (docs/specs/grpc/00-DISCOVERY-NOTES.md §2) —
 * that abstraction is single-shot request/response and every existing
 * streaming protocol in this codebase (WS/SSE/MQTT) already talks to the
 * wire directly for the same reason grpc-web needs incremental frame reads
 * off a live response body stream.
 */

export type GRPCTransportError =
  | { type: "NETWORK_ERROR"; message: string }
  | { type: "PROTOCOL_ERROR"; frameError: GRPCWebFrameError }
  | { type: "STATUS_ERROR"; error: GRPCStatusError }

export type GRPCWebCallOptions = {
  url: string
  metadata: Record<string, string>
  clientVersion: string
  contentType?: GRPCWebContentTypeOptions
  /**
   * Pre-serialized request messages. For unary/server-streaming this is a
   * single message. For client-streaming this is the full buffered set,
   * sent as one request body per protocol spec §6's buffer-and-send-once
   * rule — Hoppscotch never streams a request body incrementally.
   */
  messages: Uint8Array[]
  /** Invoked once per data frame as it arrives, before the trailer — drives server-streaming append behavior. */
  onMessage?: (payload: Uint8Array) => void
  signal?: AbortSignal
}

/** Builds the grpc-web call URL: `<scheme>://<host:port>/<package.Service>/<Method>`. */
export const buildGRPCWebMethodUrl = (
  endpoint: string,
  useTls: boolean,
  serviceFullName: string,
  methodName: string
): string =>
  `${useTls ? "https" : "http"}://${endpoint}/${serviceFullName}/${methodName}`

/** Executes a single grpc-web HTTP call and resolves to the terminal grpc-status, or a transport-level error. */
export const executeGRPCWebCall =
  (
    options: GRPCWebCallOptions
  ): TE.TaskEither<GRPCTransportError, GRPCStatus> =>
  async () => {
    const headers = buildGRPCWebRequestHeaders(
      options.metadata,
      options.clientVersion,
      options.contentType
    )

    const body = concatBytes(...options.messages.map((m) => encodeFrame(m)))

    let response: Response
    try {
      response = await fetch(options.url, {
        method: "POST",
        headers,
        body: body as BodyInit,
        signal: options.signal,
      })
    } catch (error) {
      return E.left({
        type: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : String(error),
      })
    }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    if (!response.body) {
      return resolveStatus(responseHeaders, undefined)
    }

    const reader = response.body.getReader()
    const decoder = new GRPCWebFrameDecoder()
    let trailerFrame: GRPCWebFrame | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const result = decoder.push(value)
      if (E.isLeft(result)) {
        return E.left({ type: "PROTOCOL_ERROR", frameError: result.left })
      }

      for (const frame of result.right) {
        if (frame.type === "data") {
          options.onMessage?.(frame.payload)
        } else {
          trailerFrame = frame
        }
      }
    }

    const finishResult = decoder.finish()
    if (E.isLeft(finishResult)) {
      return E.left({ type: "PROTOCOL_ERROR", frameError: finishResult.left })
    }

    return resolveStatus(responseHeaders, trailerFrame)
  }

const resolveStatus = (
  responseHeaders: Record<string, string>,
  trailerFrame: GRPCWebFrame | undefined
): E.Either<GRPCTransportError, GRPCStatus> =>
  pipe(
    resolveGRPCStatus(responseHeaders, trailerFrame ? [trailerFrame] : []),
    E.mapLeft((error): GRPCTransportError => ({ type: "STATUS_ERROR", error }))
  )
