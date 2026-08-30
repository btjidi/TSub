<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../../stores/session.js';

const sessionStore = useSessionStore();
const { sessionState } = storeToRefs(sessionStore);

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

const homePath = computed(() => sessionState.value === 'loggedIn' ? '/dashboard' : '/');
</script>

<template>
  <router-link :to="homePath" class="nav-brand-wrap">
    <div class="nav-brand-badge nav-brand-badge-sm" aria-hidden="true">
      <img :width="iconSize" :height="iconSize" src="/logo.svg" alt="TSub" />
    </div>
    <span class="nav-brand-text" :class="textSizeClass">T-Sub</span>
  </router-link>
</template>
