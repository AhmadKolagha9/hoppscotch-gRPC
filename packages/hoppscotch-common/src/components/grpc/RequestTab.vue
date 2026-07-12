<template>
  <GrpcRequestOptions
    v-model="tab.document.request"
    v-model:response="tab.document.response"
    v-model:option-tab="tab.document.optionTabPreference"
  />
</template>

<script setup lang="ts">
import { watch } from "vue"
import { useVModel } from "@vueuse/core"
import { cloneDeep, isEqual } from "lodash-es"
import { HoppGRPCDocument } from "~/helpers/grpc/document"
import { HoppTab } from "~/services/tab"

const props = defineProps<{
  modelValue: HoppTab<HoppGRPCDocument>
}>()

const emit = defineEmits<{
  (e: "update:modelValue", val: HoppTab<HoppGRPCDocument>): void
}>()

const tab = useVModel(props, "modelValue", emit)

let oldRequest = cloneDeep(tab.value.document.request)

watch(
  () => tab.value.document.request,
  (updatedValue) => {
    if (!tab.value.document.isDirty && !isEqual(oldRequest, updatedValue)) {
      tab.value.document.isDirty = true
    }
    oldRequest = cloneDeep(updatedValue)
  },
  { deep: true }
)
</script>
