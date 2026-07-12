# Phase 0 — Discovery Notes

Findings from mapping the monorepo against `01-GRPC-PROTOCOL-SPEC.md` and `02-GRPC-FEATURE-SPEC.md`. Read those first; this doc only records what's actually in the codebase and where it disagrees with spec assumptions.

## 1. Existing protocol implementations

Two distinct tiers exist today, not one uniform pattern:

**Tier A — collection-savable, tab-based (REST, GraphQL only)**
- Request types are versioned zod/verzod entities: `HoppRESTRequest` (`packages/hoppscotch-data/src/rest/index.ts`, v0–v17) and `HoppGQLRequest` (`packages/hoppscotch-data/src/graphql/index.ts`, v1–v9).
- Both are members of the **only** discriminated request union in the codebase: `packages/hoppscotch-data/src/collection/v/2.ts:20-22` — `z.union([entityReference(HoppRESTRequest), entityReference(HoppGQLRequest)])`.
- Each has a `TabService` (`services/tab/rest.ts`, `services/tab/graphql.ts`), a `RequestTab.vue`, sidebar, headers/auth/body panels, and a response pane built from a "lens" system (REST: `components/lenses/*`) or a direct CodeMirror view (GraphQL: `components/graphql/Response.vue`).
- Execution goes through a shared **interceptor/relay abstraction** (see §2): `RequestRunner.ts` → `helpers/network.ts` → adapter (`helpers/kernel/rest|gql/request.ts`) → `KernelInterceptorService.execute(RelayRequest)` → active interceptor → `Relay.execute()`.

**Tier B — ephemeral, standalone pages (WebSocket, SSE, Socket.IO, MQTT)**
- **No `Hopp*Request` type exists for any of these.** They are not part of the collection union, cannot be saved into a collection, and are not tabs. Each lives at `pages/realtime/{websocket,sse,socketio,mqtt}.vue` holding only in-memory state (`newstore/{WebSocket,SSE,SocketIO,MQTT}Session.ts`).
- Each talks to the wire directly with the native/library client, bypassing the interceptor entirely: `WSConnection.ts` → `new WebSocket()`, `SSEConnection.ts` → `new EventSource()`, `SIOConnection.ts` → `socket.io-client`, `MQTTConnection.ts` → `paho-mqtt`.
- They share only UI chrome: `components/realtime/{Communication,Log,LogEntry,ConnectionConfig}.vue`.
- GraphQL *subscriptions* (as opposed to queries/mutations) also fall into this tier — they open a raw `new WebSocket(url, "graphql-ws")` in `helpers/graphql/connection.ts:582`, sidestepping the interceptor same as WS/SSE/MQTT.

**⚠️ Spec mismatch:** Feature spec §5 says "New sidebar entry alongside REST / GraphQL / Realtime tabs" — implying Realtime protocols are tabs today. They are not; they're standalone routes outside the tab/collection system. This matters because feature spec §3 wants `HoppGRPCRequest` persisted with collections and reopened with saved proto sources — that only makes sense if gRPC joins **Tier A** (REST/GraphQL pattern: typed union, TabService, collection-savable), not Tier B. Recommendation below.

## 2. Interceptor/agent selection mechanism

Core abstraction: `KernelInterceptorService` (`packages/hoppscotch-common/src/services/kernel-interceptor.service.ts`), operating over a shared contract defined once in `@hoppscotch/kernel` (`packages/hoppscotch-kernel/src/relay/v/1.ts`): `RelayRequest` → `RelayResponse`, single-shot (`execute(): Promise<Either<Error, RelayResponse>>`).

Five registered interceptors (`platform/std/kernel-interceptors/{browser,native,agent,extension,proxy}/index.ts`), selected at runtime via `platform.kernelInterceptors`, each declaring a `RelayCapabilities` set (headers style, auth types, certs, proxy, etc.).

**⚠️ This abstraction is REST/GraphQL(query)-only and is not stream-shaped.** `RelayResponse` is a single value (`body: Uint8Array`), not a stream. Every existing streaming protocol (WS/SSE/SocketIO/MQTT/GraphQL-subscriptions) bypasses it completely and talks to the wire directly instead. There is **no in-repo precedent for routing a streaming protocol through the interceptor/relay system.**

Consequence for gRPC: grpc-web (protocol spec §3) needs incremental frame reads from a response body stream (to support server-streaming append-as-you-go, and to detect Trailers-Only). That doesn't fit `KernelInterceptorService.execute()`'s one-shot contract today. Recommended approach: implement the grpc-web transport as its own module using `fetch()` directly with a `ReadableStream` reader (same tier as WS/SSE's direct-to-wire approach), not by routing through `KernelInterceptorService`. This keeps Phase 1 protocol code UI-independent and sidesteps extending the interceptor contract, which is out of scope for this feature. Flagging as a deviation from a literal reading of feature spec §2's "slot gRPC into that same selection mechanism" — the mechanism doesn't support streaming reads, so full reuse isn't possible without extending `RelayResponse` to be stream-shaped, which is a larger cross-protocol change I'm treating as out of scope.

## 3. Native HTTP/2-capable execution context

- **`hoppscotch-relay`** (in-repo Rust crate, curl-based via `curl::easy::Easy`) is **not actually wired into** `hoppscotch-desktop/src-tauri/Cargo.toml` or `hoppscotch-agent/src-tauri/Cargo.toml` — appears to be dead/superseded code.
- Desktop and agent both instead depend on an **external** git crate (`relay` / `tauri-plugin-relay`, from `CuriousCorrelation/relay`) outside this repo — its HTTP/2 support cannot be confirmed from here.
- `hoppscotch-agent`'s local control-plane (`src-tauri/src/route.rs`) exposes only single-shot endpoints (`POST /execute`, `POST /cancel/:req_id`) — no streaming endpoint, so even if the underlying transport supports HTTP/2, today's agent *protocol* has no way to carry a long-lived bidi stream back to the browser tab.
- `RelayRequest.version` type already models `"HTTP/2.0"`/`"HTTP/3.0"` and `AdvancedCapability` includes `"http2"`/`"http3"` (`hoppscotch-kernel/src/relay/v/1.ts`), but **no interceptor implementation currently advertises these** — the type system anticipates it, nothing implements it.

**Conclusion (per feature spec §2's explicit gating condition): no confirmed native HTTP/2 execution context exists in this codebase today.** Per spec, this means gRPC ships **web-tier only** (grpc-web, unary + server-streaming, buffer-and-send-once client-streaming, bidi disabled-with-tooltip). Native gRPC over the external `relay` crate is flagged as a follow-up requiring upstream investigation (not building new native infra, per the constraint against that).

## 4. Reusable UI components — confirmed, matches spec assumption

- JSON body editor: `packages/hoppscotch-common/src/components/http/RawBody.vue`, CodeMirror-based via `useCodemirror` composable. Reusable as-is for the protobuf-JSON message editor.
- Key-value editor: `packages/hoppscotch-common/src/components/http/KeyValue.vue` (auto-imported `HttpKeyValue`). **Already proven cross-protocol reusable** — GraphQL's `Headers.vue` uses the identical component as REST's `Headers.vue`. Will reuse directly for gRPC metadata.

## 5. Proto/SDL persistence pattern — spec mismatch, no existing pattern

Feature spec §3 says to persist proto sources "the same way Hoppscotch persists GraphQL SDL/schema today." **This pattern doesn't exist.** GraphQL never persists its schema: `helpers/graphql/connection.ts` re-introspects live on every connect and polls every 7s (`GQL_SCHEMA_POLL_INTERVAL`); the schema lives only in an in-memory `reactive()` object, never written to the request, collection, or environment. `HoppGQLRequest` has no schema field at all.

**Recommendation:** since there's no precedent to mirror, add a new field directly on `HoppGRPCRequest` (e.g. `protoSource: { type: 'raw' | 'reflection', content?: string }`) as part of its own versioned schema in `hoppscotch-data`, rather than inventing a separate collection-scoped file store. This is a new decision, not a reuse of an existing mechanism — flagging per instructions rather than silently reinterpreting the spec.

## 6. Environment variable interpolation — confirmed, matches spec assumption

- Syntax `<<var>>`, `REGEX_ENV_VAR` at `packages/hoppscotch-data/src/environment/index.ts:40`.
- `parseTemplateString`/`parseTemplateStringE` (same file, lines 103-208) is the interpolation entry point, called from `helpers/utils/EffectiveURL.ts` (`getEffectiveRESTRequest`) to build effective URL/headers/params/body right before execution. gRPC's endpoint/metadata/message-body fields will call into the same function following that pattern.

## Decisions needed before Phase 1 proceeds

1. **Tier A vs Tier B**: build gRPC as a full Tier-A citizen (typed `HoppGRPCRequest`, joins the collection union, `TabService`, sidebar tab, collection-savable) matching feature spec's persistence requirements — this is a materially bigger lift than the Realtime pages (Tier B), which is what "sidebar entry alongside Realtime tabs" in the spec's wording could otherwise be misread as. Recommend Tier A since spec §3/§5 explicitly want save/reload of proto sources and metadata, which only Tier A supports today.
2. **Transport implementation**: implement grpc-web transport as its own direct-to-wire module (fetch + streaming reader), bypassing `KernelInterceptorService`, rather than extending the interceptor contract to be stream-shaped. Extending the interceptor is possible but is a larger, cross-protocol change affecting REST/GraphQL too — treating as out of scope unless told otherwise.
3. **Proto persistence field**: new field on `HoppGRPCRequest`'s own schema (no existing pattern to mirror).
4. **Native gRPC**: explicitly out of scope this pass; flagged as a follow-up pending investigation of the external `CuriousCorrelation/relay` crate's HTTP/2 support.
