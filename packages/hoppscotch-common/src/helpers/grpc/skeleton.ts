import { GRPCFieldSchema, GRPCSchema } from "./schema"

const SCALAR_DEFAULTS: Record<string, unknown> = {
  double: 0,
  float: 0,
  int32: 0,
  int64: 0,
  uint32: 0,
  uint64: 0,
  sint32: 0,
  sint64: 0,
  fixed32: 0,
  fixed64: 0,
  sfixed32: 0,
  sfixed64: 0,
  bool: false,
  string: "",
  bytes: "",
}

const MAX_DEPTH = 8

const buildSingleValue = (
  schema: GRPCSchema,
  field: GRPCFieldSchema,
  depth: number
): unknown => {
  if (field.kind === "enum") {
    const enumSchema = schema.enums[field.type]
    return enumSchema?.values[0]?.name ?? 0
  }

  if (field.kind === "message") {
    if (depth >= MAX_DEPTH) return null
    return buildMessageSkeleton(schema, field.type, depth + 1)
  }

  return SCALAR_DEFAULTS[field.type] ?? null
}

/**
 * Builds a default-value skeleton for a message type — every field present
 * with an empty/default value — so selecting a method can auto-populate the
 * request body editor (feature spec §5), the same convenience GraphQL's
 * query-from-schema gives.
 */
export const buildMessageSkeleton = (
  schema: GRPCSchema,
  messageFullName: string,
  depth = 0
): Record<string, unknown> => {
  const message = schema.messages[messageFullName]
  if (!message) return {}

  const result: Record<string, unknown> = {}

  for (const field of message.fields) {
    result[field.name] =
      field.kind === "map" || field.repeated
        ? field.kind === "map"
          ? {}
          : []
        : buildSingleValue(schema, field, depth)
  }

  return result
}
