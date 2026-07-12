import { describe, test, expect, vi, afterEach } from "vitest"
import * as E from "fp-ts/Either"
import { encodeFrame, encodeTrailerFrame, concatBytes } from "../frame"
import { executeGRPCWebCall, buildGRPCWebMethodUrl } from "../transport"

const utf8 = (text: string) => new TextEncoder().encode(text)

/** Builds a fetch Response whose body streams the given frame bytes in arbitrary chunk boundaries. */
const mockResponse = (
  frameBytes: Uint8Array,
  options: { headers?: Record<string, string>; chunkSize?: number } = {}
): Response => {
  const chunkSize = options.chunkSize ?? (frameBytes.length || 1)

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < frameBytes.length; offset += chunkSize) {
        controller.enqueue(frameBytes.slice(offset, offset + chunkSize))
      }
      controller.close()
    },
  })

  return new Response(stream, { headers: options.headers })
}

describe("buildGRPCWebMethodUrl", () => {
  test("builds an https URL for TLS endpoints", () => {
    expect(
      buildGRPCWebMethodUrl(
        "api.example.com:443",
        true,
        "demo.Greeter",
        "SayHello"
      )
    ).toBe("https://api.example.com:443/demo.Greeter/SayHello")
  })

  test("builds an http URL for plaintext endpoints", () => {
    expect(
      buildGRPCWebMethodUrl("localhost:9090", false, "demo.Greeter", "SayHello")
    ).toBe("http://localhost:9090/demo.Greeter/SayHello")
  })
})

describe("executeGRPCWebCall", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("resolves the trailer status for a unary response and forwards data frames via onMessage", async () => {
    const body = concatBytes(
      encodeFrame(utf8('{"result":42}')),
      encodeTrailerFrame({ "grpc-status": "0" })
    )
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(body))
    vi.stubGlobal("fetch", fetchMock)

    const messages: string[] = []

    const result = await executeGRPCWebCall({
      url: "http://localhost:9090/demo.Greeter/SayHello",
      metadata: {},
      clientVersion: "1.0.0",
      messages: [utf8('{"name":"world"}')],
      onMessage: (payload) => messages.push(new TextDecoder().decode(payload)),
    })()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right).toEqual({
        code: 0,
        message: "",
        metadata: { "grpc-status": "0" },
        trailersOnly: false,
      })
    }
    expect(messages).toEqual(['{"result":42}'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers["content-type"]).toBe("application/grpc-web+proto")
  })

  test("forwards every message for a server-streaming response, chunked across network reads", async () => {
    const body = concatBytes(
      encodeFrame(utf8('{"seq":1}')),
      encodeFrame(utf8('{"seq":2}')),
      encodeFrame(utf8('{"seq":3}')),
      encodeTrailerFrame({ "grpc-status": "0" })
    )
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(body, { chunkSize: 7 }))
    )

    const messages: string[] = []

    const result = await executeGRPCWebCall({
      url: "http://localhost:9090/demo.Greeter/SayHelloStream",
      metadata: {},
      clientVersion: "1.0.0",
      messages: [utf8('{"name":"world"}')],
      onMessage: (payload) => messages.push(new TextDecoder().decode(payload)),
    })()

    expect(E.isRight(result)).toBe(true)
    expect(messages).toEqual(['{"seq":1}', '{"seq":2}', '{"seq":3}'])
  })

  test("resolves Trailers-Only status from response headers when the body carries no trailer frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(new Uint8Array(0), {
          headers: { "grpc-status": "16", "grpc-message": "unauthenticated" },
        })
      )
    )

    const result = await executeGRPCWebCall({
      url: "http://localhost:9090/demo.Greeter/SayHello",
      metadata: {},
      clientVersion: "1.0.0",
      messages: [utf8("{}")],
    })()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.code).toBe(16)
      expect(result.right.message).toBe("unauthenticated")
      expect(result.right.trailersOnly).toBe(true)
    }
  })

  test("surfaces a NETWORK_ERROR when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    )

    const result = await executeGRPCWebCall({
      url: "http://localhost:9090/demo.Greeter/SayHello",
      metadata: {},
      clientVersion: "1.0.0",
      messages: [utf8("{}")],
    })()

    expect(result).toEqual(
      E.left({ type: "NETWORK_ERROR", message: "Failed to fetch" })
    )
  })

  test("surfaces a PROTOCOL_ERROR when a data frame follows the trailer frame", async () => {
    const body = concatBytes(
      encodeTrailerFrame({ "grpc-status": "0" }),
      encodeFrame(utf8("stray"))
    )
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(body)))

    const result = await executeGRPCWebCall({
      url: "http://localhost:9090/demo.Greeter/SayHello",
      metadata: {},
      clientVersion: "1.0.0",
      messages: [utf8("{}")],
    })()

    expect(result).toEqual(
      E.left({
        type: "PROTOCOL_ERROR",
        frameError: { type: "TRAILER_NOT_LAST_FRAME" },
      })
    )
  })

  test("merges custom metadata into request headers without overriding transport headers", async () => {
    const body = encodeTrailerFrame({ "grpc-status": "0" })
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(body))
    vi.stubGlobal("fetch", fetchMock)

    await executeGRPCWebCall({
      url: "http://localhost:9090/demo.Greeter/SayHello",
      metadata: { authorization: "Bearer abc", "content-type": "text/plain" },
      clientVersion: "1.0.0",
      messages: [utf8("{}")],
    })()

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers["authorization"]).toBe("Bearer abc")
    expect(init.headers["content-type"]).toBe("application/grpc-web+proto")
  })
})
