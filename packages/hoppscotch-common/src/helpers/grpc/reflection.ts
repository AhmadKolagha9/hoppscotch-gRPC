import protobuf from "protobufjs"
import "protobufjs/ext/descriptor"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import { pipe } from "fp-ts/function"
import {
  executeGRPCWebCall,
  buildGRPCWebMethodUrl,
  GRPCTransportError,
} from "./transport"
import { buildSchemaFromRoot, GRPCSchema } from "./schema"

/**
 * Client for `grpc.reflection.v1alpha.ServerReflection` (feature spec §4.1).
 *
 * The real service is defined as a bidi-streaming RPC
 * (`rpc ServerReflectionInfo(stream Request) returns (stream Response)`),
 * which protocol spec §6 rules out for the web tier. Every practical
 * grpc-web reflection client (grpcurl, grpcui, Postman's gRPC tab) works
 * around this the same way: open one grpc-web HTTP call per reflection
 * query, send exactly one request message, and read back exactly one
 * response message before the trailer — servers reply 1:1 within the
 * stream, so this fits the already-supported client-streaming
 * buffer-and-send-once model instead of needing a real bidi channel.
 */

// Fixed, versioned upstream contract (grpc/reflection/v1alpha/reflection.proto) — not user-editable.
const SERVER_REFLECTION_PROTO_SOURCE = `
syntax = "proto3";

package grpc.reflection.v1alpha;

service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest)
      returns (stream ServerReflectionResponse);
}

message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    ExtensionRequest file_containing_extension = 5;
    string all_extension_numbers_of_type = 6;
    string list_services = 7;
  }
}

message ExtensionRequest {
  string containing_type = 1;
  int32 extension_number = 2;
}

message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ExtensionNumberResponse all_extension_numbers_response = 5;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}

message FileDescriptorResponse {
  repeated bytes file_descriptor_proto = 1;
}

message ExtensionNumberResponse {
  string base_type_name = 1;
  repeated int32 extension_number = 2;
}

message ListServiceResponse {
  repeated ServiceResponse service = 1;
}

message ServiceResponse {
  string name = 1;
}

message ErrorResponse {
  int32 error_code = 1;
  string error_message = 2;
}
`

const REFLECTION_SERVICE_FULL_NAME = "grpc.reflection.v1alpha.ServerReflection"
const REFLECTION_METHOD_NAME = "ServerReflectionInfo"
const MAX_DEPENDENCY_FETCH_COUNT = 64

let reflectionRoot: protobuf.Root | undefined

const getReflectionRoot = (): protobuf.Root => {
  if (!reflectionRoot) {
    const root = new protobuf.Root()
    protobuf.parse(SERVER_REFLECTION_PROTO_SOURCE, root, { keepCase: true })
    root.resolveAll()
    reflectionRoot = root
  }
  return reflectionRoot
}

const getRequestType = () =>
  getReflectionRoot().lookupType(
    "grpc.reflection.v1alpha.ServerReflectionRequest"
  )
const getResponseType = () =>
  getReflectionRoot().lookupType(
    "grpc.reflection.v1alpha.ServerReflectionResponse"
  )

// `protobufjs/ext/descriptor` attaches these at runtime but ships no types for them.
type DescriptorExtRoot = typeof protobuf.Root & {
  fromDescriptor: (descriptor: {
    file: protobuf.Message<Record<string, unknown>>[]
  }) => protobuf.Root
}
type DescriptorNamespace = { descriptor: protobuf.Namespace }

const getFileDescriptorProtoType = (): protobuf.Type =>
  (protobuf as unknown as DescriptorNamespace).descriptor.lookupType(
    "FileDescriptorProto"
  )

const rootFromDescriptorSet = (
  files: protobuf.Message<Record<string, unknown>>[]
): protobuf.Root =>
  (protobuf.Root as unknown as DescriptorExtRoot).fromDescriptor({
    file: files,
  })

export type GRPCReflectionError =
  | { type: "TRANSPORT_ERROR"; error: GRPCTransportError }
  | { type: "GRPC_ERROR"; code: number; message: string }
  | { type: "REFLECTION_ERROR_RESPONSE"; code: number; message: string }
  | { type: "EMPTY_RESPONSE" }
  | { type: "DECODE_ERROR"; message: string }
  | { type: "TOO_MANY_DEPENDENCIES" }
  | { type: "RESOLVE_ERROR"; message: string }

type DecodedReflectionResponse = {
  list_services_response?: { service?: { name: string }[] }
  file_descriptor_response?: { file_descriptor_proto?: Uint8Array[] }
  error_response?: { error_code: number; error_message: string }
}

const sendReflectionRequest =
  (
    endpoint: string,
    useTls: boolean,
    requestMessage: Record<string, unknown>,
    clientVersion: string
  ): TE.TaskEither<GRPCReflectionError, DecodedReflectionResponse> =>
  async () => {
    const RequestType = getRequestType()
    const ResponseType = getResponseType()

    const bytes = RequestType.encode(
      RequestType.create(requestMessage)
    ).finish()

    const responses: Uint8Array[] = []

    const result = await executeGRPCWebCall({
      url: buildGRPCWebMethodUrl(
        endpoint,
        useTls,
        REFLECTION_SERVICE_FULL_NAME,
        REFLECTION_METHOD_NAME
      ),
      metadata: {},
      clientVersion,
      messages: [bytes],
      onMessage: (payload) => responses.push(payload),
    })()

    if (E.isLeft(result)) {
      return E.left({ type: "TRANSPORT_ERROR", error: result.left })
    }

    if (result.right.code !== 0) {
      return E.left({
        type: "GRPC_ERROR",
        code: result.right.code,
        message: result.right.message,
      })
    }

    if (responses.length === 0) {
      return E.left({ type: "EMPTY_RESPONSE" })
    }

    try {
      const decoded = ResponseType.decode(responses[0])
      return E.right(decoded as unknown as DecodedReflectionResponse)
    } catch (error) {
      return E.left({
        type: "DECODE_ERROR",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

export const listServices = (
  endpoint: string,
  useTls: boolean,
  clientVersion: string
): TE.TaskEither<GRPCReflectionError, string[]> =>
  pipe(
    sendReflectionRequest(
      endpoint,
      useTls,
      { list_services: "" },
      clientVersion
    ),
    TE.chain((response): TE.TaskEither<GRPCReflectionError, string[]> => {
      if (response.error_response) {
        return TE.left({
          type: "REFLECTION_ERROR_RESPONSE",
          code: response.error_response.error_code,
          message: response.error_response.error_message,
        })
      }

      const services = response.list_services_response?.service ?? []
      return TE.right(services.map((service) => service.name))
    })
  )

/**
 * Walks the transitive dependency closure (`FileDescriptorProto.dependency`)
 * of the file that defines `seedRequest`'s target, issuing one
 * `file_by_filename` reflection call per not-yet-seen dependency, so the
 * resulting descriptor set is self-contained enough for `Root.fromDescriptor`
 * to resolve every cross-file type reference.
 */
const collectFileDescriptors =
  (
    endpoint: string,
    useTls: boolean,
    clientVersion: string,
    seedRequest: Record<string, unknown>
  ): TE.TaskEither<
    GRPCReflectionError,
    protobuf.Message<Record<string, unknown>>[]
  > =>
  async () => {
    const FileDescriptorProtoType = getFileDescriptorProtoType()

    const visited = new Set<string>()
    const queued = new Set<string>()
    const collected: protobuf.Message<Record<string, unknown>>[] = []
    const queue: Record<string, unknown>[] = [seedRequest]

    while (queue.length > 0) {
      if (visited.size > MAX_DEPENDENCY_FETCH_COUNT) {
        return E.left({ type: "TOO_MANY_DEPENDENCIES" })
      }

      const request = queue.shift() as Record<string, unknown>
      const result = await sendReflectionRequest(
        endpoint,
        useTls,
        request,
        clientVersion
      )()

      if (E.isLeft(result)) return result

      const response = result.right

      if (response.error_response) {
        return E.left({
          type: "REFLECTION_ERROR_RESPONSE",
          code: response.error_response.error_code,
          message: response.error_response.error_message,
        })
      }

      const fileBytesList =
        response.file_descriptor_response?.file_descriptor_proto ?? []

      for (const fileBytes of fileBytesList) {
        const fileDescriptor = FileDescriptorProtoType.decode(
          fileBytes
        ) as unknown as protobuf.Message<Record<string, unknown>> & {
          name: string
          dependency?: string[]
        }

        if (visited.has(fileDescriptor.name)) continue
        visited.add(fileDescriptor.name)
        collected.push(fileDescriptor)

        for (const dependency of fileDescriptor.dependency ?? []) {
          if (!visited.has(dependency) && !queued.has(dependency)) {
            queued.add(dependency)
            queue.push({ file_by_filename: dependency })
          }
        }
      }
    }

    return E.right(collected)
  }

/** Fetches the full schema (service + every message/enum it transitively depends on) for one service, by fully-qualified name. */
export const fetchSchemaForService = (
  endpoint: string,
  useTls: boolean,
  serviceFullName: string,
  clientVersion: string
): TE.TaskEither<GRPCReflectionError, GRPCSchema> =>
  pipe(
    collectFileDescriptors(endpoint, useTls, clientVersion, {
      file_containing_symbol: serviceFullName,
    }),
    TE.chain(
      (fileDescriptors): TE.TaskEither<GRPCReflectionError, GRPCSchema> => {
        try {
          const root = rootFromDescriptorSet(fileDescriptors)
          root.resolveAll()
          return TE.right(buildSchemaFromRoot(root))
        } catch (error) {
          return TE.left({
            type: "RESOLVE_ERROR",
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    )
  )
