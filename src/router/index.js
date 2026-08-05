import { createRouter, createWebHistory } from 'vue-router';
import { beginRouteNavigation, finishRouteNavigation } from '../state/routeNavigation.js';

const DashboardView = () => import('../views/DashboardView.vue');
const SubscriptionGroupsView = () => import('../views/SubscriptionGroupsView.vue');
const ManualNodesView = () => import('../views/ManualNodesView.vue');
const MySubscriptionsView = () => import('../views/MySubscriptionsView.vue');
const DeploymentsView = () => import('../views/DeploymentsView.vue');
const SettingsView = () => import('../views/SettingsView.vue');

const HomeView = () => import('../views/HomeView.vue');

const routes = [
    {
        path: '/',
        name: 'Home',
        component: HomeView,
        meta: { titleKey: 'routeTitles.home', isPublic: true }
    },
    {
        path: '/explore',
        name: 'Explore',
        component: HomeView,
        meta: { titleKey: 'routeTitles.explore', isPublic: true }
    },
    {
        path: '/dashboard',
        name: 'Dashboard',
        component: DashboardView,
        meta: { titleKey: 'routeTitles.dashboard' }
    },
    {
        path: '/dashboard/groups',
        name: 'SubscriptionGroups',
        component: SubscriptionGroupsView,
        meta: { titleKey: 'routeTitles.groups' }
    },
    {
        path: '/dashboard/nodes',
        name: 'ManualNodes',
        component: ManualNodesView,
        meta: { titleKey: 'routeTitles.nodes' }
    },
    {
        path: '/dashboard/subscriptions',
        name: 'MySubscriptions',
        component: MySubscriptionsView,
        meta: { titleKey: 'routeTitles.subscriptions' }
    },
    {
        path: '/dashboard/deployments',
        name: 'Deployments',
        component: DeploymentsView,
        meta: { titleKey: 'routeTitles.deployments' }
    },
    {
        path: '/dashboard/settings',
        name: 'Settings',
        component: SettingsView,
        meta: { titleKey: 'routeTitles.settings' }
    },
    {
        path: '/:pathMatch(.*)*',
        name: 'Entrance',
        component: () => import('../views/Entrance.vue'),
        meta: { titleKey: 'routeTitles.app', isPublic: true }
    }
];

const router = createRouter({
    history: createWebHistory(),
    routes,
    scrollBehavior(to, from, savedPosition) {
        if (savedPosition) {
            return savedPosition;
        } else {
            return { top: 0 };
        }
    }
});

// 自动恢复动态 chunk 加载失败导致的白屏
router.onError((error) => {
    finishRouteNavigation('', true);
    const message = error?.message || '';
    if (message.includes('Failed to fetch dynamically imported module')
        || message.includes('error loading dynamically imported module')) {
        const reloadKey = 'tsub:chunk-reload';
        if (sessionStorage.getItem(reloadKey) !== '1') {
            sessionStorage.setItem(reloadKey, '1');
            window.location.reload();
        }
    }
});

// Navigation guard
router.beforeEach(async (to, from, next) => {
    if (to.fullPath !== from.fullPath) beginRouteNavigation(to.path);
    // Simple auth check: check if the user is visiting a protected route
    // We rely on the session store state or a quick check.
    // However, pinia stores are only available after app is mounted or inside guards if pinia instance is passed?
    // Pinia is installed in main.js, so using it inside router.beforeEach (which is imported by main.js) might be tricky if called before app mount.
    // BUT, router.beforeEach is called on navigation.

    // Better approach: Check if we are on the login page. If not, and we don't have a flagged session, maybe redirect?
    // Actually, the sessionStore handles the initial check.
    // Let's just rely on the API 401 response to kick the user out (handled in api.js -> sessionStore).
    // BUT the user wants to populate the "enter operation interface" issue.
    // The most reliable way is: if "not logged in" state is known, block access.

    // Ideally, we'd import the session store here, but circular dependencies might occur.
    // Let's keep it simple: if the session check fails (which happens in App.vue or main.js), it redirects.
    // But to prevent "flash of content", we can add a simple check if we are SURE we aren't logged in.

    // For now, let's stick to the title update as the primary router responsibility, 
    // and rely on the Backend Redirect (implemented in Step 1) and API 401 handling for security.
    // The backend redirect covers the "refresh/direct link" case.
    // The API 401 covers the "token expired while using" case.

    next();
});

router.afterEach((to, from, failure) => {
    finishRouteNavigation(to.path, Boolean(failure));
});

export default router;
