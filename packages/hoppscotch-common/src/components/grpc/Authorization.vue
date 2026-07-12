<template>
  <div class="flex flex-1 flex-col">
    <div
      class="sticky top-0 z-10 flex flex-shrink-0 items-center justify-between border-b border-dividerLight bg-primary pl-4"
    >
      <span class="flex items-center">
        <label class="truncate font-semibold text-secondaryLight">
          {{ t("authorization.type") }}
        </label>
        <tippy
          interactive
          trigger="click"
          theme="popover"
          :on-shown="() => tippyActions?.focus()"
        >
          <HoppSmartSelectWrapper>
            <HoppButtonSecondary
              class="ml-2 rounded-none pr-8"
              :label="authName"
            />
          </HoppSmartSelectWrapper>
          <template #content="{ hide }">
            <div
              ref="tippyActions"
              class="flex flex-col focus:outline-none"
              tabindex="0"
            >
              <HoppSmartItem
                v-for="item in authTypes"
                :key="item.key"
                :label="item.label"
                :icon="item.key === auth.authType ? IconCircleDot : IconCircle"
                :active="item.key === auth.authType"
                @click="
                  () => {
                    auth = {
                      authType: item.key,
                      authActive: true,
                    } as HoppRESTAuth
                    hide()
                  }
                "
              />
            </div>
          </template>
        </tippy>
      </span>
      <HoppSmartCheckbox
        :on="auth.authActive"
        class="px-2"
        @change="auth.authActive = !auth.authActive"
      >
        {{ t("state.enabled") }}
      </HoppSmartCheckbox>
    </div>

    <div v-if="auth.authType === 'none'" class="p-4 text-secondaryLight">
      {{ t("empty.authorization") }}
    </div>

    <div v-else-if="auth.authType === 'basic'">
      <HttpAuthorizationBasic v-model="auth" />
    </div>

    <div
      v-else-if="auth.authType === 'bearer'"
      class="flex flex-1 border-b border-dividerLight"
    >
      <label class="ml-4 flex min-w-[6rem] items-center text-secondaryLight">
        {{ t("authorization.token") }}
      </label>
      <SmartEnvInput v-model="auth.token" class="px-4" />
    </div>

    <div v-else-if="auth.authType === 'api-key'">
      <HttpAuthorizationApiKey v-model="auth" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useVModel } from "@vueuse/core"
import { HoppRESTAuth } from "@hoppscotch/data"
import { useI18n } from "@composables/i18n"
import IconCircle from "~icons/lucide/circle"
import IconCircleDot from "~icons/lucide/circle-dot"

const t = useI18n()

const props = defineProps<{
  modelValue: HoppRESTAuth
}>()

const emit = defineEmits<{
  (e: "update:modelValue", value: HoppRESTAuth): void
}>()

const auth = useVModel(props, "modelValue", emit)

const tippyActions = ref<HTMLDivElement>()

/** Only the auth types that map cleanly to grpc-web metadata headers — no
 * collection-tree inheritance yet (see docs/specs/grpc/00-DISCOVERY-NOTES.md),
 * and OAuth2/AWS/Digest/HAWK/JWT need machinery not built for this feature. */
const authTypes: { key: HoppRESTAuth["authType"]; label: string }[] = [
  { key: "none", label: "None" },
  { key: "basic", label: "Basic Auth" },
  { key: "bearer", label: "Bearer" },
  { key: "api-key", label: "API Key" },
]

const authName = computed(
  () =>
    authTypes.find((item) => item.key === auth.value.authType)?.label ??
    auth.value.authType
)
</script>
