<template>
  <div class="flex flex-1 flex-col">
    <div
      class="sticky top-0 z-10 flex flex-shrink-0 items-center justify-between border-b border-dividerLight bg-primary pl-4"
    >
      <label class="truncate font-semibold text-secondaryLight">
        {{ t("grpc.message") }}
      </label>
      <div class="flex">
        <HoppButtonSecondary
          v-tippy="{ theme: 'tooltip' }"
          :title="t('action.clear')"
          :icon="IconTrash2"
          @click="body = '{}'"
        />
      </div>
    </div>
    <p
      v-if="rpcType === 'client-streaming' || rpcType === 'bidi-streaming'"
      class="border-b border-dividerLight bg-primaryLight p-2 text-tiny text-secondaryLight"
    >
      {{ t("grpc.client_streaming_body_hint") }}
    </p>
    <div ref="editorRef" class="flex flex-1"></div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue"
import { useVModel } from "@vueuse/core"
import { useI18n } from "@composables/i18n"
import { useCodemirror } from "@composables/codemirror"
import jsoncLinter from "~/helpers/editor/linting/jsonc"
import IconTrash2 from "~icons/lucide/trash-2"
import { GRPCRPCType } from "@hoppscotch/data"

const t = useI18n()

const props = defineProps<{
  modelValue: string
  rpcType: GRPCRPCType
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void
}>()

const body = useVModel(props, "modelValue", emit)

const editorRef = ref<any | null>(null)

useCodemirror(
  editorRef,
  body,
  reactive({
    extendedEditorConfig: {
      mode: "application/ld+json",
      placeholder: t("grpc.message_placeholder"),
    },
    linter: jsoncLinter,
    completer: null,
    environmentHighlights: true,
    predefinedVariablesHighlights: true,
  })
)
</script>
