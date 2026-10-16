<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout">
    <div class="max-w-4xl mx-auto">
      <h1 class="text-2xl font-bold text-gray-800 mb-6">系统设置</h1>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <router-link to="/settings/basic"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-blue-200 transition-all group">
          <div class="w-14 h-14 bg-blue-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-blue-100 transition-colors">
            <i class="fa-solid fa-globe text-blue-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">基本设置</h2>
          <p class="text-sm text-gray-500">管理站点名称、管理员邮箱和评论审核机制</p>
        </router-link>

        <router-link to="/settings/email"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-teal-200 transition-all group">
          <div class="w-14 h-14 bg-teal-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-teal-100 transition-colors">
            <i class="fa-solid fa-envelope text-teal-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">邮件通知</h2>
          <p class="text-sm text-gray-500">配置 SMTP 服务器和编辑邮件通知模板</p>
        </router-link>

        <router-link to="/settings/security"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-red-200 transition-all group">
          <div class="w-14 h-14 bg-red-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-red-100 transition-colors">
            <i class="fa-solid fa-shield-halved text-red-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">安全设置</h2>
          <p class="text-sm text-gray-500">管理 CORS 跨域、IP 黑名单、邮箱黑名单等安全策略</p>
        </router-link>

        <router-link to="/settings/account"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-amber-200 transition-all group">
          <div class="w-14 h-14 bg-amber-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-amber-100 transition-colors">
            <i class="fa-solid fa-user-lock text-amber-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">账户安全</h2>
          <p class="text-sm text-gray-500">修改管理员用户名和密码</p>
        </router-link>

        <router-link to="/settings/data"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-emerald-200 transition-all group">
          <div class="w-14 h-14 bg-emerald-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-emerald-100 transition-colors">
            <i class="fa-solid fa-database text-emerald-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">数据管理</h2>
          <p class="text-sm text-gray-500">导入导出评论数据和系统设置（JSON 格式）</p>
        </router-link>

        <router-link to="/settings/emoji"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-violet-200 transition-all group">
          <div class="w-14 h-14 bg-violet-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-violet-100 transition-colors">
            <i class="fa-solid fa-face-smile text-violet-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">表情设置</h2>
          <p class="text-sm text-gray-500">启用或关闭表情按钮，配置 OwO 格式的表情来源地址</p>
        </router-link>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AdminLayout from '../components/AdminLayout.vue'

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
