import protobuf from "protobufjs"

/**
 * Internal service/method/message representation fed by both method
 * discovery paths (server reflection and manual .proto import) per feature
 * spec §4 — the request builder consumes this and doesn't care which path
 * produced it.
 */

export type GRPCFieldKind = "scalar" | "message" | "enum" | "map"

export type GRPCFieldSchema = {
  name: string
  /** Scalar type name (e.g. "string", "int32") for scalar/map-value fields, or the resolved message/enum full name otherwise. */
  type: string
  repeated: boolean
  kind: GRPCFieldKind
  mapKeyType?: string
  mapValueType?: string
}

export type GRPCMessageSchema = {
  fullName: string
  fields: GRPCFieldSchema[]
}

export type GRPCEnumSchema = {
  fullName: string
  values: { name: string; number: number }[]
}

export type GRPCMethodSchema = {
  name: string
  fullName: string
  requestType: string
  responseType: string
  clientStreaming: boolean
  serverStreaming: boolean
}

export type GRPCServiceSchema = {
  name: string
  fullName: string
  methods: GRPCMethodSchema[]
}

export type GRPCSchema = {
  services: GRPCServiceSchema[]
  messages: Record<string, GRPCMessageSchema>
  enums: Record<string, GRPCEnumSchema>
  /** Kept so the Phase 3 request builder can encode/decode messages against the exact same type definitions. */
  root: protobuf.Root
}

const stripLeadingDot = (name: string) => name.replace(/^\./, "")

const buildFieldSchema = (field: protobuf.Field): GRPCFieldSchema => {
  field.resolve()

  if (field instanceof protobuf.MapField) {
    return {
      name: field.name,
      type: field.type,
      repeated: false,
      kind: "map",
      mapKeyType: field.keyType,
      mapValueType: field.type,
    }
  }

  if (field.resolvedType instanceof protobuf.Enum) {
    return {
      name: field.name,
      type: stripLeadingDot(field.resolvedType.fullName),
      repeated: field.repeated,
      kind: "enum",
    }
  }

  if (field.resolvedType instanceof protobuf.Type) {
    return {
      name: field.name,
      type: stripLeadingDot(field.resolvedType.fullName),
      repeated: field.repeated,
      kind: "message",
    }
  }

  return {
    name: field.name,
    type: field.type,
    repeated: field.repeated,
    kind: "scalar",
  }
}

const buildMethodSchema = (method: protobuf.Method): GRPCMethodSchema => {
  method.resolve()

  return {
    name: method.name,
    fullName: stripLeadingDot(method.fullName),
    requestType: stripLeadingDot(
      method.resolvedRequestType?.fullName ?? method.requestType
    ),
    responseType: stripLeadingDot(
      method.resolvedResponseType?.fullName ?? method.responseType
    ),
    clientStreaming: Boolean(method.requestStream),
    serverStreaming: Boolean(method.responseStream),
  }
}

const buildServiceSchema = (service: protobuf.Service): GRPCServiceSchema => ({
  name: service.name,
  fullName: stripLeadingDot(service.fullName),
  methods: service.methodsArray.map(buildMethodSchema),
})

/**
 * Walks a fully-resolved `Root` (caller must have already run
 * `root.resolveAll()`) and extracts every service, message, and enum into
 * the shared schema shape.
 */
export const buildSchemaFromRoot = (root: protobuf.Root): GRPCSchema => {
  const services: GRPCServiceSchema[] = []
  const messages: Record<string, GRPCMessageSchema> = {}
  const enums: Record<string, GRPCEnumSchema> = {}

  const walk = (namespace: protobuf.NamespaceBase) => {
    for (const entry of namespace.nestedArray ?? []) {
      if (entry instanceof protobuf.Service) {
        services.push(buildServiceSchema(entry))
      } else if (entry instanceof protobuf.Type) {
        messages[stripLeadingDot(entry.fullName)] = {
          fullName: stripLeadingDot(entry.fullName),
          fields: entry.fieldsArray.map(buildFieldSchema),
        }
        walk(entry)
      } else if (entry instanceof protobuf.Enum) {
        enums[stripLeadingDot(entry.fullName)] = {
          fullName: stripLeadingDot(entry.fullName),
          values: Object.entries(entry.values).map(([name, number]) => ({
            name,
            number,
          })),
        }
      } else if (entry instanceof protobuf.Namespace) {
        walk(entry)
      }
    }
  }

  walk(root)

  return { services, messages, enums, root }
}
