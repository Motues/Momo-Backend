<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" @click="cancelEdit"></div>

    <div class="relative bg-white rounded-lg shadow-xl w-full max-w-2xl mx-auto max-h-[85vh] overflow-hidden flex flex-col border border-slate-200">

      <div class="sticky top-0 bg-white border-b border-slate-100 px-5 py-4 flex items-center justify-between flex-shrink-0">
        <h3 class="text-sm md:text-base font-semibold text-slate-800 flex items-center tracking-tight">
          <i class="fa-solid fa-message mr-2 text-slate-400"></i>
          {{ editing ? '编辑评论' : '评论详情' }}
        </h3>
        <div class="flex items-center space-x-1">
          <button v-if="!editing" @click="startEdit" title="编辑"
            class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <i class="fa-solid fa-pen-to-square text-sm"></i>
          </button>
          <button @click="cancelEdit" class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 text-slate-400 transition-colors">
            <i class="fa-solid fa-xmark text-base"></i>
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-5 md:p-6 space-y-8 custom-scrollbar">

        <section class="space-y-4">
          <div class="flex items-center space-x-3">
            <img v-if="comment.avatar" :src="comment.avatar" class="w-10 h-10 rounded-md object-cover border border-slate-100" alt="avatar" />
            <div class="min-w-0 flex-1">
              <template v-if="!editing">
                <div class="text-sm font-bold text-slate-900">{{ comment.author }}</div>
                <div class="text-xs text-slate-400 truncate">{{ comment.email || '无邮箱' }}</div>
              </template>
              <template v-else>
                <input v-model="form.author" placeholder="作者昵称"
                  class="w-full px-2 py-1 text-sm border border-slate-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
                <input v-model="form.email" placeholder="邮箱地址" type="email"
                  class="w-full px-2 py-1 mt-1 text-sm border border-slate-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
              </template>
            </div>
          </div>

          <div class="bg-slate-50 rounded-md p-4 border border-slate-100">
            <template v-if="!editing">
              <p class="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap break-words">
                "{{ comment.contentText }}"
              </p>
            </template>
            <template v-else>
              <textarea v-model="form.content_text" rows="4" placeholder="评论内容"
                class="w-full px-2 py-1 text-sm border border-slate-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"></textarea>
            </template>
          </div>
        </section>

        <section class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <div class="border-b border-slate-50 pb-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">来源文章</span>
            <span class="text-slate-700 font-medium truncate block text-xs">{{ comment.postSlug || '未知' }}</span>
          </div>

          <div class="border-b border-slate-50 pb-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">IP 地址</span>
            <span class="text-slate-600 font-mono text-xs">{{ comment.ipAddress || '-' }}</span>
          </div>

          <div class="border-b border-slate-50 pb-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">操作系统 / 浏览器</span>
            <span class="text-slate-600 text-xs">{{ comment.os || 'Unknown' }} / {{ comment.browser || 'Unknown' }}</span>
          </div>

          <div class="border-b border-slate-50 pb-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">发布时间</span>
            <span class="text-slate-600 text-xs">{{ formatDate(comment.pubDate) }}</span>
          </div>
        </section>

        <section class="space-y-2">
          <h4 class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">作者链接</h4>
          <div class="text-xs">
            <template v-if="!editing">
              <div v-if="safeCommentUrl" class="flex items-center text-blue-500/80 hover:text-blue-600 transition-colors">
                <i class="fa-solid fa-link mr-2 scale-75"></i>
                <a :href="safeCommentUrl" target="_blank" rel="noopener noreferrer" class="truncate underline underline-offset-2">{{ comment.url }}</a>
              </div>
              <span v-else-if="comment.url" class="text-slate-400 break-all">{{ comment.url }}（链接协议不受支持，已禁止点击）</span>
              <span v-else class="text-slate-400">无</span>
            </template>
            <template v-else>
              <input v-model="form.url" placeholder="个人网站 URL" type="url"
                class="w-full px-2 py-1 text-sm border border-slate-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
            </template>
          </div>
        </section>
      </div>

      <div class="sticky bottom-0 bg-slate-50/80 backdrop-blur-md px-5 py-4 border-t border-slate-100 flex-shrink-0">
        <div class="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div class="flex items-center">
            <span :class="statusStyle(comment.status)" class="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-tighter">
              {{ comment.status }}
            </span>
            <span class="ml-3 text-[11px] font-mono text-slate-400">ID: {{ comment.id }}</span>
          </div>

          <div class="flex justify-end space-x-2">
            <template v-if="!editing">
              <button v-if="comment.status !== 'approved'" @click="$emit('update', comment.id, 'approved')"
                class="w-8 h-8 flex items-center justify-center rounded-lg bg-green-50 text-green-600 hover:bg-green-600 hover:text-white transition-all shadow-sm">
                <i class="fa-solid fa-check text-xs"></i>
              </button>
              <button v-if="comment.status === 'approved'" @click="$emit('update', comment.id, 'pending')"
                class="w-8 h-8 flex items-center justify-center rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all shadow-sm">
                <i class="fa-solid fa-ban text-xs"></i>
              </button>
              <button
                @click="$emit('delete', comment.id)"
                :class="comment.status === 'deleted' ? 'opacity-30 cursor-not-allowed bg-gray-100 text-gray-400' : 'bg-red-50 text-red-600 hover:bg-red-600 hover:text-white shadow-sm'"
                class="w-8 h-8 flex items-center justify-center rounded-lg transition-all"
                :disabled="comment.status === 'deleted'">
                <i class="fa-solid fa-trash-can text-xs"></i>
              </button>
            </template>
            <template v-else>
              <button @click="cancelEdit"
                class="px-3 py-1 text-xs font-medium rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-100 transition-colors">
                取消
              </button>
              <button @click="saveEdit"
                class="px-3 py-1 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors shadow-sm">
                保存
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, watch, computed } from 'vue';

const props = defineProps({
  visible: Boolean,
  comment: {
    type: Object,
    default: () => ({})
  }
});

const emit = defineEmits(['close', 'update', 'delete', 'edit']);

const editing = ref(false);
const form = reactive({
  author: '',
  email: '',
  content_text: '',
  url: ''
});

watch(() => props.visible, (v) => {
  if (v) {
    editing.value = false;
    resetForm();
  }
});

const resetForm = () => {
  form.author = props.comment.author || '';
  form.email = props.comment.email || '';
  form.content_text = props.comment.contentText || '';
  form.url = props.comment.url || '';
};

const startEdit = () => {
  resetForm();
  editing.value = true;
};

const cancelEdit = () => {
  if (editing.value) {
    editing.value = false;
    resetForm();
  } else {
    emit('close');
  }
};

const saveEdit = () => {
  const payload = { id: props.comment.id };
  if (form.author !== (props.comment.author || '')) payload.author = form.author;
  if (form.email !== (props.comment.email || '')) payload.email = form.email;
  if (form.content_text !== (props.comment.contentText || '')) payload.content_text = form.content_text;
  if (form.url !== (props.comment.url || '')) payload.url = form.url;

  if (Object.keys(payload).length <= 1) {
    editing.value = false;
    return;
  }

  emit('edit', payload);
  editing.value = false;
};

const formatDate = (str) => {
  if (!str) return '未知';
  return new Date(str).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const statusStyle = (status) => {
  const map = {
    approved: 'bg-green-100 text-green-700',
    pending: 'bg-amber-100 text-amber-700',
    deleted: 'bg-red-100 text-red-700'
  };
  return map[status] || 'bg-gray-100 text-gray-700';
}

/**
 * 渲染前校验作者链接的协议：仅放行 http/https/mailto（含相对路径）。
 * 历史数据里的 javascript: 链接若被点击会在后台源执行脚本并窃取 token。
 */
const safeCommentUrl = computed(() => {
  const value = props.comment?.url;
  if (!value || typeof value !== 'string') return '';
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return value;
    }
    return '';
  } catch {
    return '';
  }
});
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #e2e8f0;
  border-radius: 2px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #cbd5e1;
}
.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: #e2e8f0 transparent;
}
</style>
