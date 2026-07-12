import * as http from "node:http"
import protobuf from "protobufjs"
import "protobufjs/ext/descriptor"

/**
 * A minimal, from-scratch grpc-web server used only for the integration
 * tests in this directory (feature spec §7). Its frame encode/decode is
 * deliberately written independently of `../frame.ts` — reusing the
 * client's own framing code here would let a symmetric bug in encode/decode
 * hide from the client's unit tests, which all exercise frames produced by
 * that same code. This gives a genuinely independent implementation to test
 * the client against, the same role a real `@grpc/grpc-js` or Go server
 * would play, without needing an external grpc-web-to-HTTP/2 proxy (a plain
 * `@grpc/grpc-js` server only speaks native HTTP/2 gRPC, not grpc-web, so it
 * can't be hit directly by this browser-tier client).
 */

const TEST_PROTO_SOURCE = `
syntax = "proto3";
package testdemo;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc SayHelloStream (HelloRequest) returns (stream HelloReply);
  rpc SayHelloMissing (HelloRequest) returns (HelloReply);
}

message HelloRequest {
  string name = 1;
}

message HelloReply {
  string message = 1;
}
`

const REFLECTION_PROTO_SOURCE = `
syntax = "proto3";
package grpc.reflection.v1alpha;

message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}

message ServerReflectionResponse {
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}

message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`

const buildRoot = (source: string) => {
  const root = new protobuf.Root()
  protobuf.parse(source, root, { keepCase: true })
  root.resolveAll()
  return root
}

const testRoot = buildRoot(TEST_PROTO_SOURCE)
const reflectionRoot = buildRoot(REFLECTION_PROTO_SOURCE)

const HelloRequestType = testRoot.lookupType("testdemo.HelloRequest")
const HelloReplyType = testRoot.lookupType("testdemo.HelloReply")
const ReflectionResponseType = reflectionRoot.lookupType(
  "grpc.reflection.v1alpha.ServerReflectionResponse"
)
const ReflectionRequestType = reflectionRoot.lookupType(
  "grpc.reflection.v1alpha.ServerReflectionRequest"
)

// --- independent frame encode/decode ---

const encodeFrame = (payload: Uint8Array, trailer = false): Buffer => {
  const header = Buffer.alloc(5)
  header.writeUInt8(trailer ? 0x80 : 0x00, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

const encodeTrailerFrame = (trailers: Record<string, string>): Buffer => {
  const text = Object.entries(trailers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("")
  return encodeFrame(Buffer.from(text), true)
}

const decodeFrames = (
  body: Buffer
): { trailer: boolean; payload: Buffer }[] => {
  const frames: { trailer: boolean; payload: Buffer }[] = []
  let offset = 0
  while (offset < body.length) {
    const flags = body.readUInt8(offset)
    const length = body.readUInt32BE(offset + 1)
    offset += 5
    frames.push({
      trailer: (flags & 0x80) !== 0,
      payload: body.subarray(offset, offset + length),
    })
    offset += length
  }
  return frames
}

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })

const sendGrpcWebResponse = (
  res: http.ServerResponse,
  dataFrames: Buffer[],
  trailers: Record<string, string>
) => {
  res.writeHead(200, {
    "content-type": "application/grpc-web+proto",
  })
  for (const frame of dataFrames) res.write(frame)
  res.end(encodeTrailerFrame(trailers))
}

const handleGreeterSayHello = (
  requestPayload: Buffer,
  res: http.ServerResponse
) => {
  const request = HelloRequestType.decode(requestPayload) as unknown as {
    name: string
  }
  const reply = HelloReplyType.encode(
    HelloReplyType.create({ message: `Hello, ${request.name}!` })
  ).finish()
  sendGrpcWebResponse(res, [encodeFrame(reply)], { "grpc-status": "0" })
}

const handleGreeterSayHelloStream = (
  requestPayload: Buffer,
  res: http.ServerResponse
) => {
  const request = HelloRequestType.decode(requestPayload) as unknown as {
    name: string
  }
  const frames = [1, 2, 3].map((n) =>
    encodeFrame(
      HelloReplyType.encode(
        HelloReplyType.create({ message: `Hello, ${request.name}! (${n})` })
      ).finish()
    )
  )
  sendGrpcWebResponse(res, frames, { "grpc-status": "0" })
}

const handleGreeterSayHelloMissing = (res: http.ServerResponse) => {
  sendGrpcWebResponse(res, [], {
    "grpc-status": "5",
    "grpc-message": "user not found",
  })
}

const getFileDescriptorProtoType = (): protobuf.Type =>
  (
    protobuf as unknown as { descriptor: protobuf.Namespace }
  ).descriptor.lookupType("FileDescriptorProto")

const testFileDescriptorProtoBytes = (): Uint8Array => {
  const fileDescriptorSet = (
    testRoot as unknown as {
      toDescriptor: (syntax: string) => {
        file: protobuf.Message<Record<string, unknown>>[]
      }
    }
  ).toDescriptor("proto3")
  return getFileDescriptorProtoType().encode(fileDescriptorSet.file[0]).finish()
}

const handleReflection = (requestPayload: Buffer, res: http.ServerResponse) => {
  // protobufjs materializes every scalar oneof sibling to its zero value on
  // decode (e.g. an unset `list_services` string decodes to `""`, not
  // `undefined`), so presence must be read off the virtual oneof
  // discriminator property instead of comparing a sibling field to undefined.
  const request = ReflectionRequestType.decode(requestPayload) as unknown as {
    message_request?: string
  }

  let responseMessage: Record<string, unknown>

  if (request.message_request === "list_services") {
    responseMessage = {
      list_services_response: {
        service: [
          { name: "testdemo.Greeter" },
          { name: "grpc.reflection.v1alpha.ServerReflection" },
        ],
      },
    }
  } else if (
    request.message_request === "file_containing_symbol" ||
    request.message_request === "file_by_filename"
  ) {
    responseMessage = {
      file_descriptor_response: {
        file_descriptor_proto: [testFileDescriptorProtoBytes()],
      },
    }
  } else {
    responseMessage = {
      error_response: { error_code: 12, error_message: "not implemented" },
    }
  }

  const responseBytes = ReflectionResponseType.encode(
    ReflectionResponseType.create(responseMessage)
  ).finish()

  sendGrpcWebResponse(res, [encodeFrame(responseBytes)], { "grpc-status": "0" })
}

export type TestServerHandle = {
  url: string
  close: () => Promise<void>
}

export const startTestServer = (): Promise<TestServerHandle> =>
  new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const body = await readBody(req)
      const frames = decodeFrames(body)
      const requestPayload =
        frames.find((f) => !f.trailer)?.payload ?? Buffer.alloc(0)

      switch (req.url) {
        case "/testdemo.Greeter/SayHello":
          return handleGreeterSayHello(requestPayload, res)
        case "/testdemo.Greeter/SayHelloStream":
          return handleGreeterSayHelloStream(requestPayload, res)
        case "/testdemo.Greeter/SayHelloMissing":
          return handleGreeterSayHelloMissing(res)
        case "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo":
          return handleReflection(requestPayload, res)
        default:
          res.writeHead(404)
          res.end()
      }
    })

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
