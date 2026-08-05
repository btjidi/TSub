<script setup>
import DeploymentInfoPopover from './DeploymentInfoPopover.vue';

defineProps({
  forId: { type: String, required: true },
  label: { type: String, required: true },
  help: { type: String, required: true },
  open: { type: Boolean, default: false },
  testId: { type: String, default: '' }
});

const emit = defineEmits(['update:open']);
</script>

<template>
  <span class="inline-flex min-w-0 items-center">
    <label :for="forId">{{ label }}</label>
    <DeploymentInfoPopover
      :open="open"
      :label="label"
      :test-id="testId"
      @update:open="value => emit('update:open', value)"
    >
      <span>{{ help }}</span>
    </DeploymentInfoPopover>
  </span>
</template>
