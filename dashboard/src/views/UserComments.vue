<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="fetchComments(1)">
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- User Info Header -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4 flex items-center justify-between">
        <div class="flex items-center space-x-3">
          <button @click="goBack" class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </button>
          <div>
            <span class="font-semibold text-gray-800">{{ author }}</span>
            <span class="mx-2 text-gray-300">|</span>
            <span class="text-sm text-gray-500">{{ email }}</span>
          </div>
        </div>
      </div>

      <!-- Comments List -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <!-- Mobile: card layout -->
        <div class="md:hidden divide-y divide-gray-100">
          <div v-for="item in comments" :key="item.id" @click="openDetail(item)"
            class="p-4 transition-colors cursor-pointer hover:bg-blue-50/40">
            <div class="space-y-2">
              <div class="flex items-start justify-between">
                <div class="text-xs text-gray-400">
                  <span class="font-mono">{{ item.ipAddress }}</span>
                  <span class="mx-1">·</span>
                  <span>{{ formatDate(item.pubDate) }}</span>
                </div>
                <span :class="statusClass(item.status)" class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex-shrink-0">
                  {{ item.status }}
                </span>
              </div>
              <p class="text-sm line-clamp-2 leading-relaxed break-words text-gray-600">{{ item.contentText }}</p>
              <div class="flex items-center text-[10px] text-gray-400">
                <i class="fa-regular fa-file-lines mr-1"></i>
                <span>{{ item.postSlug }}</span>
              </div>
              <!-- Mobile action buttons -->
              <div class="flex justify-end space-x-2 pt-2 border-t border-gray-100">
                <button v-if="item.status !== 'approved'" @click.stop="updateStatus(item.id, 'approved')"
                  class="w-7 h-7 flex items-center justify-center rounded-lg bg-green-50 text-green-600 hover:bg-green-600 hover:text-white transition-all">
                  <i class="fa-solid fa-check text-xs"></i>
                </button>
                <button v-if="item.status === 'approved'" @click.stop="updateStatus(item.id, 'pending')"
                  class="w-7 h-7 flex items-center justify-center rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all">
                  <i class="fa-solid fa-ban text-xs"></i>
                </button>
                <button @click.stop="updateStatus(item.id, 'deleted')"
                  :class="item.status === 'deleted' ? 'opacity-30 cursor-not-allowed bg-gray-100 text-gray-400' : 'bg-red-50 text-red-600 hover:bg-red-600 hover:text-white'"
                  class="w-7 h-7 flex items-center justify-center rounded-lg transition-all"
                  :disabled="item.status === 'deleted'">
                  <i class="fa-solid fa-trash-can text-xs"></i>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Desktop: table layout -->
        <div class="hidden md:block overflow-x-auto">
          <table class="data-table w-full text-left">
            <thead>
              <tr class="border-b bg-gray-50 border-gray-200">
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">内容</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">文章</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">IP</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">设备</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">时间</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">状态</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-right text-gray-500">管理</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="item in comments" :key="item.id" @click="openDetail(item)"
                class="transition-colors cursor-pointer hover:bg-blue-50/40">
                <td class="px-5 py-3">
                  <p class="text-sm line-clamp-2 whitespace-normal max-w-xs leading-relaxed text-gray-600">{{ item.contentText }}</p>
                </td>
                <td class="px-5 py-3">
                  <span class="block text-xs text-gray-500 max-w-[140px] truncate" :title="item.postSlug">{{ item.postSlug }}</span>
                </td>
                <td class="px-5 py-3 text-xs font-mono text-gray-500">{{ item.ipAddress }}</td>
                <td class="px-5 py-3 text-xs text-gray-500">
                  <span v-if="item.os" class="block max-w-[140px] truncate" :title="item.os">{{ item.os }}</span>
                  <span v-if="item.browser" class="block text-[10px] text-gray-400 max-w-[140px] truncate" :title="item.browser">{{ item.browser }}</span>
                </td>
                <td class="px-5 py-3 text-xs text-gray-500">{{ formatDate(item.pubDate) }}</td>
                <td class="px-5 py-3">
                  <span :class="statusClass(item.status)" class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider">
                    {{ item.status }}
                  </span>
                </td>
                <td class="px-5 py-3 text-right" @click.stop>
                  <div class="flex justify-end space-x-1">
                    <button v-if="item.status !== 'approved'" @click="updateStatus(item.id, 'approved')"
                      class="w-7 h-7 flex items-center justify-center rounded-lg bg-green-50 text-green-600 hover:bg-green-600 hover:text-white transition-all">
                      <i class="fa-solid fa-check text-xs"></i>
                    </button>
                    <button v-if="item.status === 'approved'" @click="updateStatus(item.id, 'pending')"
                      class="w-7 h-7 flex items-center justify-center rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all">
                      <i class="fa-solid fa-ban text-xs"></i>
                    </button>
                    <button @click="updateStatus(item.id, 'deleted')"
                      :class="item.status === 'deleted' ? 'opacity-30 cursor-not-allowed bg-gray-100 text-gray-400' : 'bg-red-50 text-red-600 hover:bg-red-600 hover:text-white'"
                      class="w-7 h-7 flex items-center justify-center rounded-lg transition-all"
                      :disabled="item.status === 'deleted'">
                      <i class="fa-solid fa-trash-can text-xs"></i>
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="comments.length === 0">
                <td colspan="7" class="px-5 py-8 text-center text-sm text-gray-400">该用户暂无评论</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="px-5 py-4 border-t flex items-center justify-between bg-gray-50 border-gray-200">
          <span class="text-xs text-gray-500">共 {{ pagination.totalPage }} 页</span>
          <div class="flex items-center space-x-1">
            <button @click="fetchComments(pagination.page - 1)" :disabled="pagination.page <= 1"
              class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              上一页
            </button>
            <span class="px-4 text-xs font-bold text-gray-700">{{ pagination.page }}</span>
            <button @click="fetchComments(pagination.page + 1)" :disabled="pagination.page >= pagination.totalPage"
              class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              下一页
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Detail Modal -->
    <CommentDetailModal
      :visible="showModal"
      :comment="selectedComment"
      @close="closeModal"
      @update="(id, status) => updateStatus(id, status)"
      @delete="(id) => updateStatus(id, 'deleted')"
      @edit="editComment"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import request from '../utils/request';
import toast from '../utils/toast';
import AdminLayout from '../components/AdminLayout.vue';
import CommentDetailModal from '../components/CommentDetailModal.vue';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);
const author = ref(route.query.author || '');
const email = ref(route.query.email || '');
const comments = ref([]);
const pagination = ref({ page: 1, limit: 10, totalPage: 1 });
const showModal = ref(false);
const selectedComment = ref({});

const fetchComments = async (page = 1) => {
  if (!author.value || !email.value) {
    toast.error('缺少用户信息');
    router.push('/users');
    return;
  }
  loading.value = true;
  try {
    const res = await request.get('/admin/stats/users/comments', {
      params: { author: author.value, email: email.value, page }
    });
    if (res.data) {
      comments.value = res.data.comments || [];
      pagination.value = res.data.pagination || { page: 1, limit: 10, totalPage: 1 };
    }
  } catch (error) {
    toast.error('加载评论失败');
  } finally {
    loading.value = false;
  }
};

const updateStatus = async (id, status) => {
  try {
    await request.put(`/admin/comments/status?id=${id}&status=${status}`);
    toast.success('操作成功');
    fetchComments(pagination.value.page);
  } catch (error) {
    toast.error('更新失败');
  }
};

const editComment = async (payload) => {
  try {
    await request.put('/admin/comments/edit', payload);
    toast.success('修改成功');
    fetchComments(pagination.value.page);
  } catch (error) {
    toast.error('修改失败');
  }
};

const openDetail = (comment) => {
  selectedComment.value = comment;
  showModal.value = true;
};

const closeModal = () => {
  showModal.value = false;
  selectedComment.value = {};
};

const goBack = () => {
  router.push('/users');
};

const formatDate = (str) => {
  if (!str) return '-';
  return new Date(str).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const statusClass = (status) => {
  const map = {
    approved: 'bg-green-100 text-green-700',
    pending: 'bg-amber-100 text-amber-700',
    deleted: 'bg-red-100 text-red-700'
  };
  return map[status] || 'bg-gray-100 text-gray-700';
};

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => fetchComments(1));
</script>
