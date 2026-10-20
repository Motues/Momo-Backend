<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">账户安全</h1>
        </div>
      </div>

      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-shield-halved text-amber-500"></i> 修改凭据
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">当前用户名</label>
            <input :value="form.admin_name || adminName" type="text" disabled
              class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed" />
          </div>
          <div></div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">新用户名</label>
            <input v-model="passwordForm.new_name" type="text" placeholder="留空则不修改"
              @input="validateForm"
              :class="['w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm transition-colors',
                passwordForm.new_name && v.newName === 'valid' ? 'border-green-400 bg-green-50/30' : v.newName === 'valid' ? '' : v.newName === 'invalid' ? 'border-red-300 bg-red-50/30' : 'border-gray-300']" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">新密码</label>
            <input v-model="passwordForm.new_password" type="password" placeholder="留空则不修改" minlength="4"
              @input="validateForm"
              :class="['w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm transition-colors',
                v.newPassword === 'valid' ? 'border-green-400 bg-green-50/30' : v.newPassword === 'invalid' ? 'border-red-300 bg-red-50/30' : 'border-gray-300']" />
            <p v-if="v.newPassword === 'invalid'" class="mt-1 text-xs text-red-500 flex items-center gap-1">
              <i class="fa-solid fa-circle-exclamation"></i> 密码长度不能少于 4 位
            </p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">确认新密码</label>
            <input v-model="passwordForm.confirm_password" type="password" placeholder="再次输入新密码"
              @input="validateForm"
              :class="['w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm transition-colors',
                v.confirmPassword === 'valid' ? 'border-green-400 bg-green-50/30' : v.confirmPassword === 'invalid' ? 'border-red-300 bg-red-50/30' : 'border-gray-300']" />
            <p v-if="v.confirmPassword === 'invalid'" class="mt-1 text-xs text-red-500 flex items-center gap-1">
              <i class="fa-solid fa-circle-exclamation"></i> 两次输入的密码不一致
            </p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">当前密码 <span class="text-red-500">*</span></label>
            <input v-model="passwordForm.old_password" type="password" placeholder="输入当前密码以确认修改"
              @input="validateForm"
              :class="['w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm transition-colors',
                v.oldPassword === 'valid' ? 'border-green-400 bg-green-50/30' : v.oldPassword === 'invalid' ? 'border-red-300 bg-red-50/30' : 'border-gray-300']" />
            <p v-if="v.oldPassword === 'invalid'" class="mt-1 text-xs text-red-500 flex items-center gap-1">
              <i class="fa-solid fa-circle-exclamation"></i> 请输入当前密码
            </p>
          </div>
        </div>
        <div class="mt-4 flex items-center gap-3">
          <button @click="changePassword" :disabled="changingPassword"
            class="px-5 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors text-sm font-medium">
            {{ changingPassword ? '更新中...' : '修改凭据' }}
          </button>
          <p class="text-xs text-gray-400">修改后需要重新登录</p>
        </div>
      </section>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import request from '../utils/request'
import toast from '../utils/toast'
import AdminLayout from '../components/AdminLayout.vue'

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)
const adminName = ref(localStorage.getItem('admin_name') || '')

const changingPassword = ref(false)

const form = reactive({
  admin_name: '',
})

const passwordForm = reactive({
  old_password: '',
  new_name: '',
  new_password: '',
  confirm_password: '',
})

// 实时校验状态
const v = reactive({
  newName: '',
  newPassword: '',
  confirmPassword: '',
  oldPassword: '',
})

const validateForm = () => {
  // 新用户名：只要不为空即有效
  v.newName = passwordForm.new_name ? 'valid' : ''

  // 新密码：如果填写了，必须 >= 4 位；没填则不校验
  if (passwordForm.new_password) {
    v.newPassword = passwordForm.new_password.length >= 4 ? 'valid' : 'invalid'
  } else {
    v.newPassword = ''
  }

  // 确认密码：如果新密码或确认密码有内容，才校验
  if (passwordForm.new_password || passwordForm.confirm_password) {
    if (!passwordForm.confirm_password) {
      v.confirmPassword = 'invalid'
    } else {
      v.confirmPassword = passwordForm.new_password === passwordForm.confirm_password ? 'valid' : 'invalid'
    }
  } else {
    v.confirmPassword = ''
  }

  // 当前密码：提交时判断，实时只显示是否为空
  v.oldPassword = passwordForm.old_password ? 'valid' : ''
}

onMounted(async () => {
  try {
    const res = await request.get('/admin/settings', { params: { type: 'account' } })
    if (res.code === 200 && res.data) {
      form.admin_name = res.data.admin_name || ''
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
})

const changePassword = async () => {
  validateForm()
  if (!passwordForm.old_password) {
    v.oldPassword = 'invalid'
    toast.warning('请输入当前密码')
    return
  }
  if (!passwordForm.new_name && !passwordForm.new_password) {
    toast.warning('请填写新用户名或新密码')
    return
  }
  if (passwordForm.new_password && passwordForm.new_password.length < 4) {
    v.newPassword = 'invalid'
    toast.warning('密码长度不能少于4位')
    return
  }
  if (passwordForm.new_password !== passwordForm.confirm_password) {
    v.confirmPassword = 'invalid'
    toast.warning('两次输入的密码不一致')
    return
  }

  changingPassword.value = true
  try {
    const currentName = form.admin_name || adminName.value
    const payload = {
      old_name: currentName,
      old_password: passwordForm.old_password,
      new_name: passwordForm.new_name || currentName,
      new_password: passwordForm.new_password || passwordForm.old_password,
    }
    const res = await request.put('/admin/password', payload)
    if (res.code === 200) {
      toast.success('凭据已更新，请重新登录')
      localStorage.removeItem('token')
      setTimeout(() => router.push('/login'), 1500)
    }
  } catch (e) {
    toast.error(e.message || '密码修改失败')
  } finally {
    changingPassword.value = false
  }
}

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
