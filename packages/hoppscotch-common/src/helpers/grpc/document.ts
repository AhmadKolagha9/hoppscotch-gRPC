import { HoppGRPCRequest } from "@hoppscotch/data"
import { GRPCOptionTabs } from "~/components/grpc/RequestOptions.vue"

export type HoppGRPCSaveContext =
  | {
      originLocation: "user-collection"
      folderPath: string
      requestIndex: number
    }
  | {
      originLocation: "team-collection"
      requestID: string
      teamID?: string
      collectionID?: string
    }
  | null

/** One event in a call's response log — mirrors GraphQL's subscription-log approach (docs/specs/grpc/00-DISCOVERY-NOTES.md), since server-streaming needs to append messages as they arrive rather than replace a single response value. */
export type GRPCResponseEvent =
  | { type: "message"; message: string; timestamp: number }
  | { type: "status"; code: number; message: string; trailersOnly: boolean }
  | { type: "error"; error: string }

/**
 * Defines a live 'document' (something that is open and being edited) in the app
 */
export type HoppGRPCDocument = {
  request: HoppGRPCRequest

  isDirty: boolean

  saveContext?: HoppGRPCSaveContext

  /** Response log for the current/last call, if any — cleared and re-appended to on each invoke. */
  response?: GRPCResponseEvent[] | null

  optionTabPreference?: GRPCOptionTabs
}
