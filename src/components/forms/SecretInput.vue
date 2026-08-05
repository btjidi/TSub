<script setup>
import { ref } from 'vue';
import { useI18n } from '../../i18n/index.js';

defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  autocomplete: { type: String, default: 'off' },
  disabled: { type: Boolean, default: false },
  allowGenerate: { type: Boolean, default: false },
  inputId: { type: String, default: '' },
  inputTestid: { type: String, default: '' },
  toggleTestid: { type: String, default: '' },
  generateTestid: { type: String, default: '' },
  fontMono: { type: Boolean, default: false }
});

const emit = defineEmits(['update:modelValue', 'generate']);
const { t } = useI18n();
const visible = ref(false);
</script>

<template>
  <div class="relative min-w-0">
    <input
      :id="inputId || undefined"
      :value="modelValue"
      :data-testid="inputTestid || undefined"
      :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete"
      :disabled="disabled"
      class="w-full border bg-transparent py-2 pl-2 disabled:cursor-not-allowed disabled:opacity-50"
      :class="[allowGenerate ? 'pr-24' : 'pr-11', fontMono ? 'font-mono' : '']"
      :placeholder="placeholder"
      @input="emit('update:modelValue', $event.target.value)"
    />
    <button
      :data-testid="toggleTestid || undefined"
      type="button"
      class="absolute inset-y-0 flex w-10 items-center justify-center text-gray-400 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-gray-200"
      :class="allowGenerate ? 'right-12' : 'right-0'"
      :disabled="disabled"
      :title="visible ? t('loginView.hidePassword') : t('loginView.showPassword')"
      :aria-label="visible ? t('loginView.hidePassword') : t('loginView.showPassword')"
      @click="visible = !visible"
    >
      <svg v-if="visible" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd" />
        <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
      </svg>
      <svg v-else xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
        <path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd" />
      </svg>
    </button>
    <button
      v-if="allowGenerate"
      :data-testid="generateTestid || undefined"
      type="button"
      class="absolute inset-y-px right-px border-0 border-l bg-gray-50 px-3 text-xs font-medium text-primary-600 hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-gray-900 dark:hover:bg-white/10"
      :disabled="disabled"
      :title="t('deployments.generateSecret')"
      @click="emit('generate')"
    >
      {{ t('deployments.generate') }}
    </button>
  </div>
</template>
