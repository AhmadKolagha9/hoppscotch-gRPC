<template>
  <div>
    <AppPaneLayout layout-id="grpc">
      <template #primary>
        <HoppSmartWindows
          v-if="currentTabID"
          :id="'grpc_windows'"
          :model-value="currentTabID"
          @update:model-value="changeTab"
          @remove-tab="removeTab"
          @add-tab="addNewTab"
          @sort="sortTabs"
        >
          <HoppSmartWindow
            v-for="tab in activeTabs"
            :id="tab.id"
            :key="'removable_tab_' + tab.id"
            :label="tab.document.request.name"
            :is-removable="activeTabs.length > 1"
            :close-visibility="'hover'"
          >
            <template #suffix>
              <span
                v-if="tab.document.isDirty"
                class="flex w-4 items-center justify-center text-secondary group-hover:hidden"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="1.2em"
                  height="1.2em"
                  class="h-1.5 w-1.5"
                >
                  <circle cx="12" cy="12" r="12" fill="currentColor"></circle>
                </svg>
              </span>
            </template>

            <GrpcRequestTab
              :model-value="tab"
              @update:model-value="onTabUpdate"
            />
          </HoppSmartWindow>
        </HoppSmartWindows>
      </template>
    </AppPaneLayout>
    <HoppSmartConfirmModal
      :show="confirmingCloseForTabID !== null"
      :confirm="t('modal.close_unsaved_tab')"
      :title="t('confirm.close_unsaved_tab')"
      @hide-modal="onCloseConfirm"
      @resolve="onResolveConfirm"
    />
    <HoppSmartConfirmModal
      :show="confirmingCloseAllTabs"
      :confirm="t('modal.close_unsaved_tab')"
      :title="t('confirm.close_unsaved_tabs', { count: unsavedTabsCount })"
      @hide-modal="confirmingCloseAllTabs = false"
      @resolve="onResolveConfirmCloseAllTabs"
    />
  </div>
</template>

<script setup lang="ts">
import { usePageHead } from "@composables/head"
import { useI18n } from "@composables/i18n"
import { computed, ref } from "vue"
import { getDefaultGRPCRequest } from "@hoppscotch/data"
import { defineActionHandler } from "~/helpers/actions"
import { HoppGRPCDocument } from "~/helpers/grpc/document"
import { HoppTab } from "~/services/tab"
import { GRPCTabService } from "~/services/tab/grpc"
import { useService } from "dioc/vue"

const t = useI18n()
const tabs = useService(GRPCTabService)

const currentTabID = computed(() => tabs.currentTabID.value)

const confirmingCloseForTabID = ref<string | null>(null)

usePageHead({
  title: computed(() => t("navigation.grpc")),
})

const activeTabs = tabs.getActiveTabs()

const addNewTab = () => {
  const tab = tabs.createNewTab({
    request: getDefaultGRPCRequest(),
    isDirty: false,
    optionTabPreference: "proto",
  })

  tabs.setActiveTab(tab.id)
}

const sortTabs = (e: { oldIndex: number; newIndex: number }) => {
  tabs.updateTabOrdering(e.oldIndex, e.newIndex)
}

const changeTab = (tabID: string) => {
  tabs.setActiveTab(tabID)
}

const removeTab = (tabID: string) => {
  const tabState = tabs.getTabRef(tabID).value

  if (tabState.document.isDirty) {
    confirmingCloseForTabID.value = tabID
  } else {
    tabs.closeTab(tabState.id)
  }
}

const onCloseConfirm = () => {
  confirmingCloseForTabID.value = null
}

const onResolveConfirm = () => {
  if (confirmingCloseForTabID.value) {
    tabs.closeTab(confirmingCloseForTabID.value)
    confirmingCloseForTabID.value = null
  }
}

const confirmingCloseAllTabs = ref(false)
const unsavedTabsCount = ref(0)
const exceptedTabID = ref<string | null>(null)

const closeOtherTabsAction = (tabID: string) => {
  const dirtyTabCount = tabs.getDirtyTabsCount()
  if (dirtyTabCount > 0) {
    confirmingCloseAllTabs.value = true
    unsavedTabsCount.value = dirtyTabCount
    exceptedTabID.value = tabID
  } else {
    tabs.closeOtherTabs(tabID)
  }
}

const onResolveConfirmCloseAllTabs = () => {
  if (exceptedTabID.value) tabs.closeOtherTabs(exceptedTabID.value)
  confirmingCloseAllTabs.value = false
}

const onTabUpdate = (tab: HoppTab<HoppGRPCDocument>) => {
  tabs.updateTab(tab)
}

const duplicateTab = (tabID: string) => {
  const tab = tabs.getTabRef(tabID)
  if (tab.value) {
    const newTab = tabs.createNewTab({
      request: tab.value.document.request,
      isDirty: true,
    })
    tabs.setActiveTab(newTab.id)
  }
}

defineActionHandler("tab.duplicate-tab", ({ tabID }) => {
  duplicateTab(tabID ?? currentTabID.value)
})

defineActionHandler("tab.close-current", () => {
  removeTab(currentTabID.value)
})

defineActionHandler("tab.close-other", () => {
  closeOtherTabsAction(currentTabID.value)
})

defineActionHandler("tab.open-new", addNewTab)

defineActionHandler("tab.next", () => {
  tabs.goToNextTab()
})

defineActionHandler("tab.prev", () => {
  tabs.goToPreviousTab()
})

defineActionHandler("tab.switch-to-first", () => {
  tabs.goToFirstTab()
})

defineActionHandler("tab.switch-to-last", () => {
  tabs.goToLastTab()
})

defineActionHandler("tab.reopen-closed", () => {
  tabs.reopenClosedTab()
})

defineActionHandler("tab.mru-switch", () => {
  tabs.goToMRUTab()
})

defineActionHandler("tab.mru-switch-reverse", () => {
  tabs.goToPreviousMRUTab()
})
</script>
