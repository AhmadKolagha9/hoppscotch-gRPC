# gRPC Protocol Spec for Hoppscotch

Source: `grpc/grpc` `doc/PROTOCOL-WEB.md` (uploaded), cross-checked against `PROTOCOL-HTTP2.md` framing it deltas from.

## 1. Core constraint

Browsers cannot originate native HTTP/2 gRPC: no control over HTTP/2 frames, no access to trailers via `fetch`/`XHR`. This is the entire reason grpc-web exists. Any in-browser Hoppscotch tab is bound by this — it doesn't matter that the desktop/agent build can do more; the spec below defines the wire contract for what the client emits, not how it reaches the target server.

## 2. Content-Type negotiation

Client must set one of:

- `application/grpc-web+proto` (binary protobuf, default when unspecified)
- `application/grpc-web+json`
- `application/grpc-web-text+proto` — base64-encoded body, required fallback for environments that can't stream binary (kept for parity with the spec; not required for MVP since Hoppscotch controls its own client, but the request builder should expose it as a toggle for testing legacy servers)

`Accept` header must mirror the response encoding the client wants. Default to `application/grpc-web` when message format isn't explicit and treat as `+proto`.

## 3. Message framing (client → server, and to render server → client)

Every message frame:

```
[1 byte flags][4 bytes big-endian length][message bytes]
```

Flags byte, only the MSB is defined:

- `0x00` — data frame
- `0x80` — uncompressed trailer frame
- `0x81` — compressed trailer frame

Trailers are **not** HTTP/2 trailers here — they're encoded as an HTTP/1-style header block (`key: value\r\n`, no terminating blank line) inside the final length-prefixed frame of the response body. The client's response parser must:

1. Read frames sequentially from the body stream.
2. On a frame with MSB set, stop treating it as a message — parse its payload as `key: value\r\n` pairs. This is the gRPC status (`grpc-status`, `grpc-message`, plus any custom trailer metadata).
3. Enforce that a trailer frame is the last frame. A body that continues after a trailer frame is a protocol violation — surface it as an error, don't silently drop it.
4. Handle **Trailers-Only** responses (headers + trailers together, empty body) — this is the common shape for auth failures and immediate errors. Don't assume every response has at least one data frame.

## 4. HTTP semantics

- Works over any HTTP/1.1+ transport — do not gate the transport layer on HTTP/2 support.
- Header names may be any case on the wire; when Hoppscotch itself writes trailers into a frame (relevant only if Hoppscotch ever acts as a mock/echo server), those must be lower-case.
- Stream end is signaled by body EOF, not by an HTTP/2-specific mechanism. No `stream-id`, no `GOAWAY` handling needed client-side.

## 5. Headers Hoppscotch's client must set

- Do **not** set `User-Agent` — browsers own that header.
- Set `X-User-Agent: grpc-web-hoppscotch/<version>` (mirrors the `grpc-web-javascript/0.1` convention in the spec, rename to identify Hoppscotch).
- `Content-Type` / `Accept` as above.
- Any custom metadata the user adds in the request builder gets sent as regular HTTP headers — grpc-web has no separate metadata channel, headers *are* the metadata.

## 6. RPC types to support, and what framing means for each

| RPC type | Client behavior | UI implication |
|---|---|---|
| Unary | One request frame, read one data frame + trailer | Standard request/response, like REST |
| Server streaming | One request frame, read N data frames + trailer | Response pane must append messages as they arrive, not wait for stream end |
| Client streaming | Browser `fetch` **cannot** stream a request body incrementally in a way that's broadly reliable across the target browsers Hoppscotch supports. Treat this as: buffer all client messages, send once, read one data frame + trailer. Document this as a known limitation, don't fake real-time client streaming. |
| Bidi streaming | Same limitation as above compounds — grpc-web does not support true bidi in-browser (see §7 of the source doc: pending on `whatwg fetch/streams`). Mark as unsupported in-browser; only offer it in the desktop/agent build if that build has a real HTTP/2 stack. |

This last point is the single most important scoping decision: **don't let the UI advertise bidi/client-streaming as fully working in the web build.** Grey it out or label it "desktop only" rather than shipping a fake implementation.

## 7. Retries / caching / keep-alive

Explicitly out of scope per upstream spec (marked "will spec out later" / "not supported"). Don't build retry logic or HTTP/2 PING keep-alive for this feature — match REST's existing retry behavior if Hoppscotch has any, otherwise none.

## 8. What this spec does NOT cover

Proto file parsing, reflection, service/method discovery, and the request-builder UI are product-layer concerns, not protocol concerns — see `02-GRPC-FEATURE-SPEC.md`.
