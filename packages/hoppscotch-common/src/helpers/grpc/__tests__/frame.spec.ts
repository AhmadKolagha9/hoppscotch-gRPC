import { describe, test, expect } from "vitest"
import * as E from "fp-ts/Either"
import {
  encodeFrame,
  encodeTrailerFrame,
  decodeFrames,
  parseTrailerMetadata,
  resolveGRPCStatus,
  GRPCWebFrameDecoder,
} from "../frame"

const concat = (...chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

const utf8 = (text: string) => new TextEncoder().encode(text)

describe("encodeFrame / decodeFrames round trip", () => {
  test("encodes and decodes a single data frame", () => {
    const payload = utf8('{"hello":"world"}')
    const frame = encodeFrame(payload)

    const decoded = decodeFrames(frame)

    expect(E.isRight(decoded)).toBe(true)
    if (E.isRight(decoded)) {
      expect(decoded.right).toHaveLength(1)
      expect(decoded.right[0].type).toBe("data")
      expect(decoded.right[0].compressed).toBe(false)
      expect(Array.from(decoded.right[0].payload)).toEqual(Array.from(payload))
    }
  })

  test("sets only the MSB for an uncompressed data frame (flags byte 0x00)", () => {
    const frame = encodeFrame(utf8("x"))
    expect(frame[0]).toBe(0x00)
  })

  test("sets the MSB for a trailer frame (flags byte 0x80)", () => {
    const frame = encodeTrailerFrame({ "grpc-status": "0" })
    expect(frame[0]).toBe(0x80)
  })

  test("encodes length as 4-byte big-endian", () => {
    const payload = new Uint8Array(300).fill(1)
    const frame = encodeFrame(payload)

    // bytes 1-4 are the big-endian length prefix
    const view = new DataView(frame.buffer, 1, 4)
    expect(view.getUint32(0, false)).toBe(300)
  })

  test("decodes a unary response: one data frame followed by a trailer frame", () => {
    const dataFrame = encodeFrame(utf8('{"result":42}'))
    const trailerFrame = encodeTrailerFrame({
      "grpc-status": "0",
      "grpc-message": "",
    })
    const body = concat(dataFrame, trailerFrame)

    const decoded = decodeFrames(body)

    expect(E.isRight(decoded)).toBe(true)
    if (E.isRight(decoded)) {
      expect(decoded.right).toHaveLength(2)
      expect(decoded.right[0].type).toBe("data")
      expect(decoded.right[1].type).toBe("trailer")
    }
  })

  test("decodes a server-streaming response: N data frames then a trailer frame", () => {
    const frames = [
      encodeFrame(utf8('{"seq":1}')),
      encodeFrame(utf8('{"seq":2}')),
      encodeFrame(utf8('{"seq":3}')),
      encodeTrailerFrame({ "grpc-status": "0" }),
    ]
    const body = concat(...frames)

    const decoded = decodeFrames(body)

    expect(E.isRight(decoded)).toBe(true)
    if (E.isRight(decoded)) {
      expect(decoded.right.map((f) => f.type)).toEqual([
        "data",
        "data",
        "data",
        "trailer",
      ])
    }
  })
})

describe("malformed frame handling", () => {
  test("rejects a body that continues after a trailer frame (trailer not last)", () => {
    const trailerFrame = encodeTrailerFrame({ "grpc-status": "0" })
    const strayDataFrame = encodeFrame(utf8("should not be here"))
    const body = concat(trailerFrame, strayDataFrame)

    const decoded = decodeFrames(body)

    expect(decoded).toEqual(E.left({ type: "TRAILER_NOT_LAST_FRAME" }))
  })

  test("rejects a body with an incomplete frame header (fewer than 5 bytes trailing)", () => {
    const body = new Uint8Array([0x00, 0x00, 0x00])

    const decoded = decodeFrames(body)

    expect(decoded).toEqual(E.left({ type: "INCOMPLETE_FRAME_HEADER" }))
  })

  test("rejects a body whose declared length exceeds the remaining bytes", () => {
    const header = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x0a]) // declares 10 bytes
    const body = concat(header, utf8("short")) // only 5 bytes follow

    const decoded = decodeFrames(body)

    expect(decoded).toEqual(E.left({ type: "INCOMPLETE_FRAME_PAYLOAD" }))
  })
})

describe("parseTrailerMetadata", () => {
  test("parses key: value pairs without a terminating blank line", () => {
    const payload = utf8(
      "grpc-status: 0\r\ngrpc-message: ok\r\ncustom-key: custom-value"
    )

    const metadata = parseTrailerMetadata(payload)

    expect(metadata).toEqual({
      "grpc-status": "0",
      "grpc-message": "ok",
      "custom-key": "custom-value",
    })
  })

  test("lower-cases keys regardless of wire case", () => {
    const payload = utf8("Grpc-Status: 0\r\nGRPC-MESSAGE: ok")

    const metadata = parseTrailerMetadata(payload)

    expect(metadata).toEqual({ "grpc-status": "0", "grpc-message": "ok" })
  })
})

describe("resolveGRPCStatus", () => {
  test("resolves status from an in-body trailer frame", () => {
    const trailerFrame = encodeTrailerFrame({
      "grpc-status": "5",
      "grpc-message": "not found",
    })
    const decoded = decodeFrames(trailerFrame)
    expect(E.isRight(decoded)).toBe(true)

    const frames = E.isRight(decoded) ? decoded.right : []
    const status = resolveGRPCStatus({}, frames)

    expect(status).toEqual(
      E.right({
        code: 5,
        message: "not found",
        metadata: { "grpc-status": "5", "grpc-message": "not found" },
        trailersOnly: false,
      })
    )
  })

  test("Trailers-Only: empty body, status carried on HTTP headers", () => {
    const httpHeaders = {
      "Content-Type": "application/grpc-web+proto",
      "grpc-status": "16",
      "grpc-message": "unauthenticated",
    }

    const status = resolveGRPCStatus(httpHeaders, [])

    expect(status).toEqual(
      E.right({
        code: 16,
        message: "unauthenticated",
        metadata: {
          "content-type": "application/grpc-web+proto",
          "grpc-status": "16",
          "grpc-message": "unauthenticated",
        },
        trailersOnly: true,
      })
    )
  })

  test("returns MISSING_GRPC_STATUS when neither frames nor headers carry a status", () => {
    const status = resolveGRPCStatus({}, [])
    expect(status).toEqual(E.left({ type: "MISSING_GRPC_STATUS" }))
  })

  test("percent-decodes grpc-message", () => {
    const trailerFrame = encodeTrailerFrame({
      "grpc-status": "3",
      "grpc-message": "invalid%20argument%3A%20id",
    })
    const decoded = decodeFrames(trailerFrame)
    const frames = E.isRight(decoded) ? decoded.right : []

    const status = resolveGRPCStatus({}, frames)

    expect(E.isRight(status)).toBe(true)
    if (E.isRight(status)) {
      expect(status.right.message).toBe("invalid argument: id")
    }
  })
})

describe("GRPCWebFrameDecoder (incremental / streaming)", () => {
  test("yields frames as complete chunks arrive, buffering partial ones", () => {
    const dataFrame = encodeFrame(utf8('{"seq":1}'))
    const trailerFrame = encodeTrailerFrame({ "grpc-status": "0" })
    const full = concat(dataFrame, trailerFrame)

    // split arbitrarily mid-frame to simulate network chunking
    const splitPoint = Math.floor(dataFrame.length / 2)
    const chunk1 = full.slice(0, splitPoint)
    const chunk2 = full.slice(splitPoint)

    const decoder = new GRPCWebFrameDecoder()

    const result1 = decoder.push(chunk1)
    expect(E.isRight(result1)).toBe(true)
    if (E.isRight(result1)) expect(result1.right).toHaveLength(0)

    const result2 = decoder.push(chunk2)
    expect(E.isRight(result2)).toBe(true)
    if (E.isRight(result2)) {
      expect(result2.right.map((f) => f.type)).toEqual(["data", "trailer"])
    }

    expect(decoder.isComplete()).toBe(true)
    expect(decoder.finish()).toEqual(E.right(undefined))
  })

  test("appends server-streaming messages one push at a time", () => {
    const decoder = new GRPCWebFrameDecoder()
    const seen: string[] = []

    for (let seq = 1; seq <= 3; seq++) {
      const result = decoder.push(encodeFrame(utf8(`{"seq":${seq}}`)))
      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        for (const frame of result.right) {
          seen.push(new TextDecoder().decode(frame.payload))
        }
      }
    }

    expect(seen).toEqual(['{"seq":1}', '{"seq":2}', '{"seq":3}'])
    expect(decoder.isComplete()).toBe(false)

    const trailerResult = decoder.push(
      encodeTrailerFrame({ "grpc-status": "0" })
    )
    expect(E.isRight(trailerResult)).toBe(true)
    expect(decoder.isComplete()).toBe(true)
  })

  test("rejects data pushed after a trailer frame", () => {
    const decoder = new GRPCWebFrameDecoder()
    decoder.push(encodeTrailerFrame({ "grpc-status": "0" }))

    const result = decoder.push(encodeFrame(utf8("stray")))

    expect(result).toEqual(E.left({ type: "TRAILER_NOT_LAST_FRAME" }))
  })

  test("finish() reports truncated frames left in the buffer", () => {
    const decoder = new GRPCWebFrameDecoder()
    decoder.push(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x0a, 1, 2, 3])) // declares 10 bytes, only 3 given

    expect(decoder.finish()).toEqual(
      E.left({ type: "INCOMPLETE_FRAME_PAYLOAD" })
    )
  })
})
