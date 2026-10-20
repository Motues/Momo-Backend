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
          <i class="fa-solid fa-toggle-on text-violet-500"></i> 启用表情
        </h2>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-medium text-gray-700">在评论区显示表情按钮</p>
            <p class="text-xs text-gray-400 mt-1">关闭后评论区不再显示表情按钮，但下面的地址会保留。</p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="emojiEnabled" class="sr-only peer" data-test="emoji-enabled">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-violet-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">{{ emojiEnabled ? '已开启' : '已关闭' }}</span>
          </label>
        </div>
      </section>

      <!-- 表情来源 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-cloud-arrow-down text-violet-500"></i> 表情来源
        </h2>
        <p class="text-xs text-gray-500 mb-4">
          一组 <strong>OwO 格式</strong>地址（顶层是「标签名 → <code class="px-1 bg-gray-100 rounded">{ type, container }</code>」的对象），
          <strong>最多 5 个</strong>。访客浏览器会按顺序拉取并拼接合并成一个面板，
          <strong>本站不代理也不存储</strong>任何表情内容；格式说明见
          <code class="px-1 bg-gray-100 rounded">doc/emoji.md</code>。
        </p>

        <div class="flex flex-wrap gap-2 mb-2 min-h-[28px]" data-test="emoji-source-list">
          <span v-for="(url, index) in cdnUrls" :key="url"
            class="inline-flex items-center gap-1 px-3 py-1 bg-violet-50 border border-violet-200 text-violet-700 rounded-full text-sm">
            {{ url }}
            <button @click="removeCdnUrl(index)" class="hover:text-red-500 transition-colors leading-none" data-test="emoji-source-remove">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </span>
          <span v-if="cdnUrls.length === 0" class="text-xs text-gray-400 leading-[28px]">未添加表情来源（将使用默认源）</span>
        </div>
        <div class="flex gap-2">
          <input v-model="newCdnUrl" type="url" placeholder="例如：https://open.motues.top/emoji/owo.json"
            @keydown.enter.prevent="addCdnUrl" data-test="emoji-cdn-url"
            class="flex-1 md:max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent text-sm" />
          <button @click="addCdnUrl" :disabled="!newCdnUrl.trim()" data-test="emoji-url-add"
            class="px-4 py-2 bg-violet-50 text-violet-700 border border-violet-200 rounded-lg hover:bg-violet-100 disabled:opacity-50 transition-colors text-sm font-medium whitespace-nowrap">
            添加地址
          </button>
        </div>
        <p v-if="urlInputError" class="mt-1 text-xs text-red-500" data-test="emoji-url-error">{{ urlInputError }}</p>

        <div class="mt-4 flex flex-wrap gap-3">
          <button type="button" @click="resetCdnUrl"
            class="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 whitespace-nowrap"
            data-test="emoji-reset-url">
            恢复默认
          </button>
          <button type="button" @click="checkSource" :disabled="checking"
            class="px-4 py-2 border border-violet-200 rounded-lg text-sm text-violet-700 hover:bg-violet-50 disabled:opacity-50 whitespace-nowrap"
            data-test="emoji-check">
            {{ checking ? '校验中...' : '校验格式' }}
          </button>
        </div>

        <p class="mt-2 text-xs text-gray-400">按回车或点「添加地址」加入列表，点标签上的 × 可删除；最多 5 个来源。</p>

        <p v-if="cdnUrlError" class="mt-2 text-xs text-red-500" data-test="cdn-error">{{ cdnUrlError }}</p>

        <div v-if="checkResult" class="mt-3 rounded-lg border px-3 py-2 text-xs" :class="checkResultClass"
          data-test="emoji-check-result">
          <template v-if="checkResult.status === 'ok'">
            校验通过：{{ checkResult.sources }} 个来源 / {{ checkResult.tabs }} 个标签 / {{ checkResult.items }} 个表情
          </template>
          <template v-else-if="checkResult.status === 'invalid'">
            第 {{ checkResult.index }} 条：{{ checkResult.reason }}
          </template>
          <template v-else>
            第 {{ checkResult.index }} 条无法在线校验（可能被跨域限制拦截），仍可保存<span v-if="checkResult.reason">：{{ checkResult.reason }}</span>
          </template>
        </div>

        <ul class="mt-4 text-xs text-gray-500 space-y-1 list-disc list-inside">
          <li>添加多个来源会按顺序拼接合并：同名标签把后来源的表情追加进去，靠前的来源先占短代码名。</li>
          <li>只取某个标签可写成 <code class="px-1 bg-gray-100 rounded">https://open.motues.top/emoji/owo.json?group=Emoji</code>（只保留 Emoji 标签）。</li>
          <li>地址必须能被访客浏览器直接访问；跨域被拦时仍可保存，但要自行确认地址可用。</li>
          <li>要关闭表情请用上面的开关，不要把列表留空。</li>
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
  addEmojiCdnUrl,
  checkOwoSource,
  normalizeEmojiEnabled,
  resolveEmojiCdnUrls,
  validateCdnUrls,
} from '../utils/emoji';

const router = useRouter();
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);

const emojiEnabled = ref(true);
/** 表情来源列表（最多 5 个，顺序即合并顺序） */
const cdnUrls = ref([DEFAULT_EMOJI_CDN_URL]);
/** 「添加地址」输入框与它的即时错误提示 */
const newCdnUrl = ref('');
const urlInputError = ref('');
const loading = ref(false);
const saving = ref(false);
const saved = ref(false);
const checking = ref(false);
/** 最近一次在线校验结果：null / { status: 'ok' | 'invalid' | 'unreachable', ... } */
const checkResult = ref(null);

/** 列表整体校验（几乎只在「从后端读到的脏数据」时才会命中） */
const cdnUrlError = computed(() => validateCdnUrls(cdnUrls.value));
const checkResultClass = computed(() => {
  if (checkResult.value?.status === 'ok') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (checkResult.value?.status === 'invalid') return 'border-red-200 bg-red-50 text-red-600';
  return 'border-amber-200 bg-amber-50 text-amber-700';
});

// 地址或开关一改，上一次的校验结果就失效
watch([cdnUrls, emojiEnabled], () => {
  checkResult.value = null;
}, { deep: true });

// 重新输入时清掉上一次的「添加」错误提示
watch(newCdnUrl, () => {
  urlInputError.value = '';
});

async function loadSettings() {
  loading.value = true;
  try {
    const res = await request.get('/admin/settings', { params: { type: 'emoji' } });
    if (res.code === 200 && res.data) {
      // 未配置 emoji_cdn_urls 时回落旧键 emoji_cdn_url，两者都为空再回落默认源；
      // 开关 fail-open 为启用（与 doc/emoji.md 3.2 一致）
      cdnUrls.value = resolveEmojiCdnUrls(res.data.emoji_cdn_urls, res.data.emoji_cdn_url);
      emojiEnabled.value = (normalizeEmojiEnabled(res.data.emoji_enabled) || 'true') === 'true';
    }
  } catch (e) {
    console.error('Failed to load emoji settings:', e);
  } finally {
    loading.value = false;
    checkResult.value = null;
    newCdnUrl.value = '';
    urlInputError.value = '';
  }
}

/** 加入一个来源：非法 / 重复 / 超过 5 个都在输入框下就地提示，只有成功才清空输入框 */
function addCdnUrl() {
  const { list, error } = addEmojiCdnUrl(cdnUrls.value, newCdnUrl.value);
  urlInputError.value = error;
  if (error) return;
  if (list === cdnUrls.value) return; // 空输入：什么都没发生
  cdnUrls.value = list;
  newCdnUrl.value = '';
}

/** 删除一个来源（允许删空；空列表保存会被拦下） */
function removeCdnUrl(index) {
  cdnUrls.value.splice(index, 1);
  urlInputError.value = '';
}

/** 恢复默认：只剩一个默认来源 */
function resetCdnUrl() {
  cdnUrls.value = [DEFAULT_EMOJI_CDN_URL];
  urlInputError.value = '';
}

/** 只校验、不保存：逐条拉取地址并检查它们是不是 owo.json 形状 */
async function checkSource() {
  const urls = cdnUrls.value;
  if (urls.length === 0) {
    toast.error('请先填写表情来源地址');
    return;
  }

  const formatError = validateCdnUrls(urls);
  if (formatError) {
    toast.error(formatError);
    return;
  }

  checking.value = true;
  try {
    checkResult.value = await checkOwoSource(urls);
  } finally {
    checking.value = false;
  }
}

async function saveSettings() {
  const urls = cdnUrls.value;

  if (urls.length === 0) {
    toast.error('表情来源不能为空，如需关闭请用上方的启用开关');
    return;
  }

  const formatError = validateCdnUrls(urls);
  if (formatError) {
    toast.error(formatError);
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
      // v3：数组为准；同时写旧键（= 第一个地址）以便旧版本后端/旧快照读到的行为不变
      emoji_cdn_urls: JSON.stringify(urls),
      emoji_cdn_url: urls[0],
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
