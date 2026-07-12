<template>
  <div class="flex flex-1 flex-col">
    <div
      class="sticky top-0 z-10 flex flex-shrink-0 items-center justify-between border-b border-dividerLight bg-primary pl-4"
    >
      <label class="truncate font-semibold text-secondaryLight">
        {{ t("tab.metadata") }}
      </label>
      <div class="flex">
        <HoppButtonSecondary
          v-tippy="{ theme: 'tooltip' }"
          :title="t('action.clear_all')"
          :icon="IconTrash2"
          @click="clearContent"
        />
        <HoppButtonSecondary
          v-tippy="{ theme: 'tooltip' }"
          :title="t('add.new')"
          :icon="IconPlus"
          @click="addEntry"
        />
      </div>
    </div>
    <div
      v-for="(entry, index) in workingEntries"
      :key="entry.id"
      class="flex divide-x divide-dividerLight border-b border-dividerLight"
    >
      <HttpKeyValue
        v-model:name="entry.key"
        v-model:value="entry.value"
        v-model:description="entry.description"
        :total="workingEntries.length"
        :index="index"
        :entity-id="entry.id"
        :entity-active="entry.active"
        :is-active="true"
        @update-entity="updateEntry($event.index, $event.payload)"
        @delete-entity="deleteEntry($event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useVModel } from "@vueuse/core"
import { isEqual, cloneDeep } from "lodash-es"
import { GRPCHeader } from "@hoppscotch/data"
import { useI18n } from "@composables/i18n"
import IconPlus from "~icons/lucide/plus"
import IconTrash2 from "~icons/lucide/trash-2"

const t = useI18n()

const props = defineProps<{
  modelValue: GRPCHeader[]
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: GRPCHeader[]): void
}>()

const entries = useVModel(props, "modelValue", emit)

type WorkingEntry = GRPCHeader & { id: number }

const idTicker = ref(0)

const workingEntries = ref<WorkingEntry[]>(
  entries.value.length > 0
    ? entries.value.map((entry) => ({ id: idTicker.value++, ...entry }))
    : [
        {
          id: idTicker.value++,
          key: "",
          value: "",
          active: true,
          description: "",
        },
      ]
)

watch(workingEntries, (list) => {
  if (list.length > 0 && list[list.length - 1].key !== "") {
    workingEntries.value.push({
      id: idTicker.value++,
      key: "",
      value: "",
      active: true,
      description: "",
    })
  }
})

watch(
  workingEntries,
  (newWorkingEntries) => {
    const fixed = newWorkingEntries
      .filter((entry) => entry.key !== "")
      .map(({ id: _id, ...entry }) => entry)

    if (!isEqual(entries.value, fixed)) {
      entries.value = cloneDeep(fixed)
    }
  },
  { deep: true }
)

const addEntry = () => {
  workingEntries.value.push({
    id: idTicker.value++,
    key: "",
    value: "",
    active: true,
    description: "",
  })
}

const updateEntry = (index: number, payload: WorkingEntry) => {
  workingEntries.value = workingEntries.value.map((entry, i) =>
    i === index ? payload : entry
  )
}

const deleteEntry = (index: number) => {
  if (workingEntries.value.length === 1) return
  workingEntries.value = workingEntries.value.filter((_, i) => i !== index)
}

const clearContent = () => {
  workingEntries.value = [
    { id: idTicker.value++, key: "", value: "", active: true, description: "" },
  ]
}
</script>
