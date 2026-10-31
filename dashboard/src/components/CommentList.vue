<template>
  <div class="rounded-lg shadow-sm border overflow-hidden bg-white border-gray-200">
    <!-- 批量审核工具栏：有勾选时才出现 -->
    <BatchActionBar v-if="selectedIds.length > 0" :count="selectedIds.length" :loading="batchLoading"
      class="mx-3 mt-3" @clear="clearSelection" @apply="applyBatch" />

    <!-- 移动端：卡片布局 -->
    <div class="md:hidden divide-y divide-gray-100">
      <div v-for="item in data" :key="item.id" @click="openDetail(item)" 
        class="p-4 transition-colors cursor-pointer hover:bg-blue-50/40">
        <div class="space-y-3">
          <!-- 头部：勾选 + 作者 + 状态 -->
          <div class="flex items-start justify-between gap-2">
            <input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择 ${item.author} 的评论`"
              data-test="comment-select" @click.stop @change="toggleRow(item.id)"
              class="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
            <div class="flex-1 min-w-0 space-y-1">
              <a v-if="item.email" :href="userCommentsHref(item)" data-test="comment-author-link"
                :title="`查看 ${item.author} 的全部评论`"
                class="font-bold text-sm block truncate text-gray-800 hover:text-blue-600 hover:underline"
                @click.prevent.stop="$emit('view-user', { author: item.author, email: item.email })">
                {{ item.author }}
              </a>
              <span v-else class="font-bold text-sm block truncate text-gray-800">{{ item.author }}</span>
              <span class="text-xs block truncate text-gray-400">{{ item.email }}</span>
              <span class="text-[10px] font-mono block text-gray-400">{{ item.ipAddress }}</span>
            </div>
            <span :class="statusStyle(item.status)" class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex-shrink-0">
              {{ item.status }}
            </span>
          </div>
          
          <!-- 评论内容 -->
          <div class="border-t pt-3 border-gray-100">
            <p class="text-sm line-clamp-2 leading-relaxed mb-2 break-words text-gray-600">{{ item.contentText }}</p>
            <div class="flex min-w-0 items-center gap-2 text-[10px] text-gray-400">
              <span class="flex shrink-0 items-center">
                <i class="fa-regular fa-clock mr-1"></i>{{ formatDate(item.pubDate) }}
              </span>
              <span v-if="item.postSlug" data-test="comment-post-slug" :title="item.postSlug"
                class="flex min-w-0 items-center truncate">
                <a :href="`/comments?slug=${encodeURIComponent(item.postSlug)}`"
                  class="flex min-w-0 items-center truncate text-left hover:text-blue-600 hover:underline"
                  :title="`按这篇文章筛选：${item.postSlug}`"
                  @click.prevent.stop="$emit('filter-slug', item.postSlug)">
                  <i class="fa-regular fa-file-lines mr-1 shrink-0"></i>
                  <span class="truncate">{{ item.postSlug }}</span>
                </a>
              </span>
            </div>
          </div>
          
          <!-- 操作按钮 -->
          <div class="flex justify-end space-x-2 pt-2 border-t border-gray-100">
            <button v-if="item.status !== 'approved'" @click.stop="$emit('update', item.id, 'approved')" 
              class="w-8 h-8 flex items-center justify-center rounded-lg bg-green-50 text-green-600 hover:bg-green-600 hover:text-white transition-all flex-shrink-0">
              <i class="fa-solid fa-check text-xs"></i>
            </button>
            <button v-if="item.status === 'approved'" @click.stop="$emit('update', item.id, 'pending')" 
              class="w-8 h-8 flex items-center justify-center rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all flex-shrink-0">
              <i class="fa-solid fa-ban text-xs"></i>
            </button>
            <button 
              @click.stop="$emit('update', item.id, 'deleted')" 
              :class="item.status === 'deleted' ? 'opacity-30 cursor-not-allowed bg-gray-100 text-gray-400' : 'bg-red-50 text-red-600 hover:bg-red-600 hover:text-white'"
              class="w-8 h-8 flex items-center justify-center rounded-lg transition-all flex-shrink-0"
              :disabled="item.status === 'deleted'">
              <i class="fa-solid fa-trash-can text-xs"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 桌面端：表格布局 -->
    <div class="hidden md:block overflow-x-auto">
      <table class="data-table w-full text-left">
        <thead>
          <tr class="border-b bg-gray-50 border-gray-200">
            <th class="w-10 px-4 py-4">
              <input type="checkbox" :checked="allSelected" :indeterminate="partiallySelected"
                aria-label="全选当前页评论" data-test="comments-select-all" @change="toggleAll"
                class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
            </th>
            <th class="px-6 py-4 text-xs font-semibold uppercase text-gray-500">作者</th>
            <th class="px-6 py-4 text-xs font-semibold uppercase text-gray-500">评论内容</th>
            <th class="px-6 py-4 text-xs font-semibold uppercase text-gray-500">来源文章</th>
            <th class="px-6 py-4 text-xs font-semibold uppercase text-gray-500">状态</th>
            <th class="px-6 py-4 text-xs font-semibold uppercase text-right text-gray-500">管理</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="item in data" :key="item.id" @click="openDetail(item)" 
            class="transition-colors cursor-pointer hover:bg-blue-50/40">
            <td class="px-4 py-4" @click.stop>
              <input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择 ${item.author} 的评论`"
                data-test="comment-select" @change="toggleRow(item.id)"
                class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
            </td>
            <td class="px-6 py-4">
              <div class="flex flex-col items-start">
                <a v-if="item.email" :href="userCommentsHref(item)" data-test="comment-author-link"
                  :title="`查看 ${item.author} 的全部评论`"
                  class="font-bold text-sm max-w-[180px] truncate text-gray-800 hover:text-blue-600 hover:underline"
                  @click.prevent.stop="$emit('view-user', { author: item.author, email: item.email })">
                  {{ item.author }}
                </a>
                <span v-else class="font-bold text-sm max-w-[180px] truncate text-gray-800">{{ item.author }}</span>
                <span class="text-xs max-w-[180px] truncate text-gray-400">{{ item.email }}</span>
                <span class="text-[10px] mt-1 font-mono text-gray-400">{{ item.ipAddress }}</span>
              </div>
            </td>
            <td class="px-6 py-4">
              <div class="max-w-md">
                <p class="text-sm line-clamp-2 whitespace-normal leading-relaxed text-gray-600">{{ item.contentText }}</p>
                <div class="flex items-center mt-1 space-x-2 text-[10px] text-gray-400">
                  <i class="fa-regular fa-clock"></i>
                  <span>{{ formatDate(item.pubDate) }}</span>
                </div>
              </div>
            </td>
            <td class="px-6 py-4">
              <a v-if="item.postSlug" data-test="comment-post-slug"
                :href="`/comments?slug=${encodeURIComponent(item.postSlug)}`"
                class="block max-w-[180px] truncate text-left text-xs text-gray-500 hover:text-blue-600 hover:underline"
                :title="`按这篇文章筛选：${item.postSlug}`" @click.prevent.stop="$emit('filter-slug', item.postSlug)">
                {{ item.postSlug }}
              </a>
              <span v-else class="text-xs text-gray-300" data-test="comment-post-slug-empty">—</span>
            </td>
            <td class="px-6 py-4">
              <span :class="statusStyle(item.status)" class="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider">
                {{ item.status }}
              </span>
            </td>
            <td class="hidden md:table-cell px-6 py-4 text-right">
              <div class="flex justify-end space-x-2" @click.stop>
                <button v-if="item.status !== 'approved'" @click="$emit('update', item.id, 'approved')" 
                  class="w-8 h-8 flex items-center justify-center rounded-lg bg-green-50 text-green-600 hover:bg-green-600 hover:text-white transition-all">
                  <i class="fa-solid fa-check text-xs"></i>
                </button>
                <button v-if="item.status === 'approved'" @click="$emit('update', item.id, 'pending')" 
                  class="w-8 h-8 flex items-center justify-center rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all">
                  <i class="fa-solid fa-ban text-xs"></i>
                </button>
                <button 
                  @click="$emit('update', item.id, 'deleted')" 
                  :class="item.status === 'deleted' ? 'opacity-30 cursor-not-allowed bg-gray-100 text-gray-400' : 'bg-red-50 text-red-600 hover:bg-red-600 hover:text-white'"
                  class="w-8 h-8 flex items-center justify-center rounded-lg transition-all"
                  :disabled="item.status === 'deleted'">
                  <i class="fa-solid fa-trash-can text-xs"></i>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="px-6 py-4 border-t flex items-center justify-between bg-gray-50 border-gray-200">
      <span class="text-xs text-gray-500">共 {{ pagination.totalPage }} 页数据</span>
      <div class="flex items-center space-x-1">
        <button @click="$emit('page-change', pagination.page - 1)" :disabled="pagination.page <= 1"
          class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
          上一页
        </button>
        <span class="px-4 text-xs font-bold text-gray-700">{{ pagination.page }}</span>
        <button @click="$emit('page-change', pagination.page + 1)" :disabled="pagination.page >= pagination.totalPage"
          class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
          下一页
        </button>
      </div>
    </div>

    <!-- 评论详情弹窗 -->
    <CommentDetailModal
      :visible="showModal"
      :comment="selectedComment"
      @close="closeModal"
      @update="(id, status) => $emit('update', id, status)"
      @delete="(id) => $emit('update', id, 'deleted')"
      @edit="(payload) => $emit('edit', payload)"
      @view-user="(payload) => $emit('view-user', payload)"
    />
  </div>
</template>


<script setup>
import { computed, ref, watch } from 'vue'
import CommentDetailModal from '../components/CommentDetailModal.vue'
import BatchActionBar from './BatchActionBar.vue'

const props = defineProps({
  data: { type: Array, default: () => [] },
  pagination: { type: Object, default: () => ({ page: 1, totalPage: 1 }) },
  /** 批量操作进行中：禁用工具栏按钮 */
  batchLoading: { type: Boolean, default: false },
});
const emit = defineEmits(['update', 'page-change', 'edit', 'batch-update', 'filter-slug', 'view-user']);

const showModal = ref(false)
const selectedComment = ref({})

/* ---------- 批量审核：勾选状态 ---------- */
const selectedIds = ref([])
const visibleIdSet = computed(() => new Set(props.data.map((item) => item.id)))
const isSelected = (id) => selectedIds.value.includes(id)
const allSelected = computed(
  () => props.data.length > 0 && props.data.every((item) => selectedIds.value.includes(item.id))
)
const partiallySelected = computed(() => selectedIds.value.length > 0 && !allSelected.value)

const toggleRow = (id) => {
  selectedIds.value = isSelected(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}
const toggleAll = () => {
  selectedIds.value = allSelected.value ? [] : props.data.map((item) => item.id)
}
const clearSelection = () => {
  selectedIds.value = []
}
/** 批量操作后只保留失败项（父组件刷新完列表后调用），方便原样重试 */
const setSelection = (ids) => {
  selectedIds.value = (ids || []).filter((id) => visibleIdSet.value.has(id))
}
const applyBatch = (status) => {
  if (selectedIds.value.length === 0) return
  // 交给父组件：它负责确认框、请求、toast 与刷新
  emit('batch-update', selectedIds.value.slice(), status)
}

// 翻页 / 换筛选后，已经不存在的 id 自动移出勾选
watch(
  () => props.data,
  () => {
    selectedIds.value = selectedIds.value.filter((id) => visibleIdSet.value.has(id))
  }
)

defineExpose({ clearSelection, setSelection })

const openDetail = (comment) => {
  selectedComment.value = comment
  showModal.value = true
}

const closeModal = () => {
  showModal.value = false
  selectedComment.value = {}
}

const formatDate = (str) => new Date(str).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** 昵称链接：与用户列表「查看评论」共用 /user-comments 页面 */
const userCommentsHref = (item) =>
  `/user-comments?author=${encodeURIComponent(item.author || '')}&email=${encodeURIComponent(item.email || '')}`;

const statusStyle = (status) => {
  const map = {
    approved: 'bg-green-100 text-green-700',
    pending: 'bg-amber-100 text-amber-700',
    deleted: 'bg-red-100 text-red-700'
  };
  return map[status] || 'bg-gray-100 text-gray-700';
}
</script>