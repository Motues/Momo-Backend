<template>
  <div class="min-h-screen flex items-center justify-center bg-[#b5cffc] relative overflow-hidden font-sans">
    <div class="absolute top-[-10%] left-[-5%] w-[60%] h-[70%] bg-blue-600 rounded-full mix-blend-soft-light filter blur-[80px] opacity-60 animate-pulse"></div>
    <div class="absolute bottom-[-20%] right-[-10%] w-[50%] h-[60%] bg-[#2d5cf7] rounded-full mix-blend-multiply filter blur-[100px] opacity-40"></div>
    
    <div class="z-10 w-full max-w-[420px] px-6">
      <div class="bg-white p-10 rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.1)]">
        
        <div class="flex flex-col items-center mb-8">
          <div class="flex items-center gap-2">
            <img src="../assets/logo.svg" class="w-8 h-8" alt="Logo" />
            <h2 class="text-[#3b82f6] text-2xl font-bold tracking-tight">欢迎登录管理系统</h2>
          </div>
        </div>

        <form class="space-y-4" @submit.prevent="handleLogin">
          <div class="space-y-1">
            <input 
              v-model="form.apiUrl" 
              type="text" 
              required 
              class="w-full px-4 py-3 bg-[#f0f5ff] border-none rounded-lg focus:ring-2 focus:ring-blue-300 transition-all outline-none text-gray-600 placeholder-gray-400"
              placeholder="后端 API 地址"
            />
            <p v-if="apiUrlWarning" class="text-xs text-red-400 px-1">{{ apiUrlWarning }}</p>
          </div>

          <div class="space-y-1">
            <input 
              v-model="form.name" 
              type="text" 
              required 
              class="w-full px-4 py-3 bg-[#f0f5ff] border-none rounded-lg focus:ring-2 focus:ring-blue-300 transition-all outline-none text-gray-700"
              placeholder="用户名"
            />
          </div>

          <div class="space-y-1">
            <input 
              v-model="form.password" 
              type="password" 
              required 
              class="w-full px-4 py-3 bg-[#f0f5ff] border-none rounded-lg focus:ring-2 focus:ring-blue-300 transition-all outline-none text-gray-700"
              placeholder="密码"
            />
          </div>

          <!-- 按钮组 -->
          <div class="flex gap-3 pt-2">
            <button 
              type="button"
              @click="resetForm"
              class="flex-1 py-3 bg-[#d5eff2] text-[#1da1b1] rounded-lg font-bold hover:bg-[#c4e8ed] transition-colors"
            >
              清除
            </button>
            <button 
              type="submit" 
              :disabled="loading"
              class="flex-1 py-3 bg-[#e2efff] text-[#3b82f6] rounded-lg font-bold hover:bg-[#d4e6ff] transition-all disabled:opacity-50"
            >
              {{ loading ? '验证中...' : '登录' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 首次登录强制修改密码弹窗 -->
    <div v-if="showPasswordModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div class="bg-white rounded-xl shadow-[0_20px_50px_rgba(0,0,0,0.1)] max-w-md w-full mx-4 p-8">
        <h3 class="text-[#3b82f6] text-xl font-bold mb-1">安全保护</h3>
        <p class="text-gray-500 text-sm mb-6">为了您的账户安全，初次登录请更新您的凭据。</p>
        <form @submit.prevent="handleChangePassword" class="space-y-3">
          <div>
            <input v-model="passwordForm.new_name" type="text" placeholder="新用户名" required @input="validatePwForm"
              :class="['w-full px-4 py-3 rounded-lg outline-none focus:ring-2 focus:ring-blue-300 transition-all text-sm',
                pv.newName === 'valid' ? 'bg-green-50 border border-green-300' : 'bg-[#f0f5ff] border-none']" />
          </div>
          <div>
            <input v-model="passwordForm.new_password" type="password" placeholder="新密码" required minlength="4" @input="validatePwForm"
              :class="['w-full px-4 py-3 rounded-lg outline-none focus:ring-2 focus:ring-blue-300 transition-all text-sm',
                pv.newPassword === 'valid' ? 'bg-green-50 border border-green-300' : pv.newPassword === 'invalid' ? 'bg-red-50 border border-red-300' : 'bg-[#f0f5ff] border-none']" />
            <p v-if="pv.newPassword === 'invalid'" class="mt-1 text-xs text-red-500 flex items-center gap-1 px-1">
              <i class="fa-solid fa-circle-exclamation"></i> 密码长度不能少于 4 位
            </p>
          </div>
          <div>
            <input v-model="passwordForm.confirm_password" type="password" placeholder="确认新密码" required minlength="4" @input="validatePwForm"
              :class="['w-full px-4 py-3 rounded-lg outline-none focus:ring-2 focus:ring-blue-300 transition-all text-sm',
                pv.confirmPassword === 'valid' ? 'bg-green-50 border border-green-300' : pv.confirmPassword === 'invalid' ? 'bg-red-50 border border-red-300' : 'bg-[#f0f5ff] border-none']" />
            <p v-if="pv.confirmPassword === 'invalid'" class="mt-1 text-xs text-red-500 flex items-center gap-1 px-1">
              <i class="fa-solid fa-circle-exclamation"></i> 两次输入的密码不一致
            </p>
          </div>
          <button type="submit" :disabled="changingPassword" class="w-full py-3 bg-[#e2efff] text-[#3b82f6] rounded-lg font-bold hover:bg-[#d4e6ff] transition-all disabled:opacity-50">
            {{ changingPassword ? '正在更新...' : '确认更新' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
/* 此处代码逻辑完全保持不变，确保您的功能正常运作 */
import { ref, reactive, computed } from 'vue'
import { useRouter } from 'vue-router'
import request from '../utils/request'
import toast from '../utils/toast'
import { normalizeApiUrl, isAllowedApiUrl, API_URL_REQUIREMENT } from '../utils/apiUrl'

const router = useRouter()
const loading = ref(false)
const showPasswordModal = ref(false)
const changingPassword = ref(false)

const form = reactive({
  apiUrl: localStorage.getItem('apiUrl') || window.location.origin,
  name: '',
  password: ''
})

const passwordForm = reactive({
  new_name: '',
  new_password: '',
  confirm_password: ''
})

// 仅在地址不满足安全要求时才提示（浅红色）
const apiUrlWarning = computed(() => {
  const raw = (form.apiUrl || '').trim()
  if (!raw) return ''
  return isAllowedApiUrl(raw) ? '' : API_URL_REQUIREMENT
})

// 实时校验状态
const pv = reactive({
  newName: '',
  newPassword: '',
  confirmPassword: '',
})

const validatePwForm = () => {
  pv.newName = passwordForm.new_name ? 'valid' : ''
  if (passwordForm.new_password) {
    pv.newPassword = passwordForm.new_password.length >= 4 ? 'valid' : 'invalid'
  } else {
    pv.newPassword = ''
  }
  if (passwordForm.new_password || passwordForm.confirm_password) {
    if (!passwordForm.confirm_password) {
      pv.confirmPassword = 'invalid'
    } else {
      pv.confirmPassword = passwordForm.new_password === passwordForm.confirm_password ? 'valid' : 'invalid'
    }
  } else {
    pv.confirmPassword = ''
  }
}

const resetForm = () => {
  form.name = ''
  form.password = ''
}

const handleChangePassword = async () => {
  validatePwForm()
  if (passwordForm.new_password !== passwordForm.confirm_password) {
    pv.confirmPassword = 'invalid'
    toast.warning('两次输入的密码不一致')
    return
  }
  if (passwordForm.new_password.length < 4) {
    pv.newPassword = 'invalid'
    toast.warning('密码长度不能少于4位')
    return
  }

  changingPassword.value = true
  try {
    const res = await request.put('/admin/password', {
      old_name: form.name,
      old_password: form.password,
      new_name: passwordForm.new_name,
      new_password: passwordForm.new_password
    })
    if (res.code === 200) {
      toast.success('管理员凭据已更新，请重新登录')
      localStorage.removeItem('token')
      showPasswordModal.value = false
      resetForm()
    }
  } catch (e) {
    // console.error('Password change failed:', e)
    toast.error('密码更新失败')
  } finally {
    changingPassword.value = false
  }
}

const handleLogin = async () => {
  if (!form.name || !form.password) {
    toast.warning('请填写用户名和密码')
    return
  }

  loading.value = true
  // 校验 API 地址：token 会附加到发往该地址的每个请求上，必须限制为可信地址
  const formattedApiUrl = normalizeApiUrl(form.apiUrl)
  if (!formattedApiUrl) {
    toast.error(`API 地址无效：${API_URL_REQUIREMENT}`)
    loading.value = false
    return
  }
  localStorage.setItem('apiUrl', formattedApiUrl)
  try {
    const res = await request.post('/admin/login', { name: form.name, password: form.password })
    if (res.code === 200) {
      toast.success('欢迎回来')
      localStorage.setItem('token', res.token)
      localStorage.setItem('admin_name', form.name)
      if (res.needChangePassword) {
        showPasswordModal.value = true
      } else {
        router.push('/')
      }
    }
  } catch (error) {
    toast.error('登录失败，请检查配置')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
/* 这里可以根据需要微调背景动画 */
@keyframes pulse {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50% { opacity: 0.8; transform: scale(1.05); }
}
.animate-pulse {
  animation: pulse 8s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
</style>