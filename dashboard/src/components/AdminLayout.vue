<template>
  <div class="flex h-screen overflow-hidden font-sans bg-gray-50">
    <!-- Mobile overlay -->
    <div v-if="isMobileMenuOpen" class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden" @click="closeMobileMenu"></div>

    <!-- Sidebar -->
    <aside :class="[
      'fixed md:static top-0 left-0 z-50 h-full flex flex-col flex-shrink-0 transition-all duration-300 ease-in-out border-r',
      'w-64',
      isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
      'md:w-64',
      'bg-white text-gray-700 border-gray-200'
    ]">
      <div class="h-16 flex items-center justify-between px-6 border-b bg-gray-50 border-gray-200">
        <div class="flex items-center">
          <img src="../assets/logo.svg" class="w-8 h-8" alt="Logo" />
          <span class="ml-2 font-bold tracking-wide text-gray-800">管理后台</span>
        </div>
        <button @click="closeMobileMenu" class="md:hidden w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-gray-200">
          <i class="fa-solid fa-xmark text-lg text-gray-600"></i>
        </button>
      </div>

      <nav class="flex-1 mt-4 px-3 space-y-1">
        <router-link to="/" @click="closeMobileMenu"
          :class="['flex items-center px-3 py-2.5 rounded-lg group transition-colors',
            isActive('/') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100']">
          <i class="fa-solid fa-chart-simple w-5 mr-3"></i>
          <span class="font-medium">数据统计</span>
        </router-link>
        <router-link to="/comments" @click="closeMobileMenu"
          :class="['flex items-center px-3 py-2.5 rounded-lg group transition-colors',
            isActive('/comments') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100']">
          <i class="fa-solid fa-table-list w-5 mr-3"></i>
          <span class="font-medium">评论管理</span>
        </router-link>
        <router-link to="/users" @click="closeMobileMenu"
          :class="['flex items-center px-3 py-2.5 rounded-lg group transition-colors',
            isActive('/users') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100']">
          <i class="fa-solid fa-users w-5 mr-3"></i>
          <span class="font-medium">用户列表</span>
        </router-link>
        <router-link to="/settings" @click="closeMobileMenu"
          :class="['flex items-center px-3 py-2.5 rounded-lg group transition-colors',
            isActive('/settings') ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100']">
          <i class="fa-solid fa-sliders w-5 mr-3"></i>
          <span class="font-medium">系统设置</span>
        </router-link>
      </nav>

      <div class="p-4 border-t text-[10px] uppercase tracking-widest text-center border-gray-200 text-gray-500">
        Powered by Momo-Backend
      </div>
    </aside>

    <!-- Main content -->
    <div class="flex-1 flex flex-col min-w-0">
      <header class="h-16 flex items-center justify-between px-4 md:px-8 shrink-0 border-b bg-white border-gray-200">
        <div class="flex items-center space-x-3 md:space-x-4">
          <button @click="toggleMobileMenu" class="md:hidden w-10 h-10 flex items-center justify-center rounded-lg transition-colors hover:bg-gray-100">
            <i class="fa-solid fa-bars text-xl text-gray-600"></i>
          </button>
          <div class="flex items-center">
            <h2 class="text-base md:text-lg font-semibold text-gray-800">{{ pageTitle }}</h2>
          </div>
          <span class="hidden sm:inline-block px-2 py-0.5 text-[10px] rounded font-mono bg-gray-100 text-gray-500">{{ baseUrl }}</span>
        </div>

        <div class="flex items-center space-x-2 md:space-x-6">
          <button @click="$emit('refresh')" class="hidden sm:flex items-center px-3 py-2 rounded-lg transition-colors text-sm hover:bg-gray-100 text-gray-600 hover:text-blue-600">
            <i class="fa-solid fa-arrows-rotate mr-2"></i> 刷新数据
          </button>
          <button @click="$emit('refresh')" class="sm:hidden w-9 h-9 flex items-center justify-center rounded-lg transition-colors hover:bg-gray-100" title="刷新">
            <i class="fa-solid fa-arrows-rotate text-base text-gray-600"></i>
          </button>

          <button @click="handleLogout" class="px-3 py-1.5 md:px-4 md:py-2 rounded-lg transition-colors text-sm font-medium hover:bg-red-100 bg-red-50 text-red-600">
            <span class="hidden sm:inline">退出登录</span>
            <span class="sm:hidden"><i class="fa-solid fa-right-from-bracket"></i></span>
          </button>
        </div>
      </header>

      <main class="flex-1 overflow-y-auto p-4 md:p-6 bg-gray-50">
        <slot></slot>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import request from '../utils/request';

const route = useRoute();

defineProps(['baseUrl']);
const emit = defineEmits(['logout', 'refresh']);

/**
 * 退出登录：先请求后端吊销 token（失败也不阻塞退出流程），
 * 再交给各页面既有的注销逻辑清理本地状态。
 */
const handleLogout = async () => {
  try {
    await request.post('/admin/logout');
  } catch {
    // 忽略：token 可能已过期或后端不支持该接口
  }
  emit('logout');
};

const isMobileMenuOpen = ref(false);

const toggleMobileMenu = () => {
  isMobileMenuOpen.value = !isMobileMenuOpen.value;
};

const closeMobileMenu = () => {
  isMobileMenuOpen.value = false;
};

const isActive = (path) => {
  if (path === '/') return route.path === '/';
  if (path === '/comments') return route.path.startsWith('/comments');
  if (path === '/users') return route.path.startsWith('/users');
  if (path === '/settings') return route.path.startsWith('/settings');
  return route.path.startsWith(path);
};

const pageTitle = computed(() => {
  const map = {
    '/': '数据统计',
    '/comments': '评论列表',
    '/users': '用户列表',
    '/user-comments': '用户评论',
    '/settings': '系统设置',
    '/settings/basic': '基本设置',
    '/settings/email': '邮件通知',
    '/settings/security': '安全设置',
    '/settings/account': '账户安全',
    '/settings/data': '数据管理',
  };
  const matched = Object.keys(map).find(path => route.path === path);
  return matched ? map[matched] : '管理后台';
});
</script>
