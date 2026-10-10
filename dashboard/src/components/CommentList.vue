<template>
  <div class="rounded-lg shadow-sm border overflow-hidden bg-white border-gray-200">
    <!-- 移动端：卡片布局 -->
    <div class="md:hidden divide-y divide-gray-100">
      <div v-for="item in data" :key="item.id" @click="openDetail(item)" 
        class="p-4 transition-colors cursor-pointer hover:bg-blue-50/40">
        <div class="space-y-3">
          <!-- 头部：作者 + 状态 -->
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1 min-w-0 space-y-1">
              <span class="font-bold text-sm block truncate text-gray-800">{{ item.author }}</span>
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
            <div class="flex items-center space-x-2 text-[10px] text-gray-400">
              <i class="fa-regular fa-clock"></i>
              <span>{{ formatDate(item.pubDate) }}</span>
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
            <th class="px-6 py-4 text-xs font-semibold uppercase text-gray-500">作者</th>
            <th class="px-6 py-4 text-xs font-semibold uppercase text-gray-500">评论内容</th>
            <th class="px-6 py-4 text-xs font-semibold uppercase text-gray-500">状态</th>
            <th class="px-6 py-4 text-xs font-semibold uppercase text-right text-gray-500">管理</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="item in data" :key="item.id" @click="openDetail(item)" 
            class="transition-colors cursor-pointer hover:bg-blue-50/40">
            <td class="px-6 py-4">
              <div class="flex flex-col items-start">
                <span class="font-bold text-sm max-w-[180px] truncate text-gray-800">{{ item.author }}</span>
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
    />
  </div>
</template>


<script setup>
import { ref } from 'vue'
import CommentDetailModal from '../components/CommentDetailModal.vue'

defineProps(['data', 'pagination']);
defineEmits(['update', 'page-change', 'edit']);

const showModal = ref(false)
const selectedComment = ref({})

const openDetail = (comment) => {
  selectedComment.value = comment
  showModal.value = true
}

const closeModal = () => {
  showModal.value = false
  selectedComment.value = {}
}

const formatDate = (str) => new Date(str).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const statusStyle = (status) => {
  const map = {
    approved: 'bg-green-100 text-green-700',
    pending: 'bg-amber-100 text-amber-700',
    deleted: 'bg-red-100 text-red-700'
  };
  return map[status] || 'bg-gray-100 text-gray-700';
}
</script>