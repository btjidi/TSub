<script setup>
import { computed, reactive } from 'vue';
import draggable from 'vuedraggable';
import { api } from '@/lib/http.js';
import { useI18n } from '@/i18n/index.js';
import { nodeFingerprint } from '@/utils/node-fingerprint.js';

const { t } = useI18n();
const props = defineProps({ subscriptions: { type: Array, default: () => [] }, filteredSubscriptions: { type: Array, default: () => [] }, searchTerm: { type: String, default: '' }, selectedIds: { type: Array, default: () => [] } });
const emit = defineEmits(['update:searchTerm', 'update:selectedIds', 'select-all', 'deselect-all']);
const expanded = reactive({});
const nodeState = reactive({});
const searchModel = computed({ get: () => props.searchTerm, set: value => emit('update:searchTerm', value) });
const entryId = entry => entry && typeof entry === 'object' ? entry.id : entry;
const findEntry = id => props.selectedIds.find(entry => entryId(entry) === id);
const selectedFingerprints = id => new Set(findEntry(id)?.nodeSelection?.fingerprints || []);
const isWhole = id => typeof findEntry(id) === 'string';
const isSelected = id => Boolean(findEntry(id));
const isPartial = id => Boolean(findEntry(id)?.nodeSelection?.fingerprints?.length);
const nodeUrl = node => node?.url || node?.link || '';
const nodeName = node => node?.name || node?.remark || node?.ps || nodeUrl(node);

const orderedSelectedSubs = computed({
  get() {
    const map = new Map(props.subscriptions.map(item => [item.id, item]));
    return props.selectedIds.map(entry => ({ ...map.get(entryId(entry)), _entry: entry })).filter(item => item.id);
  },
  set(items) { emit('update:selectedIds', items.map(item => item._entry)); }
});

function replaceEntry(id, next) {
  const list = props.selectedIds.filter(entry => entryId(entry) !== id);
  if (next) list.push(next);
  emit('update:selectedIds', list);
}
function toggleWhole(id) { replaceEntry(id, isSelected(id) ? null : id); }
async function loadNodes(sub, force = false) {
  if (nodeState[sub.id]?.loaded && !force) return;
  nodeState[sub.id] = { loading: true, loaded: false, error: '', nodes: nodeState[sub.id]?.nodes || [] };
  try {
    const result = await api.post('/api/subscription_nodes', { subscriptionId: sub.id, applyTransform: false });
    const nodes = Array.isArray(result?.nodes) ? result.nodes : Array.isArray(result?.data?.nodes) ? result.data.nodes : [];
    const enriched = await Promise.all(nodes.map(async node => ({ ...node, _fingerprint: await nodeFingerprint(nodeUrl(node)) })));
    nodeState[sub.id] = { loading: false, loaded: true, error: '', nodes: enriched };
  } catch (error) {
    nodeState[sub.id] = { loading: false, loaded: false, error: error?.message || t('profileModal.loadNodesFailed'), nodes: nodeState[sub.id]?.nodes || [] };
  }
}
async function toggleExpand(sub) { expanded[sub.id] = !expanded[sub.id]; if (expanded[sub.id]) await loadNodes(sub); }
function toggleNode(id, fingerprint) {
  if (isWhole(id)) {
    const remaining = (nodeState[id]?.nodes || []).map(node => node._fingerprint).filter(value => value !== fingerprint);
    replaceEntry(id, remaining.length ? { id, nodeSelection: { mode: 'include', fingerprints: remaining } } : null);
    return;
  }
  const selected = selectedFingerprints(id);
  if (selected.has(fingerprint)) selected.delete(fingerprint); else selected.add(fingerprint);
  replaceEntry(id, selected.size ? { id, nodeSelection: { mode: 'include', fingerprints: Array.from(selected) } } : null);
}
</script>

<template>
  <div v-if="subscriptions.length" class="space-y-2">
    <div class="flex items-center justify-between"><h4 class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t('profileModal.selectSubscriptions') }}</h4><div class="space-x-2"><button type="button" class="text-xs text-indigo-600 hover:underline" @click="emit('select-all')">{{ t('profileModal.selectAll') }}</button><button type="button" class="text-xs text-indigo-600 hover:underline" @click="emit('deselect-all')">{{ t('profileModal.deselectAll') }}</button></div></div>
    <div class="h-[42px]"></div>
    <div class="relative"><input v-model="searchModel" type="text" :placeholder="t('subscriptions.searchPlaceholder')" class="w-full border px-3 py-1.5 text-sm tsub-radius-md dark:border-gray-600 dark:bg-gray-800" /></div>
    <div class="h-44 space-y-2 overflow-y-auto border bg-gray-50 p-3 tsub-radius-md dark:border-gray-700 dark:bg-gray-900/50 lg:h-72">
      <div v-for="sub in filteredSubscriptions" :key="sub.id" class="rounded border border-transparent bg-white/70 dark:bg-gray-800/60">
        <div class="flex min-w-0 items-center gap-2 px-2 py-1.5">
          <button type="button" class="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700" :aria-label="t('profileModal.expandNodes')" @click="toggleExpand(sub)"><span class="block transition-transform" :class="expanded[sub.id] ? 'rotate-90' : ''">›</span></button>
          <input type="checkbox" :checked="isSelected(sub.id)" :indeterminate.prop="isPartial(sub.id) && !isWhole(sub.id)" class="h-4 w-4 rounded-sm text-indigo-600" @change="toggleWhole(sub.id)" />
          <button type="button" class="min-w-0 flex-1 truncate text-left text-sm" :title="sub.name" @click="toggleWhole(sub.id)">{{ sub.name || t('subscriptions.unnamed') }}</button>
          <span v-if="isPartial(sub.id)" class="shrink-0 text-[11px] text-indigo-600">{{ t('profileModal.selectedNodes', { count: selectedFingerprints(sub.id).size }) }}</span>
        </div>
        <div v-if="expanded[sub.id]" class="border-t px-3 py-2 dark:border-gray-700">
          <p v-if="nodeState[sub.id]?.loading" class="text-xs text-gray-500">{{ t('profileModal.loadingNodes') }}</p>
          <div v-else-if="nodeState[sub.id]?.error" class="flex items-center justify-between gap-2 text-xs text-red-600"><span>{{ nodeState[sub.id].error }}</span><button type="button" class="text-indigo-600 hover:underline" @click="loadNodes(sub, true)">{{ t('profileModal.retry') }}</button></div>
          <p v-else-if="!nodeState[sub.id]?.nodes?.length" class="text-xs text-gray-500">{{ t('profileModal.noSourceNodes') }}</p>
          <label v-for="node in nodeState[sub.id]?.nodes || []" :key="node._fingerprint" class="flex cursor-pointer items-center gap-2 py-1 pl-6 text-xs"><input type="checkbox" :checked="isWhole(sub.id) || selectedFingerprints(sub.id).has(node._fingerprint)" @change="toggleNode(sub.id, node._fingerprint)" /><span class="truncate" :title="nodeName(node)">{{ nodeName(node) }}</span></label>
        </div>
      </div>
      <p v-if="!filteredSubscriptions.length" class="py-4 text-center text-sm text-gray-500">{{ t('profileModal.noMatchedSubscriptions') }}</p>
    </div>
    <div v-if="orderedSelectedSubs.length" class="mt-3"><h5 class="mb-1.5 text-xs text-gray-500">{{ t('profileModal.selectedDrag', { count: orderedSelectedSubs.length }) }}</h5><draggable v-model="orderedSelectedSubs" item-key="id" handle=".drag-handle" class="h-32 space-y-1 overflow-y-auto border border-indigo-200 bg-indigo-50 p-2 tsub-radius-md dark:bg-indigo-900/20"><template #item="{ element, index }"><div class="flex items-center gap-2 border bg-white px-2 py-1.5 dark:bg-gray-800"><span class="drag-handle cursor-grab text-gray-400">☰</span><span class="w-5 text-xs text-indigo-600">{{ index + 1 }}</span><span class="min-w-0 flex-1 truncate text-sm">{{ element.name }}</span><span v-if="element._entry?.nodeSelection" class="text-[11px] text-indigo-600">{{ t('profileModal.selectedNodes', { count: element._entry.nodeSelection.fingerprints.length }) }}</span><button type="button" class="text-gray-400 hover:text-red-500" @click="replaceEntry(element.id, null)">×</button></div></template></draggable></div>
  </div>
  <div v-else class="flex h-full items-center justify-center bg-gray-50 p-4 text-sm text-gray-500 tsub-radius-md dark:bg-gray-900/50">{{ t('profileModal.noAvailableSubscriptions') }}</div>
</template>
