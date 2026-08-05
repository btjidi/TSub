import { defineStore } from 'pinia';
import { ref } from 'vue';
import { DEFAULT_SETTINGS } from '@/constants/default-settings';
import { normalizeTrafficNodeDisplay } from '@/constants/traffic-node-settings';

function normalizeSettings(settings = {}) {
    return {
        ...DEFAULT_SETTINGS,
        ...settings,
        trafficNodeDisplay: normalizeTrafficNodeDisplay(settings.trafficNodeDisplay)
    };
}

export const useSettingsStore = defineStore('settings', () => {
    const config = ref(normalizeSettings());

    function setConfig(newConfig) {
        config.value = normalizeSettings(newConfig);
    }

    function updateConfig(updates) {
        config.value = normalizeSettings({ ...config.value, ...updates });
    }

    return {
        config,
        setConfig,
        updateConfig
    };
});
