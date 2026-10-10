<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">数据管理</h1>
        </div>
      </div>

      <!-- 导出评论数据 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-download text-gray-500"></i> 导出数据
        </h2>
        <p class="text-sm text-gray-500 mb-5">将数据导出为 JSON 文件，可用于备份或迁移。出于安全考虑，SMTP 密码与博主密钥等敏感字段会被置空，导入后需手工补填。</p>
        <div class="flex flex-wrap gap-4">
          <button @click="exportComments" :disabled="exportingComments"
            class="flex items-center gap-2 px-5 py-2.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 disabled:opacity-50 transition-colors text-sm font-medium">
            <i class="fa-solid" :class="exportingComments ? 'fa-spinner fa-spin' : 'fa-comments'"></i>
            {{ exportingComments ? '导出中...' : '导出评论数据' }}
          </button>
          <button @click="exportSettings" :disabled="exportingSettings"
            class="flex items-center gap-2 px-5 py-2.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 disabled:opacity-50 transition-colors text-sm font-medium">
            <i class="fa-solid" :class="exportingSettings ? 'fa-spinner fa-spin' : 'fa-gear'"></i>
            {{ exportingSettings ? '导出中...' : '导出系统设置' }}
          </button>
        </div>
      </section>

      <!-- 导入评论数据 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-upload text-gray-500"></i> 导入数据
        </h2>
        <p class="text-sm text-gray-500 mb-5">导入之前导出的 JSON 文件。导入操作会新增数据，不会覆盖已有数据。</p>

        <div class="flex flex-wrap gap-4 mb-4">
          <label class="flex items-center gap-2 px-5 py-2.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 cursor-pointer transition-colors text-sm font-medium">
            <i class="fa-solid fa-file-import"></i>
            选择评论 JSON 文件
            <input type="file" accept=".json" @change="onFileSelected($event, 'comments')" class="hidden" />
          </label>
          <label class="flex items-center gap-2 px-5 py-2.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 cursor-pointer transition-colors text-sm font-medium">
            <i class="fa-solid fa-file-import"></i>
            选择设置 JSON 文件
            <input type="file" accept=".json" @change="onFileSelected($event, 'settings')" class="hidden" />
          </label>
        </div>

        <div v-if="selectedFile" class="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <i class="fa-solid fa-file text-gray-400 text-xl"></i>
              <div>
                <p class="text-sm font-medium text-gray-700">{{ selectedFile.name }}</p>
                <p class="text-xs text-gray-400">{{ (selectedFile.size / 1024).toFixed(1) }} KB</p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button @click="importData" :disabled="importing"
                class="px-4 py-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-50 transition-colors text-sm font-medium">
                <i class="fa-solid" :class="importing ? 'fa-spinner fa-spin' : 'fa-upload'"></i>
                {{ importing ? '导入中...' : '开始导入' }}
              </button>
              <button @click="clearFile" class="px-3 py-2 text-gray-500 hover:text-gray-700 transition-colors text-sm">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          </div>
          <p class="mt-2 text-xs text-gray-400">
            将要导入: <strong>{{ importType === 'comments' ? '评论数据' : '系统设置' }}</strong>
          </p>
        </div>

        <div v-if="importResult" class="rounded-lg border p-4 text-sm"
          :class="importResult.success ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-600'">
          <div class="flex items-center gap-2">
            <i class="fa-solid" :class="importResult.success ? 'fa-circle-check' : 'fa-circle-xmark'"></i>
            <span>{{ importResult.message }}</span>
          </div>
          <div v-if="importResult.errors?.length" class="mt-2 text-xs text-red-500">
            <p class="font-medium mb-1">错误详情：</p>
            <p v-for="(err, i) in importResult.errors" :key="i" class="ml-2">{{ err }}</p>
          </div>
        </div>
      </section>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import request from '../utils/request'
import toast from '../utils/toast'
import AdminLayout from '../components/AdminLayout.vue'
import { formatLocalDate } from '../utils/time'

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)

const exportingComments = ref(false)
const exportingSettings = ref(false)

const selectedFile = ref(null)
const importType = ref('')
const importing = ref(false)
const importResult = ref(null)

// 导出评论
const exportComments = async () => {
  exportingComments.value = true
  try {
    const res = await request.get('/admin/data/export/comments')
    if (res.code === 200 && res.data) {
      downloadJSON(res.data, `momo-comments-${formatLocalDate(new Date())}.json`)
      toast.success(`成功导出 ${res.data.total || res.data.comments?.length || 0} 条评论`)
    }
  } catch (e) {
    toast.error('导出评论数据失败')
  } finally {
    exportingComments.value = false
  }
}

// 导出系统设置
const exportSettings = async () => {
  exportingSettings.value = true
  try {
    const res = await request.get('/admin/data/export/settings')
    if (res.code === 200 && res.data) {
      downloadJSON(res.data, `momo-settings-${formatLocalDate(new Date())}.json`)
      const omitted = res.data.sensitiveOmitted || []
      if (omitted.length) {
        toast.warning(`敏感字段（${omitted.join('、')}）出于安全考虑已置空，导入后请手工补填`)
      } else {
        toast.success('系统设置导出成功')
      }
    }
  } catch (e) {
    toast.error('导出系统设置失败')
  } finally {
    exportingSettings.value = false
  }
}

// 文件选择
const onFileSelected = (event, type) => {
  const file = event.target.files[0]
  if (!file) return
  selectedFile.value = file
  importType.value = type
  importResult.value = null
}

const clearFile = () => {
  selectedFile.value = null
  importType.value = ''
  importResult.value = null
}

// 导入数据
const importData = async () => {
  if (!selectedFile.value) return

  importing.value = true
  importResult.value = null

  try {
    const text = await selectedFile.value.text()
    const data = JSON.parse(text)

    if (importType.value === 'comments') {
      const payload = { comments: data.comments || data }
      const res = await request.post('/admin/data/import/comments', payload)
      importResult.value = {
        success: res.code === 200,
        message: res.message || '导入完成',
        errors: res.data?.errors,
      }
    } else if (importType.value === 'settings') {
      const settings = data.settings || data
      const res = await request.post('/admin/data/import/settings', settings)
      importResult.value = {
        success: res.code === 200,
        message: res.message || '导入完成',
        errors: null,
      }
    }
  } catch (e) {
    importResult.value = {
      success: false,
      message: e.message || '导入失败，请检查 JSON 文件格式',
      errors: null,
    }
  } finally {
    importing.value = false
  }
}

// 通用下载
const downloadJSON = (data, filename) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
