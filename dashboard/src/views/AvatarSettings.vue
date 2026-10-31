<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">头像设置</h1>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saved" class="text-sm text-green-600 font-medium">保存成功</span>
          <button @click="saveSettings" :disabled="saving || loading"
            class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
            data-test="save-avatar">
            {{ saving ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- 总开关 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-toggle-on text-rose-500"></i> 启用评论头像
        </h2>
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-700">在评论区显示评论者头像</p>
            <p class="text-xs text-gray-400 mt-1">
              关闭后所有评论统一显示内置默认头像；下面的来源配置会保留，重新开启即恢复。
            </p>
          </div>
          <label class="relative shrink-0 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="enabled" class="sr-only peer" data-test="avatar-enabled">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-rose-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ enabled ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>

        <div v-if="!enabled" class="mt-4 flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3"
          data-test="avatar-default-preview">
          <img :src="DEFAULT_AVATAR_URL" alt="默认头像"
            class="w-12 h-12 rounded-full border border-gray-200 bg-white" />
          <p class="text-xs text-gray-500">
            关闭后公开评论接口对所有评论都下发这张默认头像（内联 SVG，无外部请求）。
            来源与模板配置不会丢失，重新开启后按原配置恢复。
          </p>
        </div>
      </section>

      <!-- 来源选择 -->
      <section v-if="enabled" class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-2 flex items-center gap-2">
          <i class="fa-solid fa-user-circle text-rose-500"></i> 评论头像来源
        </h2>
        <p class="text-xs text-gray-500 mb-4">
          头像由服务端按评论者邮箱生成，<strong>本站不代理也不存储图片</strong>；
          配置在每个请求读取时解析一次，非法配置会回落到内置默认源。完整口径见
          <code class="px-1 bg-gray-100 rounded">doc/avatar.md</code>。
        </p>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3" data-test="avatar-source-list">
          <button v-for="option in AVATAR_SOURCE_OPTIONS" :key="option.value" type="button"
            @click="source = option.value"
            :data-test="`avatar-source-${option.value}`"
            :class="['text-left p-4 rounded-lg border transition-all',
              source === option.value
                ? 'border-rose-400 bg-rose-50/60 ring-2 ring-rose-200'
                : 'border-gray-200 hover:border-rose-200 hover:bg-rose-50/30']">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-semibold text-gray-800">{{ option.label }}</span>
              <span v-if="source === option.value"
                class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-100 text-rose-700">
                <i class="fa-solid fa-check mr-1"></i>已选择
              </span>
            </div>
            <p class="text-xs text-gray-500 mt-1 leading-relaxed">{{ option.hint }}</p>
            <code v-if="AVATAR_TEMPLATES[option.value]"
              class="block mt-2 text-[10px] text-gray-400 break-all">{{ AVATAR_TEMPLATES[option.value] }}</code>
          </button>
        </div>
      </section>

      <!-- 自定义模板 -->
      <section v-if="enabled && isCustom" class="bg-white rounded-lg shadow-sm border border-gray-200 p-6"
        data-test="avatar-custom-section">
        <h2 class="text-lg font-semibold text-gray-800 mb-2 flex items-center gap-2">
          <i class="fa-solid fa-code text-rose-500"></i> 自定义地址模板
        </h2>
        <p class="text-xs text-gray-500 mb-4">
          只允许 <strong>http / https</strong> 地址；可用占位符：
          <code v-for="token in AVATAR_PLACEHOLDERS" :key="token"
            class="ml-1 px-1 bg-gray-100 rounded">{{ token }}</code>。
          含 <code class="px-1 bg-gray-100 rounded">{qq}</code> 但邮箱不是 QQ 邮箱时，该条评论会回落内置默认源。
        </p>

        <div class="flex gap-2">
          <input v-model="customUrl" type="url" data-test="avatar-custom-url"
            placeholder="https://cdn.example.com/avatar/{hash}.png"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-rose-500 focus:border-transparent text-sm font-mono" />
          <button type="button" @click="insertPlaceholder"
            class="px-4 py-2 bg-rose-50 text-rose-700 border border-rose-200 rounded-lg hover:bg-rose-100 transition-colors text-sm font-medium whitespace-nowrap">
            插入占位符
          </button>
        </div>

        <div class="mt-2 flex flex-wrap gap-2">
          <button v-for="token in AVATAR_PLACEHOLDERS" :key="token" type="button"
            @click="customUrl += token" :data-test="`avatar-placeholder-${token.slice(1, -1)}`"
            class="px-2 py-1 text-xs font-mono rounded border border-gray-200 text-gray-600 hover:border-rose-300 hover:text-rose-600 transition-colors">
            {{ token }}
          </button>
        </div>

        <ul class="mt-4 text-xs text-gray-500 space-y-1 list-disc list-inside">
          <li><code class="px-1 bg-gray-100 rounded">{hash}</code>：邮箱（去空格 + 小写）的 MD5，32 位小写十六进制。</li>
          <li><code class="px-1 bg-gray-100 rounded">{email}</code> / <code class="px-1 bg-gray-100 rounded">{author}</code>：会做 percent-encode，不会把原始字符直接拼进 URL。</li>
          <li><code class="px-1 bg-gray-100 rounded">{qq}</code>：仅 <code class="px-1 bg-gray-100 rounded">数字@qq.com</code> 有值。</li>
          <li>不含占位符的固定地址也允许（所有评论者使用同一张图）。</li>
        </ul>

        <div v-if="preview" class="mt-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500"
          data-test="avatar-preview">
          示例：<code class="break-all text-gray-700">{{ preview }}</code>
        </div>
      </section>

      <p v-if="error" class="text-sm text-red-500" data-test="avatar-error">{{ error }}</p>
      <p v-if="loading" class="text-sm text-gray-400">正在加载...</p>
    </div>
  </AdminLayout>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AdminLayout from '../components/AdminLayout.vue';
import request from '../utils/request';
import toast from '../utils/toast';
import {
  AVATAR_PLACEHOLDERS,
  AVATAR_SOURCE_OPTIONS,
  AVATAR_TEMPLATES,
  DEFAULT_AVATAR_URL,
  avatarPreview,
  isAvatarEnabled,
  normalizeAvatarCustomUrl,
  normalizeAvatarSource,
  validateAvatarSettings,
} from '../utils/avatar';

const router = useRouter();
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);

const enabled = ref(true);
const source = ref('default');
const customUrl = ref('');
const loading = ref(false);
const saving = ref(false);
const saved = ref(false);
const error = ref('');

const isCustom = computed(() => source.value === 'custom');
const preview = computed(() =>
  isCustom.value ? avatarPreview(customUrl.value) : avatarPreview(AVATAR_TEMPLATES[source.value] || '')
);

// 输入变化后清掉上一次的错误与「保存成功」
watch([enabled, source, customUrl], () => {
  error.value = '';
  saved.value = false;
});

function insertPlaceholder() {
  customUrl.value += '{hash}';
}

async function loadSettings() {
  loading.value = true;
  try {
    const res = await request.get('/admin/settings', { params: { type: 'avatar' } });
    if (res.code === 200 && res.data) {
      enabled.value = isAvatarEnabled(res.data.avatar_enabled);
      source.value = normalizeAvatarSource(res.data.avatar_source);
      customUrl.value = normalizeAvatarCustomUrl(res.data.avatar_custom_url);
    }
  } catch (e) {
    console.error('Failed to load avatar settings:', e);
  } finally {
    loading.value = false;
    error.value = '';
    saved.value = false;
  }
}

async function saveSettings() {
  const validationError = validateAvatarSettings({
    enabled: enabled.value,
    source: source.value,
    customUrl: customUrl.value,
  });
  if (validationError) {
    error.value = validationError;
    toast.error(validationError);
    return;
  }

  saving.value = true;
  saved.value = false;
  try {
    const res = await request.put('/admin/settings', {
      avatar_enabled: enabled.value ? 'true' : 'false',
      avatar_source: normalizeAvatarSource(source.value),
      avatar_custom_url: normalizeAvatarCustomUrl(customUrl.value),
    });
    if (res.code === 200) {
      saved.value = true;
      toast.success('设置已保存');
      setTimeout(() => {
        saved.value = false;
      }, 3000);
    }
  } catch (e) {
    error.value = e?.message || '保存失败';
  } finally {
    saving.value = false;
  }
}

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => {
  loadSettings();
});
</script>
