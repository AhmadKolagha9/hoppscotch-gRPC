<template>
  <div class="flex flex-1 flex-col">
    <div
      class="sticky top-0 z-10 flex flex-shrink-0 items-center justify-between border-b border-dividerLight bg-primary px-4 py-2"
    >
      <label class="font-semibold text-secondaryLight">
        {{ t("response.title") }}
      </label>
      <div class="flex items-center gap-2">
        <span v-if="messageCount > 0" class="text-secondaryLight">
          {{ t("grpc.messages_received", { count: messageCount }) }}
        </span>
        <span
          v-if="status"
          :class="status.code === 0 ? 'text-green-500' : 'text-red-500'"
        >
          {{ getGRPCStatusName(status.code) }} ({{ status.code }})
        </span>
        <HoppButtonSecondary
          v-if="isRunning"
          :label="t('action.cancel')"
          :icon="IconStopCircle"
          @click="$emit('stop')"
        />
      </div>
    </div>

    <div
      v-if="!response || response.length === 0"
      class="p-4 text-secondaryLight"
    >
      {{ t("grpc.no_response_yet") }}
    </div>

    <div v-else class="flex flex-col divide-y divide-dividerLight">
      <div v-for="(event, index) in messageEvents" :key="index" class="p-4">
        <pre class="whitespace-pre-wrap font-mono text-tiny">{{
          event.message
        }}</pre>
      </div>

      <div v-if="status && status.message" class="p-4 text-secondaryLight">
        {{ status.message }}
      </div>

      <div
        v-for="(event, index) in errorEvents"
        :key="`error-${index}`"
        class="p-4 text-red-500"
      >
        {{ event.error }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "@composables/i18n"
import IconStopCircle from "~icons/lucide/stop-circle"
import { GRPCResponseEvent } from "~/helpers/grpc/document"
import { getGRPCStatusName } from "~/helpers/grpc/statusCodes"

const t = useI18n()

const props = defineProps<{
  response?: GRPCResponseEvent[] | null
  isRunning: boolean
}>()

defineEmits<{
  (e: "stop"): void
}>()

const messageEvents = computed(
  () =>
    (props.response ?? []).filter(
      (event) => event.type === "message"
    ) as Extract<GRPCResponseEvent, { type: "message" }>[]
)

const errorEvents = computed(
  () =>
    (props.response ?? []).filter((event) => event.type === "error") as Extract<
      GRPCResponseEvent,
      { type: "error" }
    >[]
)

const messageCount = computed(() => messageEvents.value.length)

const status = computed(
  () =>
    (props.response ?? []).find((event) => event.type === "status") as
      | Extract<GRPCResponseEvent, { type: "status" }>
      | undefined
)
</script>
