<template>
  <div class="flex flex-1 flex-col">
    <div
      class="sticky top-0 z-10 flex flex-shrink-0 items-center justify-between border-b border-dividerLight bg-primary pl-4"
    >
      <label class="truncate font-semibold text-secondaryLight">
        {{ t("grpc.proto_source") }}
      </label>
      <div class="flex">
        <HoppButtonSecondary
          :label="t('grpc.use_reflection')"
          :class="{ '!text-accent': mode === 'reflection' }"
          @click="setMode('reflection')"
        />
        <HoppButtonSecondary
          :label="t('grpc.use_raw_proto')"
          :class="{ '!text-accent': mode === 'raw' }"
          @click="setMode('raw')"
        />
      </div>
    </div>

    <div v-if="mode === 'reflection'" class="flex flex-col gap-2 p-4">
      <p class="text-secondaryLight">
        {{ t("grpc.reflection_description") }}
      </p>
      <HoppButtonPrimary
        :label="t('grpc.fetch_services')"
        :loading="reflectionLoading"
        class="w-fit"
        @click="fetchServices"
      />
      <p v-if="reflectionError" class="text-red-500">{{ reflectionError }}</p>
      <div v-if="serviceNames.length > 0" class="flex flex-col gap-1">
        <HoppSmartItem
          v-for="serviceName in serviceNames"
          :key="serviceName"
          :label="serviceName"
          :icon="
            selectedServiceName === serviceName ? IconCircleDot : IconCircle
          "
          :active="selectedServiceName === serviceName"
          :loading="serviceLoading === serviceName"
          @click="selectReflectionService(serviceName)"
        />
      </div>
    </div>

    <div v-else class="flex flex-col gap-2 p-4">
      <p class="text-secondaryLight">
        {{ t("grpc.raw_proto_description") }}
      </p>
      <label>
        <HoppButtonSecondary
          :label="t('import.title')"
          :icon="IconFilePlus"
          @click="fileInput?.click()"
        />
        <input
          ref="fileInput"
          type="file"
          accept=".proto"
          multiple
          class="hidden"
          @change="onFilesSelected"
        />
      </label>
      <div
        v-for="(source, index) in rawSources"
        :key="index"
        class="flex flex-col gap-1 rounded border border-dividerLight p-2"
      >
        <div class="flex items-center justify-between">
          <input
            v-model="source.name"
            class="bg-transparent font-semibold text-secondaryDark"
          />
          <HoppButtonSecondary
            :icon="IconTrash2"
            @click="removeSource(index)"
          />
        </div>
        <textarea
          v-model="source.content"
          rows="8"
          class="w-full rounded bg-primaryLight p-2 font-mono text-tiny"
          :placeholder="t('grpc.paste_proto_placeholder')"
        />
      </div>
      <HoppButtonSecondary
        :label="t('add.new')"
        :icon="IconPlus"
        class="w-fit"
        @click="addEmptySource"
      />
      <HoppButtonPrimary
        :label="t('grpc.load_proto')"
        class="w-fit"
        @click="loadRawProto"
      />
      <p v-if="rawError" class="text-red-500">{{ rawError }}</p>
    </div>

    <div
      v-if="schema"
      class="flex flex-col gap-1 border-t border-dividerLight p-4"
    >
      <label class="font-semibold text-secondaryLight">
        {{ t("grpc.service_method") }}
      </label>
      <div v-for="service in schema.services" :key="service.fullName">
        <div class="font-semibold">{{ service.fullName }}</div>
        <HoppSmartItem
          v-for="method in service.methods"
          :key="method.fullName"
          :label="`${method.name} (${methodStreamingLabel(method)})`"
          :icon="isSelectedMethod(service, method) ? IconCircleDot : IconCircle"
          :active="isSelectedMethod(service, method)"
          @click="selectMethod(service, method)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue"
import * as E from "fp-ts/Either"
import { useVModel } from "@vueuse/core"
import { HoppGRPCRequest, GRPCProtoSourceFile } from "@hoppscotch/data"
import { useI18n } from "@composables/i18n"
import { useToast } from "@composables/toast"
import IconCircle from "~icons/lucide/circle"
import IconCircleDot from "~icons/lucide/circle-dot"
import IconFilePlus from "~icons/lucide/file-plus"
import IconPlus from "~icons/lucide/plus"
import IconTrash2 from "~icons/lucide/trash-2"
import {
  GRPCSchema,
  GRPCServiceSchema,
  GRPCMethodSchema,
} from "~/helpers/grpc/schema"
import { importProtoSources } from "~/helpers/grpc/protoImport"
import { listServices, fetchSchemaForService } from "~/helpers/grpc/reflection"
import { buildMessageSkeleton } from "~/helpers/grpc/skeleton"
import { getGRPCEffectiveEnvVariables } from "~/helpers/grpc/interpolate"
import { parseTemplateString } from "@hoppscotch/data"

const GRPC_CLIENT_VERSION = "1.0.0"

const t = useI18n()
const toast = useToast()

const props = defineProps<{
  modelValue: HoppGRPCRequest
  schema: GRPCSchema | null
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: HoppGRPCRequest): void
  (e: "update:schema", value: GRPCSchema | null): void
}>()

const request = useVModel(props, "modelValue", emit)
const schema = useVModel(props, "schema", emit)

const mode = computed(() => request.value.protoSource.type)

const setMode = (newMode: "reflection" | "raw") => {
  if (newMode === "reflection") {
    request.value.protoSource = { type: "reflection" }
  } else {
    request.value.protoSource = {
      type: "raw",
      sources: rawSources.value,
    }
  }
}

const serviceNames = ref<string[]>([])
const selectedServiceName = ref<string | null>(null)
const serviceLoading = ref<string | null>(null)
const reflectionLoading = ref(false)
const reflectionError = ref<string | null>(null)

const interpolatedEndpoint = () =>
  parseTemplateString(request.value.url, getGRPCEffectiveEnvVariables())

const fetchServices = async () => {
  reflectionLoading.value = true
  reflectionError.value = null
  schema.value = null

  const result = await listServices(
    interpolatedEndpoint(),
    request.value.useTls,
    GRPC_CLIENT_VERSION
  )()

  reflectionLoading.value = false

  if (E.isLeft(result)) {
    reflectionError.value = describeReflectionError(result.left)
    return
  }

  serviceNames.value = result.right
  if (serviceNames.value.length === 0) {
    reflectionError.value = t("grpc.no_services_found")
  }
}

const selectReflectionService = async (serviceName: string) => {
  selectedServiceName.value = serviceName
  serviceLoading.value = serviceName
  reflectionError.value = null

  const result = await fetchSchemaForService(
    interpolatedEndpoint(),
    request.value.useTls,
    serviceName,
    GRPC_CLIENT_VERSION
  )()

  serviceLoading.value = null

  if (E.isLeft(result)) {
    reflectionError.value = describeReflectionError(result.left)
    return
  }

  schema.value = result.right
}

const rawSources = ref<GRPCProtoSourceFile[]>(
  request.value.protoSource.type === "raw"
    ? request.value.protoSource.sources
    : [{ name: "main.proto", content: "" }]
)
const rawError = ref<string | null>(null)

const addEmptySource = () => {
  rawSources.value.push({
    name: `file${rawSources.value.length + 1}.proto`,
    content: "",
  })
}

const removeSource = (index: number) => {
  rawSources.value.splice(index, 1)
}

const fileInput = ref<HTMLInputElement>()

const onFilesSelected = async (event: Event) => {
  const files = (event.target as HTMLInputElement).files
  if (!files) return

  for (const file of Array.from(files)) {
    const content = await file.text()
    rawSources.value.push({ name: file.name, content })
  }
}

const loadRawProto = () => {
  rawError.value = null
  request.value.protoSource = { type: "raw", sources: rawSources.value }

  const result = importProtoSources(rawSources.value)

  if (E.isLeft(result)) {
    rawError.value = describeProtoImportError(result.left)
    schema.value = null
    return
  }

  schema.value = result.right

  if (result.right.services.length === 0) {
    rawError.value = t("grpc.no_services_found")
  }
}

const methodStreamingLabel = (method: GRPCMethodSchema): string => {
  if (method.clientStreaming && method.serverStreaming) return "bidi-streaming"
  if (method.clientStreaming) return "client-streaming"
  if (method.serverStreaming) return "server-streaming"
  return "unary"
}

const isSelectedMethod = (
  service: GRPCServiceSchema,
  method: GRPCMethodSchema
) =>
  request.value.service === service.fullName &&
  request.value.method === method.name

const selectMethod = (service: GRPCServiceSchema, method: GRPCMethodSchema) => {
  if (!schema.value) return

  request.value.service = service.fullName
  request.value.method = method.name
  request.value.rpcType =
    method.clientStreaming && method.serverStreaming
      ? "bidi-streaming"
      : method.clientStreaming
        ? "client-streaming"
        : method.serverStreaming
          ? "server-streaming"
          : "unary"

  request.value.body = JSON.stringify(
    buildMessageSkeleton(schema.value, method.requestType),
    null,
    2
  )

  toast.success(t("grpc.method_selected"))
}

const describeReflectionError = (error: {
  type: string
  message?: string
  code?: number
}): string => {
  switch (error.type) {
    case "TRANSPORT_ERROR":
      return t("grpc.reflection_transport_error")
    case "GRPC_ERROR":
      return `${t("grpc.reflection_grpc_error")}: ${error.message}`
    case "REFLECTION_ERROR_RESPONSE":
      return `${t("grpc.reflection_grpc_error")}: ${error.message}`
    case "EMPTY_RESPONSE":
      return t("grpc.reflection_empty_response")
    case "DECODE_ERROR":
      return `${t("grpc.reflection_decode_error")}: ${error.message}`
    case "TOO_MANY_DEPENDENCIES":
      return t("grpc.reflection_too_many_dependencies")
    case "RESOLVE_ERROR":
      return `${t("grpc.reflection_resolve_error")}: ${error.message}`
    default:
      return t("grpc.reflection_unknown_error")
  }
}

const describeProtoImportError = (error: {
  type: string
  message?: string
  fileName?: string
}): string => {
  if (error.type === "PARSE_ERROR") {
    return `${t("grpc.proto_parse_error")} (${error.fileName}): ${error.message}`
  }
  return `${t("grpc.proto_resolve_error")}: ${error.message}`
}
</script>
