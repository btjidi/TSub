<script setup>
defineProps({
  textSizeClass: {
    type: String,
    default: 'text-lg'
  },
  iconSize: {
    type: Number,
    default: 28
  }
});
</script>

<template>
  <router-link to="/" class="nav-brand-wrap">
    <div class="nav-brand-badge nav-brand-badge-sm" aria-hidden="true">
      <img :width="iconSize" :height="iconSize" src="/logo.svg" alt="TSub" />
    </div>
    <span class="nav-brand-text" :class="textSizeClass">T-Sub</span>
  </router-link>
</template>
