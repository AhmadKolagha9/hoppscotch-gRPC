import { describe, test, expect, beforeAll, afterAll, vi } from "vitest"
import * as E from "fp-ts/Either"
import { startTestServer, TestServerHandle } from "./fixtures/testServer"
import { executeGRPCWebCall, buildGRPCWebMethodUrl } from "../transport"
import { listServices, fetchSchemaForService } from "../reflection"
import { importProtoSources } from "../protoImport"
import { GRPCResponseEvent } from "../document"
import { HoppGRPCRequest } from "@hoppscotch/data"

// `execute.ts` pulls in `~/helpers/RequestRunner` for env-var interpolation,
// which transitively imports the GraphQL-codegen output
// (`~/helpers/backend/graphql`) that this checkout never generated (no live
// backend to introspect — see docs/specs/grpc/00-DISCOVERY-NOTES.md). None
// of these tests use `<<var>>` templating, so stub the module out rather
// than pull in unrelated GraphQL backend machinery just to satisfy an
// import chain.
vi.mock("../interpolate", () => ({
  getGRPCEffectiveEnvVariables: () => [],
}))

const { executeGRPCRequest } = await import("../execute")

/**
 * Integration tests against a real (if minimal) grpc-web server — see
 * fixtures/testServer.ts. These exercise the client end to end over an
 * actual HTTP connection, unlike the Phase 1/2 unit tests which mock fetch
 * with fixtures built from the client's own encoder.
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

describe("gRPC integration (live test server)", () => {
  let handle: TestServerHandle

  beforeAll(async () => {
    handle = await startTestServer()
  })

  afterAll(async () => {
    await handle.close()
  })

  const buildSchema = () => {
    const result = importProtoSources([
      { fileName: "test.proto", content: TEST_PROTO_SOURCE },
    ])
    if (E.isLeft(result)) throw new Error("failed to import test proto")
    return result.right
  }

  test("unary happy path", async () => {
    const schema = buildSchema()
    const RequestType = schema.root.lookupType("testdemo.HelloRequest")
    const ResponseType = schema.root.lookupType("testdemo.HelloReply")

    const requestBytes = RequestType.encode(
      RequestType.create({ name: "world" })
    ).finish()

    const messages: string[] = []

    const result = await executeGRPCWebCall({
      url: buildGRPCWebMethodUrl(
        handle.url,
        false,
        "testdemo.Greeter",
        "SayHello"
      ),
      metadata: {},
      clientVersion: "1.0.0",
      messages: [requestBytes],
      onMessage: (payload) => {
        const decoded = ResponseType.decode(payload) as unknown as {
          message: string
        }
        messages.push(decoded.message)
      },
    })()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.code).toBe(0)
    }
    expect(messages).toEqual(["Hello, world!"])
  })

  test("server-streaming happy path appends messages in order", async () => {
    const schema = buildSchema()
    const RequestType = schema.root.lookupType("testdemo.HelloRequest")
    const ResponseType = schema.root.lookupType("testdemo.HelloReply")

    const requestBytes = RequestType.encode(
      RequestType.create({ name: "streamer" })
    ).finish()

    const messages: string[] = []

    const result = await executeGRPCWebCall({
      url: buildGRPCWebMethodUrl(
        handle.url,
        false,
        "testdemo.Greeter",
        "SayHelloStream"
      ),
      metadata: {},
      clientVersion: "1.0.0",
      messages: [requestBytes],
      onMessage: (payload) => {
        const decoded = ResponseType.decode(payload) as unknown as {
          message: string
        }
        messages.push(decoded.message)
      },
    })()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.code).toBe(0)
    }
    expect(messages).toEqual([
      "Hello, streamer! (1)",
      "Hello, streamer! (2)",
      "Hello, streamer! (3)",
    ])
  })

  test("NOT_FOUND error path (zero data frames, status in the trailer frame)", async () => {
    const schema = buildSchema()
    const RequestType = schema.root.lookupType("testdemo.HelloRequest")

    const requestBytes = RequestType.encode(
      RequestType.create({ name: "ghost" })
    ).finish()

    const result = await executeGRPCWebCall({
      url: buildGRPCWebMethodUrl(
        handle.url,
        false,
        "testdemo.Greeter",
        "SayHelloMissing"
      ),
      metadata: {},
      clientVersion: "1.0.0",
      messages: [requestBytes],
    })()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      expect(result.right.code).toBe(5)
      expect(result.right.message).toBe("user not found")
    }
  })

  test("listServices via reflection returns the live server's services", async () => {
    const result = await listServices(handle.url, false, "1.0.0")()

    expect(result).toEqual(
      E.right(["testdemo.Greeter", "grpc.reflection.v1alpha.ServerReflection"])
    )
  })

  test("fetchSchemaForService via reflection resolves the Greeter schema", async () => {
    const result = await fetchSchemaForService(
      handle.url,
      false,
      "testdemo.Greeter",
      "1.0.0"
    )()

    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) return

    const service = result.right.services.find(
      (s) => s.fullName === "testdemo.Greeter"
    )
    expect(service).toBeDefined()
    expect(service?.methods.map((m) => m.name)).toEqual([
      "SayHello",
      "SayHelloStream",
      "SayHelloMissing",
    ])
    expect(
      service?.methods.find((m) => m.name === "SayHelloStream")?.serverStreaming
    ).toBe(true)
  })

  test("executeGRPCRequest runs the full pipeline end to end for a unary call", async () => {
    const schema = buildSchema()

    const request: HoppGRPCRequest = {
      v: 1,
      name: "Integration Test",
      url: handle.url,
      useTls: false,
      protoSource: {
        type: "raw",
        sources: [{ name: "test.proto", content: TEST_PROTO_SOURCE }],
      },
      service: "testdemo.Greeter",
      method: "SayHello",
      rpcType: "unary",
      body: JSON.stringify({ name: "pipeline" }),
      metadata: [],
      auth: { authType: "none", authActive: true },
    }

    const events: GRPCResponseEvent[] = []

    const result = await executeGRPCRequest(request, schema, "1.0.0", (event) =>
      events.push(event)
    )

    expect(E.isRight(result)).toBe(true)
    expect(events).toEqual([
      {
        type: "message",
        message: JSON.stringify({ message: "Hello, pipeline!" }, null, 2),
        timestamp: expect.any(Number),
      },
      { type: "status", code: 0, message: "", trailersOnly: false },
    ])
  })

  test("executeGRPCRequest surfaces the NOT_FOUND status through the pipeline", async () => {
    const schema = buildSchema()

    const request: HoppGRPCRequest = {
      v: 1,
      name: "Integration Test Error",
      url: handle.url,
      useTls: false,
      protoSource: {
        type: "raw",
        sources: [{ name: "test.proto", content: TEST_PROTO_SOURCE }],
      },
      service: "testdemo.Greeter",
      method: "SayHelloMissing",
      rpcType: "unary",
      body: JSON.stringify({ name: "ghost" }),
      metadata: [],
      auth: { authType: "none", authActive: true },
    }

    const events: GRPCResponseEvent[] = []

    const result = await executeGRPCRequest(request, schema, "1.0.0", (event) =>
      events.push(event)
    )

    expect(E.isRight(result)).toBe(true)
    expect(events).toEqual([
      {
        type: "status",
        code: 5,
        message: "user not found",
        trailersOnly: false,
      },
    ])
  })
})
