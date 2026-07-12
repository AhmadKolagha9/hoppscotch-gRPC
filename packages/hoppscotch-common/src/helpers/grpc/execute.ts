import * as E from "fp-ts/Either"
import {
  Environment,
  HoppGRPCRequest,
  parseTemplateString,
} from "@hoppscotch/data"
import { GRPCSchema } from "./schema"
import { GRPCResponseEvent } from "./document"
import {
  GRPCTransportError,
  buildGRPCWebMethodUrl,
  executeGRPCWebCall,
} from "./transport"
import { getGRPCEffectiveEnvVariables } from "./interpolate"

export type GRPCExecuteError =
  | { type: "METHOD_NOT_FOUND" }
  | { type: "MESSAGE_TYPE_NOT_FOUND"; typeName: string }
  | { type: "INVALID_JSON_BODY"; message: string }
  | { type: "ENCODE_ERROR"; message: string }
  | { type: "BIDI_UNSUPPORTED" }

const describeTransportError = (error: GRPCTransportError): string => {
  switch (error.type) {
    case "NETWORK_ERROR":
      return error.message
    case "PROTOCOL_ERROR":
      return `grpc-web protocol violation: ${error.frameError.type}`
    case "STATUS_ERROR":
      return "Server response carried no grpc-status"
  }
}

const authToMetadata = (
  auth: HoppGRPCRequest["auth"],
  envVars: Environment["variables"]
): Record<string, string> => {
  switch (auth.authType) {
    case "basic": {
      const username = parseTemplateString(auth.username, envVars)
      const password = parseTemplateString(auth.password, envVars)
      return {
        authorization: `Basic ${btoa(`${username}:${password}`)}`,
      }
    }
    case "bearer":
      return {
        authorization: `Bearer ${parseTemplateString(auth.token, envVars)}`,
      }
    case "api-key": {
      if (auth.addTo !== "HEADERS") return {}
      return {
        [parseTemplateString(auth.key, envVars)]: parseTemplateString(
          auth.value,
          envVars
        ),
      }
    }
    default:
      return {}
  }
}

/**
 * Runs one gRPC call end to end: interpolates env vars into the endpoint,
 * metadata, and body; encodes the JSON body against the loaded schema;
 * invokes the grpc-web transport; and decodes response messages back to
 * JSON, appending each as a `GRPCResponseEvent` via `onEvent` (unary and
 * server-streaming both funnel through the same log — see document.ts).
 */
export const executeGRPCRequest = async (
  request: HoppGRPCRequest,
  schema: GRPCSchema,
  clientVersion: string,
  onEvent: (event: GRPCResponseEvent) => void,
  signal?: AbortSignal
): Promise<E.Either<GRPCExecuteError, void>> => {
  if (request.rpcType === "bidi-streaming") {
    return E.left({ type: "BIDI_UNSUPPORTED" })
  }

  const envVars = getGRPCEffectiveEnvVariables()

  const service = schema.services.find((s) => s.fullName === request.service)
  const method = service?.methods.find((m) => m.name === request.method)

  if (!method) return E.left({ type: "METHOD_NOT_FOUND" })

  const RequestType = schema.root.lookupType(method.requestType)
  const ResponseType = schema.root.lookupType(method.responseType)

  if (!RequestType) {
    return E.left({
      type: "MESSAGE_TYPE_NOT_FOUND",
      typeName: method.requestType,
    })
  }
  if (!ResponseType) {
    return E.left({
      type: "MESSAGE_TYPE_NOT_FOUND",
      typeName: method.responseType,
    })
  }

  const interpolatedBody = parseTemplateString(request.body, envVars)

  let payloads: unknown[]
  try {
    const parsed = JSON.parse(interpolatedBody || "{}")
    payloads =
      request.rpcType === "client-streaming"
        ? Array.isArray(parsed)
          ? parsed
          : [parsed]
        : [parsed]
  } catch (error) {
    return E.left({
      type: "INVALID_JSON_BODY",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  let messages: Uint8Array[]
  try {
    messages = payloads.map((payload) => {
      const errMsg = RequestType.verify(payload as Record<string, unknown>)
      if (errMsg) throw new Error(errMsg)
      return RequestType.encode(
        RequestType.fromObject(payload as Record<string, unknown>)
      ).finish()
    })
  } catch (error) {
    return E.left({
      type: "ENCODE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const metadata: Record<string, string> = {
    ...authToMetadata(request.auth, envVars),
  }

  for (const header of request.metadata) {
    if (!header.active || !header.key) continue
    metadata[parseTemplateString(header.key, envVars)] = parseTemplateString(
      header.value,
      envVars
    )
  }

  const interpolatedUrl = parseTemplateString(request.url, envVars)

  const result = await executeGRPCWebCall({
    url: buildGRPCWebMethodUrl(
      interpolatedUrl,
      request.useTls,
      request.service,
      request.method
    ),
    metadata,
    clientVersion,
    messages,
    onMessage: (payload) => {
      try {
        const decoded = ResponseType.decode(payload)
        const obj = ResponseType.toObject(decoded, {
          longs: String,
          enums: String,
          bytes: String,
        })
        onEvent({
          type: "message",
          message: JSON.stringify(obj, null, 2),
          timestamp: Date.now(),
        })
      } catch (error) {
        onEvent({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    signal,
  })()

  if (E.isLeft(result)) {
    onEvent({ type: "error", error: describeTransportError(result.left) })
    return E.right(undefined)
  }

  onEvent({
    type: "status",
    code: result.right.code,
    message: result.right.message,
    trailersOnly: result.right.trailersOnly,
  })

  return E.right(undefined)
}
