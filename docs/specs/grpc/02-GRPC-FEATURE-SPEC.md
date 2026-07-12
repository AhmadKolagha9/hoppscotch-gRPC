# gRPC Feature Spec — Hoppscotch

Companion to `01-GRPC-PROTOCOL-SPEC.md`. Read that first for wire-level rules.

## 1. Prior art / why this is greenfield in this codebase

- Upstream tracking issue is `hoppscotch/hoppscotch#402`, open since Dec 2019, still unimplemented as of the current `main` (2026.5.0). No partial gRPC code to build on — this is a new protocol module, same tier as the existing WebSocket / SSE / Socket.IO / MQTT / GraphQL modules.
- A 2022 externship proposal (discussion #1646) scoped it as: gRPC reflection for method discovery, request/response testing UI, new sidebar section — that scoping still holds and is adopted below.
- Reference for prior art on UI/UX patterns: `awesome-grpc#gui` tools (BloomRPC, Kreya, grpcurl, Postman's gRPC tab) — useful for interaction design, not for wire code (don't port code, MIT/license-check anything you'd actually reuse).

## 2. Transport decision (the one architectural call this spec makes)

Per protocol spec §6, true bidi/client-streaming gRPC isn't achievable from a pure browser tab. Hoppscotch already ships multiple execution contexts (browser tab, browser extension, desktop app) specifically to work around browser transport limits for other protocols — **before writing any gRPC code, Claude Code must inventory how Hoppscotch currently routes requests through these contexts** (interceptor/agent selection, however it's currently named in the codebase) and slot gRPC into that same selection mechanism rather than inventing a parallel one.

Default behavior to implement:

- **Web/extension context:** grpc-web framing only (protocol spec above). Unary + server-streaming fully supported. Client-streaming = buffer-and-send-once. Bidi-streaming = disabled with an explanatory tooltip, not hidden — users should see gRPC exists and understand why bidi is greyed out here.
- **Desktop/agent context (if the codebase has a native process capable of real HTTP/2):** full native gRPC, all four RPC types. If no such native execution path currently exists in the codebase, do not build one as part of this feature — ship the web-tier version only and flag the gap in the handoff doc.

This mirrors how the other streaming protocols (WebSocket, MQTT) are already gated by execution context in Hoppscotch — confirm the actual gating mechanism during exploration rather than assuming.

## 3. Data model additions

New request type, sibling to existing `HoppRESTRequest` / `HoppGQLRequest` / `HoppWSRequest` etc. (match whatever the actual type union is named in the codebase):

```
HoppGRPCRequest {
  url: string                  // host:port, no scheme
  useTls: boolean
  protoPath: string | ProtoFile[]   // imported .proto source(s), or reflection-derived
  service: string
  method: string
  rpcType: 'unary' | 'server-streaming' | 'client-streaming' | 'bidi-streaming'
  requestBody: string          // JSON representation of the protobuf message, editor-friendly
  metadata: KeyValuePair[]     // becomes grpc-web headers per protocol spec §5
  auth: HoppAuth               // reuse existing auth union, don't build a parallel auth system
}
```

Persist proto definitions the same way Hoppscotch persists GraphQL SDL/schema today (collection-scoped or workspace-scoped file, check existing pattern) so re-opening a saved gRPC request doesn't require re-uploading the `.proto`.

## 4. Method discovery — two paths, both required

1. **Server reflection** (`grpc.reflection.v1alpha.ServerReflection`) — if the target server has reflection enabled, fetch service/method list live. This is the primary path for most real-world testing.
2. **Manual `.proto` import** — for servers without reflection (production services usually disable it). Parse with `protobufjs` (already MIT, widely used, no license concern) to extract services/methods/message shapes for the request builder to render as a form.

Both paths feed the same internal service/method representation — the request builder shouldn't care which source it came from.

## 5. UI requirements

New sidebar entry alongside REST / GraphQL / Realtime tabs (match existing icon/nav pattern):

- Endpoint input (`host:port`) + TLS toggle, same visual weight as the URL bar elsewhere.
- Proto source panel: file upload, paste-raw-source, or "Use server reflection" toggle.
- Service/method tree once a proto source resolves — selecting a method auto-populates a request body skeleton from the message schema (all fields present, empty/default values), same spirit as GraphQL's query-from-schema convenience.
- Request body editor: JSON view of the protobuf message (not raw binary) — reuse the existing JSON editor component used for REST bodies rather than building a new one.
- Metadata tab: reuses the existing key-value header editor component.
- Response pane:
  - Unary: single message + trailer status (`grpc-status`, `grpc-message`), styled consistent with REST's status/headers split.
  - Server-streaming: append messages to a list as frames arrive, with a running count and a "stop" control (since the stream may be long-lived or infinite).
  - Errors: gRPC status codes (0–16) must render as their named constant (`NOT_FOUND`, `UNAVAILABLE`, etc.), not just the numeric code — add the standard gRPC status-code table as a lookup, don't hardcode strings inline in the UI component.
- Environment variable interpolation (`<<var>>` or whatever Hoppscotch's current syntax is) must work in the endpoint, metadata values, and request body fields — same as every other protocol tab.

## 6. Explicit non-goals for v1

- No bidi-streaming in the web build (see §2).
- No `.proto` → mock server generation.
- No gRPC-over-HTTP/2-native support unless the codebase already has a native agent process to host it (see §2) — don't build new native infra as a side effect of this feature.
- No retry/keep-alive logic beyond whatever REST already has (protocol spec §7).

## 7. Testing

- Unit tests for the frame parser (length-prefix + trailer-frame parsing) using fixture byte sequences, including a Trailers-Only case and a malformed-frame case (trailer not last).
- Integration test against a local test gRPC server (spin up a minimal Node/Go gRPC service with reflection enabled in the test harness) covering unary and server-streaming happy paths plus a `NOT_FOUND` error path.
