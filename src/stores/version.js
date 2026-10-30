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

    const localChangelog = `**TSub 1.0.14**
- 代理部署生成器增加手动配置与已有部署公共配置复用入口。
- 可分别复用入站、TLS/REALITY 公共参数、出站、端口、节点名称、WARP 身份和订阅服务。
- 默认重新生成端口、UUID、密码、私钥和订阅 Token，避免新部署与来源节点冲突。
- 选择复用敏感项时由后端从加密配置中定向恢复，浏览器和模板接口不接触原始密钥。
- 直连、WARP 自动、WARP IPv4 和 WARP IPv6 出站继续使用统一兼容性校验。
- 修正 Miniflare D1 集成用例的独立超时配置，提升全量测试稳定性。`;

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
