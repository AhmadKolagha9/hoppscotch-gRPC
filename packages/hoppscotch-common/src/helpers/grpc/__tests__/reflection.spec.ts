import { describe, test, expect, vi, afterEach } from "vitest"
import protobuf from "protobufjs"
import "protobufjs/ext/descriptor"
import * as E from "fp-ts/Either"
import { encodeFrame, encodeTrailerFrame, concatBytes } from "../frame"
import { listServices, fetchSchemaForService } from "../reflection"

/**
 * These tests simulate a `grpc.reflection.v1alpha.ServerReflection` server
 * at the fetch layer: they build real `ServerReflectionResponse` protobuf
 * bytes and hand them back framed as grpc-web, the same way a real server's
 * bytes would arrive. This exercises the reflection client's request
 * encoding, response decoding, and dependency-chasing logic end to end
 * without needing a live server (Phase 4 covers that with a real one).
 */

type DescriptorNamespace = { descriptor: protobuf.Namespace }
const getFileDescriptorProtoType = (): protobuf.Type =>
  (protobuf as unknown as DescriptorNamespace).descriptor.lookupType(
    "FileDescriptorProto"
  )
type DescriptorExtRoot = typeof protobuf.Root & {
  prototype: {
    toDescriptor: (syntax?: string) => protobuf.Message<
      Record<string, unknown>
    > & {
      file: protobuf.Message<Record<string, unknown>>[]
    }
  }
}

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

const buildReflectionTypes = () => {
  const root = new protobuf.Root()
  protobuf.parse(REFLECTION_PROTO_SOURCE, root, { keepCase: true })
  root.resolveAll()
  return {
    RequestType: root.lookupType(
      "grpc.reflection.v1alpha.ServerReflectionRequest"
    ),
    ResponseType: root.lookupType(
      "grpc.reflection.v1alpha.ServerReflectionResponse"
    ),
  }
}

/** Compiles a .proto source into the raw FileDescriptorProto bytes a real reflection server would return. */
const fileDescriptorProtoBytesFor = (source: string): Uint8Array => {
  const root = new protobuf.Root()
  protobuf.parse(source, root, { keepCase: true })
  root.resolveAll()

  const fileDescriptorSet = (
    root as unknown as InstanceType<DescriptorExtRoot>
  ).toDescriptor("proto3")

  const FileDescriptorProtoType = getFileDescriptorProtoType()
  // test fixtures only ever compile a single logical file per source string
  return FileDescriptorProtoType.encode(fileDescriptorSet.file[0]).finish()
}

type MessageTypeDescriptor = {
  name: string
  field?: { name: string; typeName?: string }[]
  nestedType?: MessageTypeDescriptor[]
}

/**
 * protobufjs's own `toDescriptor()` doesn't always emit fully-qualified
 * `type_name`s for cross-package field references (it can produce
 * `"common.Money"` instead of the `.demo.common.Money` real protoc/servers
 * always emit). Fix field type names up from the original resolved root so
 * these test fixtures match what a real reflection server actually sends.
 */
const fixCrossPackageTypeNames = (
  root: protobuf.Root,
  fileDescriptorSet: {
    file: ({ package?: string } & MessageTypeDescriptor & {
        messageType?: MessageTypeDescriptor[]
      })[]
  }
) => {
  const fixMessage = (
    descriptor: MessageTypeDescriptor,
    protoType: protobuf.Type
  ) => {
    for (const field of descriptor.field ?? []) {
      const protoField = protoType.fields[field.name]
      if (protoField?.resolvedType) {
        field.typeName = `.${protoField.resolvedType.fullName.replace(/^\./, "")}`
      }
    }
    for (const nested of descriptor.nestedType ?? []) {
      const nestedProtoType = protoType.nested?.[nested.name]
      if (nestedProtoType instanceof protobuf.Type) {
        fixMessage(nested, nestedProtoType)
      }
    }
  }

  for (const file of fileDescriptorSet.file) {
    for (const messageDescriptor of file.messageType ?? []) {
      const protoType = root.lookupType(
        (file.package ? `${file.package}.` : "") + messageDescriptor.name
      )
      fixMessage(messageDescriptor, protoType)
    }
  }
}

/**
 * Compiles multiple cross-referencing sources together (so `resolveAll`
 * succeeds), then returns each file's individually-encoded
 * FileDescriptorProto bytes keyed by its package — mirroring what a real
 * reflection server hands back one `file_by_filename` call at a time.
 */
const fileDescriptorProtoBytesByPackage = (
  sources: string[],
  /** package -> packages it depends on. protobufjs's toDescriptor() doesn't populate `dependency` itself (unlike real protoc output), so tests that exercise dependency-chasing must supply it explicitly. */
  dependencies: Record<string, string[]> = {}
): Record<string, Uint8Array> => {
  const root = new protobuf.Root()
  for (const source of sources) {
    protobuf.parse(source, root, { keepCase: true })
  }
  root.resolveAll()

  const fileDescriptorSet = (
    root as unknown as InstanceType<DescriptorExtRoot>
  ).toDescriptor("proto3") as unknown as {
    file: ({
      package?: string
      name: string
      dependency?: string[]
    } & MessageTypeDescriptor & {
        messageType?: MessageTypeDescriptor[]
      })[]
  }

  fixCrossPackageTypeNames(root, fileDescriptorSet)

  const nameByPackage = new Map(
    fileDescriptorSet.file.map((file) => [file.package ?? "", file.name])
  )

  for (const file of fileDescriptorSet.file) {
    const deps = dependencies[file.package ?? ""] ?? []
    file.dependency = deps.map((depPackage) => {
      const depName = nameByPackage.get(depPackage)
      if (!depName) {
        throw new Error(
          `test fixture error: unknown dependency package "${depPackage}"`
        )
      }
      return depName
    })
  }

  const FileDescriptorProtoType = getFileDescriptorProtoType()
  const result: Record<string, Uint8Array> = {}

  for (const file of fileDescriptorSet.file) {
    result[file.package ?? ""] = FileDescriptorProtoType.encode(file).finish()
  }

  return result
}

const grpcWebResponseBody = (messages: Uint8Array[]): Uint8Array =>
  concatBytes(
    ...messages.map((m) => encodeFrame(m)),
    encodeTrailerFrame({ "grpc-status": "0" })
  )

const mockFetchSequence = (bodies: Uint8Array[]) => {
  const fetchMock = vi.fn()
  for (const body of bodies) {
    fetchMock.mockImplementationOnce(async () => new Response(body as BodyInit))
  }
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("listServices", () => {
  afterEach(() => vi.unstubAllGlobals())

  test("decodes the list of services from a ListServiceResponse", async () => {
    const { ResponseType } = buildReflectionTypes()
    const response = ResponseType.encode(
      ResponseType.create({
        list_services_response: {
          service: [{ name: "demo.Greeter" }, { name: "demo.Other" }],
        },
      })
    ).finish()

    mockFetchSequence([grpcWebResponseBody([response])])

    const result = await listServices("localhost:9090", false, "1.0.0")()

    expect(result).toEqual(E.right(["demo.Greeter", "demo.Other"]))
  })

  test("surfaces a REFLECTION_ERROR_RESPONSE when the server returns an ErrorResponse", async () => {
    const { ResponseType } = buildReflectionTypes()
    const response = ResponseType.encode(
      ResponseType.create({
        error_response: { error_code: 12, error_message: "not implemented" },
      })
    ).finish()

    mockFetchSequence([grpcWebResponseBody([response])])

    const result = await listServices("localhost:9090", false, "1.0.0")()

    expect(result).toEqual(
      E.left({
        type: "REFLECTION_ERROR_RESPONSE",
        code: 12,
        message: "not implemented",
      })
    )
  })
})

describe("fetchSchemaForService", () => {
  afterEach(() => vi.unstubAllGlobals())

  test("builds a schema from a single file with no dependencies", async () => {
    const source = `
      syntax = "proto3";
      package demo;
      service Greeter {
        rpc SayHello (HelloRequest) returns (HelloReply);
      }
      message HelloRequest { string name = 1; }
      message HelloReply { string message = 1; }
    `
    const { ResponseType } = buildReflectionTypes()
    const fileBytes = fileDescriptorProtoBytesFor(source)
    const response = ResponseType.encode(
      ResponseType.create({
        file_descriptor_response: { file_descriptor_proto: [fileBytes] },
      })
    ).finish()

    mockFetchSequence([grpcWebResponseBody([response])])

    const result = await fetchSchemaForService(
      "localhost:9090",
      false,
      "demo.Greeter",
      "1.0.0"
    )()

    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) return

    expect(result.right.services.map((s) => s.fullName)).toEqual([
      "demo.Greeter",
    ])
    expect(result.right.messages["demo.HelloRequest"]).toBeDefined()
    expect(result.right.messages["demo.HelloReply"]).toBeDefined()
  })

  test("chases a cross-file dependency via a second file_by_filename call", async () => {
    const commonSource = `
      syntax = "proto3";
      package demo.common;
      message Money { int64 cents = 1; }
    `
    const mainSource = `
      syntax = "proto3";
      package demo;
      import "common.proto";
      service OrderService {
        rpc GetOrder (Order) returns (Order);
      }
      message Order { demo.common.Money total = 1; }
    `

    const { ResponseType } = buildReflectionTypes()

    const filesByPackage = fileDescriptorProtoBytesByPackage(
      [commonSource, mainSource],
      { demo: ["demo.common"] }
    )
    const mainFileBytes = filesByPackage["demo"]
    const commonFileBytes = filesByPackage["demo.common"]

    const firstResponse = ResponseType.encode(
      ResponseType.create({
        file_descriptor_response: { file_descriptor_proto: [mainFileBytes] },
      })
    ).finish()

    const secondResponse = ResponseType.encode(
      ResponseType.create({
        file_descriptor_response: {
          file_descriptor_proto: [commonFileBytes],
        },
      })
    ).finish()

    mockFetchSequence([
      grpcWebResponseBody([firstResponse]),
      grpcWebResponseBody([secondResponse]),
    ])

    const result = await fetchSchemaForService(
      "localhost:9090",
      false,
      "demo.OrderService",
      "1.0.0"
    )()

    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) return

    expect(result.right.messages["demo.Order"].fields).toEqual([
      {
        name: "total",
        type: "demo.common.Money",
        repeated: false,
        kind: "message",
      },
    ])
    expect(result.right.messages["demo.common.Money"]).toBeDefined()
  })

  test("surfaces a GRPC_ERROR when the reflection call itself fails at the grpc-status level", async () => {
    mockFetchSequence([
      encodeTrailerFrame({ "grpc-status": "5", "grpc-message": "not found" }),
    ])

    const result = await fetchSchemaForService(
      "localhost:9090",
      false,
      "demo.Missing",
      "1.0.0"
    )()

    expect(result).toEqual(
      E.left({ type: "GRPC_ERROR", code: 5, message: "not found" })
    )
  })
})
