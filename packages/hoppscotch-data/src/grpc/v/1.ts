import { z } from "zod"
import { defineVersion } from "verzod"
import { HoppRESTAuth } from "../../rest"

export const GRPCHeader = z.object({
  key: z.string().catch(""),
  value: z.string().catch(""),
  active: z.boolean().catch(true),
  description: z.string().catch(""),
})

export type GRPCHeader = z.infer<typeof GRPCHeader>

/** A single raw/pasted/uploaded .proto source file, keyed by the filename other sources `import` it by. */
export const GRPCProtoSourceFile = z.object({
  name: z.string(),
  content: z.string(),
})

export type GRPCProtoSourceFile = z.infer<typeof GRPCProtoSourceFile>

/**
 * No existing Hoppscotch persistence pattern to mirror here (unlike the
 * feature spec's assumption — GraphQL never persists its schema, see
 * docs/specs/grpc/00-DISCOVERY-NOTES.md §5) so this is a new field shape:
 * either the raw sources the user pasted/uploaded, or a marker that the
 * schema should be re-fetched via server reflection on open.
 */
export const GRPCProtoSource = z.union([
  z.object({
    type: z.literal("raw"),
    sources: z.array(GRPCProtoSourceFile).catch([]),
  }),
  z.object({
    type: z.literal("reflection"),
  }),
])

export type GRPCProtoSource = z.infer<typeof GRPCProtoSource>

export const GRPC_RPC_TYPES = [
  "unary",
  "server-streaming",
  "client-streaming",
  "bidi-streaming",
] as const

export const GRPCRPCType = z.enum(GRPC_RPC_TYPES)

export type GRPCRPCType = z.infer<typeof GRPCRPCType>

export const V1_SCHEMA = z.object({
  v: z.literal(1),
  name: z.string(),
  url: z.string(),
  useTls: z.boolean().catch(true),
  protoSource: GRPCProtoSource.catch({ type: "reflection" }),
  service: z.string().catch(""),
  method: z.string().catch(""),
  rpcType: GRPCRPCType.catch("unary"),
  body: z.string().catch("{}"),
  metadata: z.array(GRPCHeader).catch([]),
  auth: HoppRESTAuth,
})

export default defineVersion({
  initial: true,
  schema: V1_SCHEMA,
})
