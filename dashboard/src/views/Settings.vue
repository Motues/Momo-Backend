<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout">
    <div class="max-w-4xl mx-auto">
      <h1 class="text-2xl font-bold text-gray-800 mb-6">系统设置</h1>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- 1. 基本设置 -->
        <router-link to="/settings/basic" data-test="settings-card"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-blue-200 transition-all group">
          <div class="w-14 h-14 bg-blue-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-blue-100 transition-colors">
            <i class="fa-solid fa-globe text-blue-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">基本设置</h2>
          <p class="text-sm text-gray-500">站点名称与 API 地址、管理员邮箱、管理员评论密钥、评论审核（含邮箱验证）、博主标识、占位符</p>
        </router-link>

        <!-- 2. 账户安全 -->
        <router-link to="/settings/account" data-test="settings-card"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-amber-200 transition-all group">
          <div class="w-14 h-14 bg-amber-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-amber-100 transition-colors">
            <i class="fa-solid fa-user-lock text-amber-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">账户安全</h2>
          <p class="text-sm text-gray-500">修改管理员用户名和密码</p>
        </router-link>

        <!-- 3. 邮件通知 -->
        <router-link to="/settings/email" data-test="settings-card"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-teal-200 transition-all group">
          <div class="w-14 h-14 bg-teal-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-teal-100 transition-colors">
            <i class="fa-solid fa-envelope text-teal-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">邮件通知</h2>
          <p class="text-sm text-gray-500">配置 SMTP 服务器和编辑邮件通知模板</p>
        </router-link>

        <!-- 4. 访问控制 -->
        <router-link to="/settings/security" data-test="settings-card"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-red-200 transition-all group">
          <div class="w-14 h-14 bg-red-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-red-100 transition-colors">
            <i class="fa-solid fa-shield-halved text-red-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">访问控制</h2>
          <p class="text-sm text-gray-500">管理来源白名单、IP / 邮箱黑名单与真实 IP 识别</p>
        </router-link>

        <!-- 5. 链接安全 -->
        <router-link to="/settings/link" data-test="settings-card"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-sky-200 transition-all group">
          <div class="w-14 h-14 bg-sky-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-sky-100 transition-colors">
            <i class="fa-solid fa-link text-sky-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">链接安全</h2>
          <p class="text-sm text-gray-500">管理休眠链接提示与历史链接同步（评论者邮件确认后才改写）</p>
        </router-link>

        <!-- 6. 人机验证 -->
        <router-link to="/settings/verify" data-test="settings-card"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-indigo-200 transition-all group">
          <div class="w-14 h-14 bg-indigo-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-indigo-100 transition-colors">
            <i class="fa-solid fa-robot text-indigo-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">人机验证</h2>
          <p class="text-sm text-gray-500">管理工作量证明、环境质询、来源域名绑定与认证记录保留</p>
        </router-link>

        <!-- 7. 表情设置 -->
        <router-link to="/settings/emoji" data-test="settings-card"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-violet-200 transition-all group">
          <div class="w-14 h-14 bg-violet-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-violet-100 transition-colors">
            <i class="fa-solid fa-face-smile text-violet-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">表情设置</h2>
          <p class="text-sm text-gray-500">启用或关闭表情按钮，配置 OwO 格式的表情来源地址</p>
        </router-link>

        <!-- 8. 数据管理（固定最后） -->
        <router-link to="/settings/data" data-test="settings-card"
          class="block bg-white rounded-lg shadow-sm border border-gray-200 p-8 hover:shadow-md hover:border-emerald-200 transition-all group">
          <div class="w-14 h-14 bg-emerald-50 rounded-lg flex items-center justify-center mb-4 group-hover:bg-emerald-100 transition-colors">
            <i class="fa-solid fa-database text-emerald-500 text-2xl"></i>
          </div>
          <h2 class="text-lg font-semibold text-gray-800 mb-2">数据管理</h2>
          <p class="text-sm text-gray-500">导入导出评论数据与系统设置（JSON 格式）</p>
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
