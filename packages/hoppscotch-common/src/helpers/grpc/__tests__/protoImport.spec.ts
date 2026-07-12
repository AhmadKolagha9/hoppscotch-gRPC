import { describe, test, expect } from "vitest"
import * as E from "fp-ts/Either"
import { importProtoSources } from "../protoImport"

const GREETER_PROTO = `
syntax = "proto3";
package demo;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc SayHelloStream (HelloRequest) returns (stream HelloReply);
  rpc SayHelloBidi (stream HelloRequest) returns (stream HelloReply);
}

message HelloRequest {
  string name = 1;
  repeated string tags = 2;
}

message HelloReply {
  string message = 1;
  Status status = 2;
}

enum Status {
  UNKNOWN = 0;
  OK = 1;
  ERROR = 2;
}
`

describe("importProtoSources", () => {
  test("extracts services with method streaming flags", () => {
    const result = importProtoSources([
      { fileName: "greeter.proto", content: GREETER_PROTO },
    ])

    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) return

    expect(result.right.services).toHaveLength(1)
    const service = result.right.services[0]
    expect(service.fullName).toBe("demo.Greeter")
    expect(service.methods).toEqual([
      {
        name: "SayHello",
        fullName: "demo.Greeter.SayHello",
        requestType: "demo.HelloRequest",
        responseType: "demo.HelloReply",
        clientStreaming: false,
        serverStreaming: false,
      },
      {
        name: "SayHelloStream",
        fullName: "demo.Greeter.SayHelloStream",
        requestType: "demo.HelloRequest",
        responseType: "demo.HelloReply",
        clientStreaming: false,
        serverStreaming: true,
      },
      {
        name: "SayHelloBidi",
        fullName: "demo.Greeter.SayHelloBidi",
        requestType: "demo.HelloRequest",
        responseType: "demo.HelloReply",
        clientStreaming: true,
        serverStreaming: true,
      },
    ])
  })

  test("extracts message fields including repeated and enum-typed fields", () => {
    const result = importProtoSources([
      { fileName: "greeter.proto", content: GREETER_PROTO },
    ])

    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) return

    expect(result.right.messages["demo.HelloRequest"].fields).toEqual([
      { name: "name", type: "string", repeated: false, kind: "scalar" },
      { name: "tags", type: "string", repeated: true, kind: "scalar" },
    ])

    expect(result.right.messages["demo.HelloReply"].fields).toEqual([
      { name: "message", type: "string", repeated: false, kind: "scalar" },
      { name: "status", type: "demo.Status", repeated: false, kind: "enum" },
    ])
  })

  test("extracts enum values", () => {
    const result = importProtoSources([
      { fileName: "greeter.proto", content: GREETER_PROTO },
    ])

    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) return

    expect(result.right.enums["demo.Status"]).toEqual({
      fullName: "demo.Status",
      values: [
        { name: "UNKNOWN", number: 0 },
        { name: "OK", number: 1 },
        { name: "ERROR", number: 2 },
      ],
    })
  })

  test("resolves cross-file references when multiple sources are supplied", () => {
    const common = `
      syntax = "proto3";
      package demo.common;
      message Money { int64 cents = 1; string currency = 2; }
    `
    const main = `
      syntax = "proto3";
      package demo;
      import "common.proto";
      message Order { demo.common.Money total = 1; }
      service OrderService {
        rpc GetOrder (Order) returns (Order);
      }
    `

    const result = importProtoSources([
      { fileName: "common.proto", content: common },
      { fileName: "main.proto", content: main },
    ])

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

  test("extracts map fields", () => {
    const source = `
      syntax = "proto3";
      package demo;
      message Config {
        map<string, string> labels = 1;
      }
    `

    const result = importProtoSources([
      { fileName: "config.proto", content: source },
    ])

    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) return

    expect(result.right.messages["demo.Config"].fields).toEqual([
      {
        name: "labels",
        type: "string",
        repeated: false,
        kind: "map",
        mapKeyType: "string",
        mapValueType: "string",
      },
    ])
  })

  test("returns a PARSE_ERROR for invalid proto syntax", () => {
    const result = importProtoSources([
      { fileName: "broken.proto", content: "this is not valid proto {{{" },
    ])

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.type).toBe("PARSE_ERROR")
    }
  })

  test("returns a RESOLVE_ERROR when a referenced type is never defined", () => {
    const source = `
      syntax = "proto3";
      package demo;
      message Order { demo.missing.Thing thing = 1; }
    `

    const result = importProtoSources([
      { fileName: "main.proto", content: source },
    ])

    expect(E.isLeft(result)).toBe(true)
    if (E.isLeft(result)) {
      expect(result.left.type).toBe("RESOLVE_ERROR")
    }
  })
})
