<template>
  <AppPaneLayout layout-id="grpc-request">
    <template #primary>
      <div class="flex flex-1 flex-col">
        <div
          class="sticky top-0 z-10 flex flex-shrink-0 items-center gap-2 border-b border-dividerLight bg-primary px-4 py-2"
        >
          <HoppButtonSecondary
            v-tippy="{ theme: 'tooltip' }"
            :label="request.useTls ? 'https' : 'http'"
            :title="t('grpc.toggle_tls')"
            @click="request.useTls = !request.useTls"
          />
          <SmartEnvInput
            v-model="request.url"
            :placeholder="t('grpc.url_placeholder')"
            class="flex-1"
            :environment-highlights="true"
            :predefined-variables-highlights="true"
          />
          <span
            v-if="request.service && request.method"
            class="whitespace-nowrap text-tiny text-secondaryLight"
          >
            {{ request.service }}/{{ request.method }} · {{ request.rpcType }}
          </span>
          <HoppButtonSecondary
            v-if="request.rpcType === 'bidi-streaming'"
            v-tippy="{ theme: 'tooltip' }"
            :title="t('grpc.bidi_unsupported')"
            disabled
            :label="t('action.send')"
          />
          <HoppButtonPrimary
            v-else
            :label="isRunning ? t('action.cancel') : t('action.send')"
            :loading="isRunning && request.rpcType === 'unary'"
            @click="isRunning ? cancel() : invoke()"
          />
        </div>

        <HoppSmartTabs
          v-model="selectedOptionTab"
          styles="sticky bg-primary top-0 z-10 border-b-0"
          :render-inactive-tabs="true"
        >
          <HoppSmartTab :id="'proto'" :label="t('grpc.proto')">
            <GrpcProtoSource v-model="request" v-model:schema="schema" />
          </HoppSmartTab>
          <HoppSmartTab
            :id="'metadata'"
            :label="t('tab.metadata')"
            :info="
              activeMetadataCount === 0 ? null : String(activeMetadataCount)
            "
          >
            <GrpcMetadata v-model="request.metadata" />
          </HoppSmartTab>
          <HoppSmartTab :id="'body'" :label="t('grpc.message')">
            <GrpcBody v-model="request.body" :rpc-type="request.rpcType" />
          </HoppSmartTab>
          <HoppSmartTab :id="'authorization'" :label="t('tab.authorization')">
            <GrpcAuthorization v-model="request.auth" />
          </HoppSmartTab>
        </HoppSmartTabs>
      </div>
    </template>
    <template #secondary>
      <GrpcResponse
        :response="response"
        :is-running="isRunning"
        @stop="cancel"
      />
    </template>
  </AppPaneLayout>
</template>

<script setup lang="ts">
import { ref, computed } from "vue"
import * as E from "fp-ts/Either"
import { useVModel } from "@vueuse/core"
import { HoppGRPCRequest } from "@hoppscotch/data"
import { useI18n } from "@composables/i18n"
import { useToast } from "@composables/toast"
import { GRPCSchema } from "~/helpers/grpc/schema"
import { GRPCResponseEvent } from "~/helpers/grpc/document"
import { executeGRPCRequest } from "~/helpers/grpc/execute"

const GRPC_CLIENT_VERSION = "1.0.0"

const _VALID_GRPC_OPERATIONS = [
  "proto",
  "metadata",
  "body",
  "authorization",
] as const
export type GRPCOptionTabs = (typeof _VALID_GRPC_OPERATIONS)[number]

const t = useI18n()
const toast = useToast()

const props = defineProps<{
  modelValue: HoppGRPCRequest
  response?: GRPCResponseEvent[] | null
  optionTab?: GRPCOptionTabs
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: HoppGRPCRequest): void
  (e: "update:optionTab", value: GRPCOptionTabs): void
  (e: "update:response", value: GRPCResponseEvent[] | null): void
}>()

const request = useVModel(props, "modelValue", emit)
const response = useVModel(props, "response", emit)

const selectedOptionTab = computed<GRPCOptionTabs>({
  get: () => props.optionTab ?? "proto",
  set: (value) => emit("update:optionTab", value),
})

const schema = ref<GRPCSchema | null>(null)

const activeMetadataCount = computed(
  () =>
    request.value.metadata.filter((entry) => entry.active && entry.key).length
)

const isRunning = ref(false)
let abortController: AbortController | null = null

const invoke = async () => {
  if (!schema.value) {
    toast.error(t("grpc.no_schema_loaded"))
    return
  }

  if (!request.value.service || !request.value.method) {
    toast.error(t("grpc.no_method_selected"))
    return
  }

  response.value = []
  isRunning.value = true
  abortController = new AbortController()

  const result = await executeGRPCRequest(
    request.value,
    schema.value,
    GRPC_CLIENT_VERSION,
    (event: GRPCResponseEvent) => {
      response.value = [...(response.value ?? []), event]
    },
    abortController.signal
  )

  isRunning.value = false

  if (E.isLeft(result)) {
    toast.error(describeExecuteError(result.left.type))
  }
}

const cancel = () => {
  abortController?.abort()
  isRunning.value = false
}

const describeExecuteError = (type: string): string => {
  switch (type) {
    case "METHOD_NOT_FOUND":
      return t("grpc.no_method_selected")
    case "INVALID_JSON_BODY":
      return t("grpc.invalid_json_body")
    case "ENCODE_ERROR":
      return t("grpc.encode_error")
    case "BIDI_UNSUPPORTED":
      return t("grpc.bidi_unsupported")
    default:
      return t("grpc.execute_error")
  }
}
</script>
