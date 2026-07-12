import { InferredEntity, createVersionedEntity } from "verzod"
import { z } from "zod"
import V1_VERSION from "./v/1"

export {
  GRPCHeader,
  GRPCProtoSource,
  GRPCProtoSourceFile,
  GRPCRPCType,
  GRPC_RPC_TYPES,
} from "./v/1"

export const GRPC_REQ_SCHEMA_VERSION = 1

const versionedObject = z.object({
  v: z.number(),
})

export const HoppGRPCRequest = createVersionedEntity({
  latestVersion: 1,
  versionMap: {
    1: V1_VERSION,
  },
  getVersion(x) {
    const result = versionedObject.safeParse(x)

    return result.success ? result.data.v : null
  },
})

export type HoppGRPCRequest = InferredEntity<typeof HoppGRPCRequest>

export function getDefaultGRPCRequest(): HoppGRPCRequest {
  return {
    v: GRPC_REQ_SCHEMA_VERSION,
    name: "Untitled",
    url: "localhost:50051",
    useTls: false,
    protoSource: { type: "reflection" },
    service: "",
    method: "",
    rpcType: "unary",
    body: "{}",
    metadata: [],
    auth: {
      authType: "none",
      authActive: true,
    },
  }
}

export function makeGRPCRequest(
  x: Omit<HoppGRPCRequest, "v">
): HoppGRPCRequest {
  return {
    v: GRPC_REQ_SCHEMA_VERSION,
    ...x,
  }
}
