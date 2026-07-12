import { isEqual } from "lodash-es"
import { getDefaultGRPCRequest } from "@hoppscotch/data"
import { HoppGRPCDocument, HoppGRPCSaveContext } from "~/helpers/grpc/document"
import { TabService } from "./tab"
import { computed } from "vue"
import { Container } from "dioc"
import { getService } from "~/modules/dioc"
import { PersistenceService, STORE_KEYS } from "../persistence"
import { PersistableTabState } from "."

export class GRPCTabService extends TabService<HoppGRPCDocument> {
  public static readonly ID = "GRPC_TAB_SERVICE"

  constructor(c: Container) {
    super(c)

    this.tabMap.set("test", {
      id: "test",
      document: {
        request: getDefaultGRPCRequest(),
        isDirty: false,
        optionTabPreference: "proto",
      },
    })

    this.watchCurrentTabID()
  }

  // override persistableTabState to remove the response log from the document
  public override persistableTabState = computed(() => ({
    lastActiveTabID: this.currentTabID.value,
    orderedDocs: this.tabOrdering.value.map((tabID) => {
      const tab = this.tabMap.get(tabID)!
      return {
        tabID: tab.id,
        doc: {
          ...tab.document,
          response: null,
        },
      }
    }),
  }))

  protected async loadPersistedState(): Promise<PersistableTabState<HoppGRPCDocument> | null> {
    const persistenceService = getService(PersistenceService)
    const savedState = await persistenceService.getNullable<
      PersistableTabState<HoppGRPCDocument>
    >(STORE_KEYS.GRPC_TABS)
    return savedState
  }

  public getTabRefWithSaveContext(ctx: HoppGRPCSaveContext) {
    for (const tab of this.tabMap.values()) {
      if (ctx?.originLocation === "team-collection") {
        if (
          tab.document.saveContext?.originLocation === "team-collection" &&
          tab.document.saveContext.requestID === ctx.requestID
        ) {
          return this.getTabRef(tab.id)
        }
      } else if (isEqual(ctx, tab.document.saveContext))
        return this.getTabRef(tab.id)
    }

    return null
  }

  public getDirtyTabsCount() {
    let count = 0

    for (const tab of this.tabMap.values()) {
      if (tab.document.isDirty) count++
    }

    return count
  }
}
