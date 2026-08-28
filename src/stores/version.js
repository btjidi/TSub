import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { fetchGithubLatestRelease } from '../lib/api.js';
import packageJson from '../../package.json';

export const useVersionStore = defineStore('version', () => {
    // --- State ---
    const currentVersion = ref(packageJson.version);
    const latestRelease = ref(null);
    const showModal = ref(false);
    const showUpdateNotice = ref(false);
    const upstreamRepo = 'btjidi/TSub';

    const localChangelog = `**TSub 1.0.6**
- 自托管部署增加节点侧公网 IPv4/IPv6 备用探测。
- AWS Global API 作为主探测，Akamai HTTPS 作为备用。
- 主控地址探测失败时显示更明确的错误原因。
- HTTP 400/401/403 不再无限重试，保留手动填写公网地址兜底。`;

    // --- Getters ---
    const hasUpdate = computed(() => {
        if (!latestRelease.value?.tag_name) return false;
        return compareVersions(latestRelease.value.tag_name, currentVersion.value) > 0;
    });

    const isUpToDate = computed(() => {
        if (!latestRelease.value?.tag_name) return true;
        return compareVersions(latestRelease.value.tag_name, currentVersion.value) === 0;
    });

    // --- Helpers ---
    function normalizeVersion(version) {
        return String(version || '').trim().replace(/^v/i, '');
    }

    function compareVersions(left, right) {
        const a = normalizeVersion(left).split('.').map(n => parseInt(n, 10) || 0);
        const b = normalizeVersion(right).split('.').map(n => parseInt(n, 10) || 0);
        const maxLen = Math.max(a.length, b.length);
        for (let i = 0; i < maxLen; i += 1) {
            const av = a[i] || 0;
            const bv = b[i] || 0;
            if (av > bv) return 1;
            if (av < bv) return -1;
        }
        return 0;
    }

    function getDismissKey(releaseTag) {
        return `tsub_release_notes_hidden:${normalizeVersion(currentVersion.value)}:${normalizeVersion(releaseTag)}`;
    }

    // --- Actions ---
    async function checkVersion(suppressModal = false) {
        try {
            const release = await fetchGithubLatestRelease(upstreamRepo);
            if (release?.success === false) return;
            if (release?.tag_name) {
                latestRelease.value = release;
                const comparison = compareVersions(release.tag_name, currentVersion.value);
                
                if (comparison > 0) {
                    showUpdateNotice.value = true;
                } else if (comparison === 0 && !suppressModal) {
                    // 如果已是最新且未被禁止，则尝试显示更新日志
                    const dismissKey = getDismissKey(release.tag_name);
                    if (localStorage.getItem(dismissKey) !== 'true') {
                        showModal.value = true;
                    }
                }
            }
        } catch {
            // Version discovery must never interrupt or pollute normal navigation.
        }
    }

    function openModal() {
        showModal.value = true;
    }

    function closeModal() {
        showModal.value = false;
    }

    function suppressUpdateModal() {
        if (latestRelease.value?.tag_name) {
            localStorage.setItem(getDismissKey(latestRelease.value.tag_name), 'true');
        }
        showModal.value = false;
    }

    return {
        currentVersion,
        latestRelease,
        localChangelog,
        showModal,
        showUpdateNotice,
        hasUpdate,
        isUpToDate,
        checkVersion,
        openModal,
        closeModal,
        suppressUpdateModal
    };
});
