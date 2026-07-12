import protobuf from "protobufjs"
import * as E from "fp-ts/Either"
import { buildSchemaFromRoot, GRPCSchema } from "./schema"

export type GRPCProtoSourceFile = {
  fileName: string
  content: string
}

export type ProtoImportError =
  | { type: "PARSE_ERROR"; fileName: string; message: string }
  | { type: "RESOLVE_ERROR"; message: string }

/**
 * Manual .proto import path (feature spec §4.2). Every supplied source is
 * parsed into the same `Root` so cross-file `import`s between the pasted/
 * uploaded sources resolve by fully-qualified type name — protobufjs
 * doesn't need to actually fetch the imported file's bytes for this to
 * work, only for every type the sources reference to end up defined
 * somewhere in that shared root before `resolveAll()` runs.
 */
export const importProtoSources = (
  sources: GRPCProtoSourceFile[]
): E.Either<ProtoImportError, GRPCSchema> => {
  const root = new protobuf.Root()

  for (const source of sources) {
    try {
      protobuf.parse(source.content, root, { keepCase: true })
    } catch (error) {
      return E.left({
        type: "PARSE_ERROR",
        fileName: source.fileName,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    root.resolveAll()
  } catch (error) {
    return E.left({
      type: "RESOLVE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  return E.right(buildSchemaFromRoot(root))
}
