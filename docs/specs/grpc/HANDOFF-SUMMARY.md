# gRPC Support — Handoff Summary

Implemented against `01-GRPC-PROTOCOL-SPEC.md` and `02-GRPC-FEATURE-SPEC.md` in this directory, following the discovery notes in `00-DISCOVERY-NOTES.md`. This doc covers what was built, what was deliberately scoped out, deviations from the two spec files, and what's still open.

## What was built

### Protocol layer (`packages/hoppscotch-common/src/helpers/grpc/`)

- **`frame.ts`** — grpc-web message framing: `encodeFrame`/`encodeTrailerFrame`, `decodeFrames` (whole-body), `GRPCWebFrameDecoder` (incremental, for streaming reads), `parseTrailerMetadata`, `resolveGRPCStatus` (handles Trailers-Only — status via HTTP headers when the body carries no trailer frame at all).
- **`contentType.ts`** — content-type/header negotiation (`+proto`/`+json`, binary vs. grpc-web-text base64), request header builder (never sets `User-Agent`, sets `X-User-Agent`).
- **`transport.ts`** — the actual fetch-based grpc-web client (`executeGRPCWebCall`): sends a request, streams the response through the frame decoder, invokes a callback per data frame, resolves the terminal status.
- **`reflection.ts`** — `grpc.reflection.v1alpha.ServerReflection` client (embedded, fixed proto contract): `listServices`, `fetchSchemaForService` (walks the `FileDescriptorProto.dependency` closure via `file_by_filename` calls).
- **`protoImport.ts`** — manual `.proto` import via `protobufjs`, multi-file aware.
- **`schema.ts`** — the shared internal service/method/message/enum representation both discovery paths feed into (feature spec §4).
- **`skeleton.ts`** — builds a default-value JSON skeleton from a message schema for the "auto-populate body on method select" convenience (feature spec §5).
- **`statusCodes.ts`** — the 0–16 gRPC status code → name table.
- **`execute.ts`** — orchestrates one full call: env-var interpolation → JSON→protobuf encoding → transport → response decoding → response-event log.
- **`interpolate.ts`** — `<<var>>` interpolation wired into the same `parseTemplateString`/`filterNonEmptyEnvironmentVariables` REST uses (global + selected environment only — see scoping note below).
- **`document.ts`** — `HoppGRPCDocument` (the live tab state) and `GRPCResponseEvent` (message/status/error log entries).

### Data model (`packages/hoppscotch-data/src/grpc/`)

- `HoppGRPCRequest` v1 — versioned entity matching the `HoppRESTRequest`/`HoppGQLRequest` pattern exactly (`createVersionedEntity`, `defineVersion`).
- `HoppCollection` bumped to **v13** (`packages/hoppscotch-data/src/collection/v/13.ts`) to add `HoppGRPCRequest` to the collection's request union. This is a real versioned migration — old collections migrate forward via `up()`, nothing was edited in place on earlier versions.
- Reuses `HoppRESTAuth` for the `auth` field per feature spec §3's "reuse existing auth union" instruction.

### UI (`packages/hoppscotch-common/src/components/grpc/`, `pages/grpc.vue`)

- New sidebar entry (`/grpc`, network icon) and tab-window page, matching the REST/GraphQL tab system (`GRPCTabService`, persisted via `STORE_KEYS.GRPC_TABS`).
- `RequestOptions.vue` — endpoint/TLS bar + Invoke/Cancel, four tabs: **Proto** (source panel + service/method tree), **Metadata** (reuses `HttpKeyValue`), **Message** (reuses the `useCodemirror` pattern from `RawBody.vue`), **Authorization** (reuses `HttpAuthorizationBasic`/`HttpAuthorizationApiKey`).
- `ProtoSource.vue` — toggle between server reflection and raw `.proto` paste/upload; once resolved, a service/method tree that populates `service`/`method`/`rpcType` and the message skeleton on click.
- `Response.vue` — message log (unary = 1 entry, server-streaming = N appended entries with a running count and stop control) + named status code.
- Bidi-streaming: Invoke button disabled with a tooltip explaining why (protocol spec §6's explicit instruction — not hidden, not faked).
- Client-streaming: body editor accepts a JSON array (one element per buffered message, sent as one request per protocol spec §6's buffer-and-send-once rule), with an inline hint explaining this.

### Tests

- 53 unit tests (Phase 1/2): frame codec fixtures (including Trailers-Only and malformed-frame cases per feature spec §7), content-type negotiation, `protoImport`, `transport` (mocked fetch), `reflection` (mocked fetch, simulating a fake reflection server with real protobuf bytes).
- 7 integration tests (Phase 4) against a real local grpc-web server (`__tests__/fixtures/testServer.ts`) covering unary happy path, server-streaming happy path, a NOT_FOUND error path, `listServices`/`fetchSchemaForService` against a live server, and the full `execute.ts` pipeline end to end. The test server's frame/reflection encoding is written independently of the client's own `frame.ts`/`reflection.ts` — reusing the client's encoder to build server fixtures would let a symmetric bug hide from every test. This paid off: it caught a real protobufjs behavior (decoding a message re-materializes every *scalar* oneof sibling to its zero value, e.g. an unset `list_services` string decodes to `""` not `undefined` — checking presence needs the virtual oneof discriminator property, not `!== undefined`). The production `reflection.ts` code was already safe (it checks object-typed oneof members, which decode to `null` when unset, via truthy/optional-chaining), but this is exactly the class of bug that only turns up when a genuinely separate implementation talks to your parser.
- Full `hoppscotch-common` suite: 1025 passing (up from 998 baseline), no regressions. Verified live in a real browser (headless Chromium) — proto import → schema resolution → method selection → skeleton-populated body all confirmed working end to end with no console errors.

## Deviations from the two spec files (and why)

1. **`ServerReflectionInfo` isn't truly bidi in this client.** The real RPC is `stream Request → stream Response`, which protocol spec §6 rules out for the web tier. Implemented the way every practical grpc-web reflection client (grpcurl, grpcui, Postman) does it: one grpc-web HTTP call per query, one request message in, one response out. Fits the already-agreed client-streaming buffer-and-send-once model rather than needing a real bidi channel. Noted inline in `reflection.ts`.
2. **grpc-web transport bypasses `KernelInterceptorService`.** That abstraction is single-shot request/response; grpc-web needs incremental frame reads off a live stream. Every existing streaming protocol in this codebase (WS/SSE/MQTT) already talks to the wire directly for the same reason — see discovery notes §2. `transport.ts` uses `fetch` + `ReadableStream` directly instead.
3. **No GraphQL-SDL-persistence pattern existed to mirror** (feature spec §3 assumed one). GraphQL never persists its schema — it re-introspects live every connect. `HoppGRPCRequest.protoSource` is a new field shape (`{type: "raw", sources}` or `{type: "reflection"}`) designed from scratch, not adapted from an existing mechanism.
4. **Native/desktop gRPC is out of scope**, confirmed by Phase 0: no execution context in this codebase demonstrably speaks HTTP/2 today. The in-repo `hoppscotch-relay` crate is dead code; desktop/agent depend on an external, unauditable-from-here git crate (`CuriousCorrelation/relay`). Flagged as a follow-up requiring upstream investigation, not built here — matches the constraint against adding new native infra.

## Explicitly scoped out (flagged during Phase 3, not silently dropped)

- **Collection-tree "Save to collection" UI** — no folder tree, save modal, or spotlight-search integration for gRPC requests. The data model already supports it (`HoppGRPCSaveContext`, the v13 collection union), so a future pass can wire this up without another schema migration. Tabs still persist locally across sessions in the meantime (same tab-persistence mechanism as REST/GraphQL).
- **Auth UI parity** — only None / Basic / Bearer / API Key are selectable in the gRPC Authorization tab, not the full REST set (Digest, AWS Signature, HAWK, OAuth2, JWT, NTLM, ASAP, Akamai EdgeGrid). The `HoppRESTAuth` type still allows all of them (per the "reuse existing auth union" instruction), but `execute.ts`'s `authToMetadata` only implements the four selectable ones — building full parity would mean re-deriving OAuth2 token flows etc. for a header-only transport where most of those methods don't obviously apply.
- **Request-variable / inherited-collection-variable interpolation** — gRPC env interpolation covers global + selected environment only (matching REST/GraphQL's precedence for those two sources), not request-level variables or inherited collection variables, since neither concept exists for gRPC yet (no collection-tree integration).
- **No prettify/AI-assist buttons** on the message body editor, no bulk-edit mode on the metadata editor, no drag-to-reorder — present on REST's equivalents but skipped here as scope, not oversights.

## Remaining gaps / follow-ups

- **Live-browser verification used a workaround for a pre-existing gap**, not something introduced by this feature: `packages/hoppscotch-common/src/helpers/backend/graphql.ts` is a GraphQL-codegen output file that was never generated in this checkout (no `gql-gen/*.gql` schema source, no live backend to introspect). It blocks *any* page — including REST and GraphQL — from booting in this dev environment, not just `/grpc`. Verification used a temporary local stub (deleted afterward, never committed) to unblock the dev server long enough to drive the actual gRPC UI in headless Chromium. Whoever next runs this checkout with a real backend configured should re-verify once codegen can actually run.
- **`vue-tsc` is broken in this checkout** (version mismatch: `vue-tsc@1.8.8` vs the installed TypeScript 5.9.3), and plain project-wide `tsc` fails on an unrelated pre-existing corrupt `src/types/post-request.d.ts`. Neither is caused by this feature. All new `.ts` files were typechecked in isolation (clean) against the project's real path aliases/lib config; `.vue` files could not be typechecked by any working tool in this environment and were instead verified by running the app.
- **No test coverage for the Vue components themselves** (only the underlying helpers have unit tests) — the browser-driven manual pass covered the golden path (proto import → method select → skeleton) but not every UI branch (error states in the proto/reflection panels, metadata add/remove edge cases, response log rendering for a real streaming call, etc.).
- **Desktop/native gRPC**: flagged, not built (see deviation #4 above). The `CuriousCorrelation/relay` crate desktop/agent actually depend on would need to be audited for HTTP/2 support before this is even feasible, and the agent's local control-plane (`hoppscotch-agent/src-tauri/src/route.rs`) would need a new streaming endpoint — its `/execute` is single-shot today.
- **Collection-tree UI** for saving/organizing gRPC requests (see scoping note above) — the biggest deferred item, `saveContext` plumbing is in place but nothing populates or reads it yet.
