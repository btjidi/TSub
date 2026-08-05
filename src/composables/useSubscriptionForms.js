import { ref } from 'vue';
import { useToastStore } from '../stores/toast.js';
import { generateSubscriptionId } from '../utils/id.js';
import { t } from '../i18n/index.js';
import { trafficQuotaBytesToForm, trafficQuotaFormToBytes } from '../utils/traffic-quota.js';

const isDev = import.meta.env.DEV;

function attachTrafficQuotaForm(subscription) {
    const form = trafficQuotaBytesToForm(subscription?.trafficQuotaOverrideBytes);
    subscription._trafficQuotaValue = form.value;
    subscription._trafficQuotaUnit = form.unit;
    return subscription;
}

function stripTrafficQuotaForm(subscription) {
    const result = trafficQuotaFormToBytes(subscription?._trafficQuotaValue, subscription?._trafficQuotaUnit);
    if (!result.valid) return null;
    const cleaned = { ...subscription, trafficQuotaOverrideBytes: result.value };
    delete cleaned._trafficQuotaValue;
    delete cleaned._trafficQuotaUnit;
    return cleaned;
}

export function useSubscriptionForms({ addSubscription, updateSubscription }) {
    const { showToast } = useToastStore();
    const showModal = ref(false);
    const isNew = ref(false);
    const editingSubscription = ref(null);

    const openAdd = () => {
        isNew.value = true;
        editingSubscription.value = attachTrafficQuotaForm({
            name: '',
            url: '',
            enabled: true,
            exclude: '',
            customUserAgent: '',
            fetchProxy: '',
            enableNodeCache: false,
            plusAsSpace: false,
            excludeTraffic: false,
            website: '',
            notes: ''
        });
        showModal.value = true;
    };

    const openEdit = (sub) => {
        if (!sub) {
            console.error('UseSubscriptionForms: openEdit called with null/undefined');
            return;
        }
        if (isDev) {
            console.debug('UseSubscriptionForms: openEdit called with', sub);
        }
        isNew.value = false;
        // Deep copy to avoid mutating store state directly before save
        try {
            editingSubscription.value = attachTrafficQuotaForm(JSON.parse(JSON.stringify(sub)));
            if (isDev) {
                console.debug('UseSubscriptionForms: editingSubscription set to', editingSubscription.value);
            }
            showModal.value = true;
        } catch (e) {
            console.error('UseSubscriptionForms: Failed to clone subscription', e);
        }
    };

    const handleSave = () => {
        if (!editingSubscription.value || !editingSubscription.value.url) {
            showToast(t('subscriptions.urlRequired'), 'error');
            return;
        }
        if (!/^https?:\/\//i.test(editingSubscription.value.url)) {
            showToast(t('subscriptions.invalidUrl'), 'error');
            return;
        }
        const cleanedSubscription = stripTrafficQuotaForm(editingSubscription.value);
        if (!cleanedSubscription) {
            showToast(t('subscriptions.trafficQuotaInvalid'), 'error');
            return;
        }

        if (isNew.value) {
            addSubscription({ ...cleanedSubscription, id: generateSubscriptionId() });
        } else {
            updateSubscription(cleanedSubscription);
        }
        showModal.value = false;
    };

    return {
        showModal,
        isNew,
        editingSubscription,
        openAdd,
        openEdit,
        handleSave
    };
}
