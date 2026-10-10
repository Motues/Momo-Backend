import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue')
  },
  {
    path: '/',
    name: 'Stats',
    component: () => import('../views/Stats.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/comments',
    name: 'Comments',
    component: () => import('../views/Dashboard.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/users',
    name: 'Users',
    component: () => import('../views/Users.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/user-comments',
    name: 'UserComments',
    component: () => import('../views/UserComments.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/verify-records',
    name: 'VerifyRecords',
    component: () => import('../views/VerifyRecords.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/Settings.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/settings/basic',
    name: 'BasicSettings',
    component: () => import('../views/BasicSettings.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/settings/site',
    redirect: '/settings/basic'
  },
  {
    path: '/settings/email',
    name: 'EmailSettings',
    component: () => import('../views/EmailSettings.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/settings/security',
    name: 'SecuritySettings',
    component: () => import('../views/SecuritySettings.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/settings/account',
    name: 'AccountSettings',
    component: () => import('../views/AccountSettings.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/settings/data',
    name: 'DataManagement',
    component: () => import('../views/DataManagement.vue'),
    meta: { requiresAuth: true }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  if (to.meta.requiresAuth && !token) {
    next('/login')
  } else if (to.path === '/login' && token) {
    next('/')
  } else {
    next()
  }
})

export default router
