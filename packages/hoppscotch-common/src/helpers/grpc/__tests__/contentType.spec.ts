import { describe, test, expect } from "vitest"
import * as E from "fp-ts/Either"
import {
  buildGRPCWebContentType,
  parseGRPCWebContentType,
  buildGRPCWebRequestHeaders,
  encodeGRPCWebTextBody,
  decodeGRPCWebTextBody,
} from "../contentType"

describe("buildGRPCWebContentType", () => {
  test("defaults to binary +proto when no options given", () => {
    expect(buildGRPCWebContentType()).toBe("application/grpc-web+proto")
  })

  test("builds the +json variant", () => {
    expect(buildGRPCWebContentType({ format: "json" })).toBe(
      "application/grpc-web+json"
    )
  })

  test("builds the grpc-web-text fallback variant", () => {
    expect(buildGRPCWebContentType({ format: "proto", encoding: "text" })).toBe(
      "application/grpc-web-text+proto"
    )
  })
})

describe("parseGRPCWebContentType", () => {
  test("treats a bare application/grpc-web as +proto per spec default", () => {
    const result = parseGRPCWebContentType("application/grpc-web")
    expect(result).toEqual(E.right({ format: "proto", encoding: "binary" }))
  })

  test("parses application/grpc-web+json", () => {
    const result = parseGRPCWebContentType("application/grpc-web+json")
    expect(result).toEqual(E.right({ format: "json", encoding: "binary" }))
  })

  test("parses application/grpc-web-text+proto", () => {
    const result = parseGRPCWebContentType("application/grpc-web-text+proto")
    expect(result).toEqual(E.right({ format: "proto", encoding: "text" }))
  })

  test("is case-insensitive", () => {
    const result = parseGRPCWebContentType("APPLICATION/GRPC-WEB+JSON")
    expect(result).toEqual(E.right({ format: "json", encoding: "binary" }))
  })

  test("rejects an unrelated content type", () => {
    const result = parseGRPCWebContentType("application/json")
    expect(result).toEqual(E.left({ type: "INVALID_CONTENT_TYPE" }))
  })
})

describe("buildGRPCWebRequestHeaders", () => {
  test("sets content-type, accept, and x-user-agent; never sets user-agent", () => {
    const headers = buildGRPCWebRequestHeaders({}, "1.0.0")

    expect(headers["content-type"]).toBe("application/grpc-web+proto")
    expect(headers["accept"]).toBe("application/grpc-web+proto")
    expect(headers["x-user-agent"]).toBe("grpc-web-hoppscotch/1.0.0")
    expect(headers["user-agent"]).toBeUndefined()
    expect(headers["User-Agent"]).toBeUndefined()
  })

  test("merges user-supplied metadata as regular headers", () => {
    const headers = buildGRPCWebRequestHeaders(
      { authorization: "Bearer abc", "x-trace-id": "123" },
      "1.0.0"
    )

    expect(headers["authorization"]).toBe("Bearer abc")
    expect(headers["x-trace-id"]).toBe("123")
  })

  test("transport headers win over same-named user metadata", () => {
    const headers = buildGRPCWebRequestHeaders(
      { "content-type": "text/plain" },
      "1.0.0"
    )

    expect(headers["content-type"]).toBe("application/grpc-web+proto")
  })
})

describe("grpc-web-text base64 body encode/decode", () => {
  test("round trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = encodeGRPCWebTextBody(bytes)
    const decoded = decodeGRPCWebTextBody(encoded)

    expect(decoded).toEqual(E.right(bytes))
  })

  test("decodes an empty body", () => {
    expect(decodeGRPCWebTextBody("")).toEqual(E.right(new Uint8Array(0)))
  })

  test("rejects malformed base64", () => {
    const result = decodeGRPCWebTextBody("not-valid-base64!!!")
    expect(result).toEqual(E.left({ type: "INVALID_BASE64" }))
  })
})
