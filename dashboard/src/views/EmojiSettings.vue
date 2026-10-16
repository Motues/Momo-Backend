<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">表情设置</h1>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saved" class="text-sm text-green-600 font-medium">保存成功</span>
          <button @click="saveSettings" :disabled="saving || loading"
            class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
            data-test="save-emoji">
            {{ saving ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- 启用开关 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-toggle-on text-emerald-500"></i> 启用表情
        </h2>
        <label class="inline-flex items-start gap-3 cursor-pointer">
          <input type="checkbox" v-model="emojiEnabled"
            class="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            data-test="emoji-enabled" />
          <span class="text-sm text-gray-700">
            在评论区显示表情按钮
            <span class="block text-xs text-gray-500 mt-1">
              关闭后评论区不再显示表情按钮，但下面的地址会保留。
            </span>
          </span>
        </label>
      </section>

      <!-- 表情来源 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-cloud-arrow-down text-blue-500"></i> 表情来源
        </h2>
        <p class="text-xs text-gray-500 mb-4">
          一个 <strong>OwO 格式</strong>地址（顶层是「标签名 → <code class="px-1 bg-gray-100 rounded">{ type, container }</code>」的对象）。
          由访客浏览器直接拉取，<strong>本站不代理也不存储</strong>任何表情内容；格式说明见
          <code class="px-1 bg-gray-100 rounded">doc/emoji.md</code>。
        </p>

        <div class="flex flex-col md:flex-row gap-3">
          <input v-model="cdnUrl" type="url" :placeholder="DEFAULT_EMOJI_CDN_URL"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            data-test="emoji-cdn-url" />
          <button type="button" @click="resetCdnUrl"
            class="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 whitespace-nowrap"
            data-test="emoji-reset-url">
            恢复默认
          </button>
          <button type="button" @click="checkSource" :disabled="checking"
            class="px-4 py-2 border border-blue-200 rounded-lg text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50 whitespace-nowrap"
            data-test="emoji-check">
            {{ checking ? '校验中...' : '校验格式' }}
          </button>
        </div>

        <p v-if="cdnUrlError" class="mt-2 text-xs text-red-500" data-test="cdn-error">{{ cdnUrlError }}</p>

        <div v-if="checkResult" class="mt-3 rounded-lg border px-3 py-2 text-xs" :class="checkResultClass"
          data-test="emoji-check-result">
          <template v-if="checkResult.status === 'ok'">
            校验通过：{{ checkResult.tabs }} 个标签 / {{ checkResult.items }} 个表情
          </template>
          <template v-else-if="checkResult.status === 'invalid'">{{ checkResult.reason }}</template>
          <template v-else>
            无法在线校验（可能被跨域限制拦截），仍可保存<span v-if="checkResult.reason">：{{ checkResult.reason }}</span>
          </template>
        </div>

        <ul class="mt-4 text-xs text-gray-500 space-y-1 list-disc list-inside">
          <li>地址必须能被访客浏览器直接访问；跨域被拦时仍可保存，但要自行确认地址可用。</li>
          <li>只取某个标签：<code class="px-1 bg-gray-100 rounded">https://open.motues.top/emoji/owo.json?group=Emoji</code>（只保留 Emoji 标签）。</li>
          <li>需要关闭表情时请用上方的启用开关，不要把地址留空。</li>
        </ul>
      </section>

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
  DEFAULT_EMOJI_CDN_URL,
  checkOwoSource,
  normalizeEmojiEnabled,
  validateCdnUrl,
} from '../utils/emoji';

const router = useRouter();
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);

const emojiEnabled = ref(true);
const cdnUrl = ref(DEFAULT_EMOJI_CDN_URL);
const loading = ref(false);
const saving = ref(false);
const saved = ref(false);
const checking = ref(false);
/** 最近一次在线校验结果：null / { status: 'ok' | 'invalid' | 'unreachable', ... } */
const checkResult = ref(null);

const cdnUrlError = computed(() => validateCdnUrl(cdnUrl.value));
const checkResultClass = computed(() => {
  if (checkResult.value?.status === 'ok') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (checkResult.value?.status === 'invalid') return 'border-red-200 bg-red-50 text-red-600';
  return 'border-amber-200 bg-amber-50 text-amber-700';
});

// 地址或开关一改，上一次的校验结果就失效了
watch([cdnUrl, emojiEnabled], () => {
  checkResult.value = null;
});

async function loadSettings() {
  loading.value = true;
  try {
    const res = await request.get('/admin/settings', { params: { type: 'emoji' } });
    if (res.code === 200 && res.data) {
      // 未配置过的键不会下发：地址回落默认源，开关 fail-open 为启用（与 doc/emoji.md 3.2 一致）
      const storedUrl = String(res.data.emoji_cdn_url ?? '').trim();
      cdnUrl.value = storedUrl === '' ? DEFAULT_EMOJI_CDN_URL : storedUrl;
      emojiEnabled.value = (normalizeEmojiEnabled(res.data.emoji_enabled) || 'true') === 'true';
    }
  } catch (e) {
    console.error('Failed to load emoji settings:', e);
  } finally {
    loading.value = false;
    checkResult.value = null;
  }
}

function resetCdnUrl() {
  cdnUrl.value = DEFAULT_EMOJI_CDN_URL;
}

/** 只校验、不保存：拉取地址并检查它是不是 owo.json 形状 */
async function checkSource() {
  const url = cdnUrl.value.trim();
  if (url === '') {
    toast.error('请先填写表情来源地址');
    return;
  }

  checking.value = true;
  try {
    checkResult.value = await checkOwoSource(url);
  } finally {
    checking.value = false;
  }
}

async function saveSettings() {
  const url = cdnUrl.value.trim();

  const urlError = validateCdnUrl(url);
  if (urlError) {
    toast.error(urlError);
    return;
  }
  if (url === '') {
    toast.error('表情来源不能为空，如需关闭请用上方的启用开关');
    return;
  }
  if (checkResult.value?.status === 'invalid') {
    toast.error(checkResult.value.reason || '该地址不是 owo.json');
    return;
  }

  saving.value = true;
  saved.value = false;
  try {
    const res = await request.put('/admin/settings', {
      emoji_enabled: normalizeEmojiEnabled(emojiEnabled.value) || 'true',
      emoji_cdn_url: url,
    });
    if (res.code === 200) {
      saved.value = true;
      toast.success('设置已保存');
      setTimeout(() => {
        saved.value = false;
      }, 3000);
    }
  } catch (e) {
    console.error('Failed to save emoji settings:', e);
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
