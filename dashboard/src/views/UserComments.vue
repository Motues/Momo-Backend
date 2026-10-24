<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="fetchComments(1)">
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- 用户概要卡片：数据来自 /admin/stats/users（按邮箱精确匹配）；老后端/查不到时降级只显示昵称与邮箱 -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4" data-test="user-summary">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex items-start gap-3 min-w-0">
            <button @click="goBack" title="返回用户列表"
              class="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
              <i class="fa-solid fa-arrow-left"></i>
            </button>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-semibold text-gray-800">{{ author }}</span>
                <span v-if="summary?.emailVerified"
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-600 border border-emerald-200">
                  <i class="fa-solid fa-envelope-circle-check mr-1"></i>邮箱已验证
                </span>
                <span v-else-if="summary"
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-200">
                  <i class="fa-solid fa-envelope mr-1"></i>邮箱未验证
                </span>
                <span v-if="summary?.blacklisted"
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-600 border border-red-200">
                  <i class="fa-solid fa-ban mr-1"></i>已拉黑
                </span>
              </div>
              <div class="mt-1 text-sm text-gray-500 break-all">{{ email }}</div>

              <!-- 个人网站链接及其状态（休眠 / 已确认 / 正常 / 无链接） -->
              <div v-if="summary" class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span v-if="linkState === 'unknown'" :title="LINK_UNKNOWN_TITLE" class="text-gray-400">网站信息未知</span>
                <span v-else-if="linkState === 'none'" class="text-gray-400">无个人网站</span>
                <template v-else>
                  <a :href="summary.url" target="_blank" rel="noopener noreferrer"
                    class="text-blue-600 hover:underline break-all">{{ summary.url }}</a>
                  <span v-if="linkState === 'dormant'"
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-200">
                    <i class="fa-solid fa-moon mr-1"></i>休眠
                  </span>
                  <span v-else-if="linkState === 'trusted'" :title="trustTitle(summary)"
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-600 border border-blue-200">
                    <i class="fa-solid fa-shield-halved mr-1"></i>已确认
                  </span>
                  <span v-else
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-600 border border-emerald-200">
                    <i class="fa-solid fa-link mr-1"></i>正常
                  </span>
                </template>
              </div>
            </div>
          </div>

          <div v-if="summary" class="flex flex-wrap items-center gap-2 text-xs">
            <span class="px-2 py-0.5 rounded-full font-medium bg-blue-50 text-blue-700">共 {{ summary.commentCount }} 条</span>
            <span class="px-2 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-600">已通过 {{ summary.approvedCount }}</span>
            <span class="px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-600">待审核 {{ summary.pendingCount }}</span>
            <span class="px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-600">已删除 {{ summary.deletedCount }}</span>
            <span class="text-gray-400">最后评论：{{ formatDate(summary.lastCommentDate) }}</span>
          </div>
        </div>
      </div>

      <!-- 批量审核工具栏 -->
      <BatchActionBar v-if="selectedIds.length > 0" class="mb-4" :count="selectedIds.length" :loading="batchLoading"
        @clear="clearSelection" @apply="applyBatch" />

      <!-- Comments List -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <!-- Mobile: card layout -->
        <div class="md:hidden divide-y divide-gray-100">
          <div v-for="item in comments" :key="item.id" @click="openDetail(item)"
            class="p-4 transition-colors cursor-pointer hover:bg-blue-50/40">
            <div class="space-y-2">
              <div class="flex items-start justify-between gap-2">
                <div class="flex min-w-0 items-start gap-2">
                  <input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择这条评论`"
                    data-test="user-comment-select" @click.stop @change="toggleRow(item.id)"
                    class="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                  <div class="text-xs text-gray-400">
                    <span class="font-mono">{{ item.ipAddress }}</span>
                    <span class="mx-1">·</span>
                    <span>{{ formatDate(item.pubDate) }}</span>
                  </div>
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
                <th class="w-10 px-3 py-3">
                  <input type="checkbox" :checked="allSelected" :indeterminate="partiallySelected"
                    aria-label="全选当前页评论" data-test="user-comments-select-all" @change="toggleAll"
                    class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                </th>
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
                <td class="px-3 py-3" @click.stop>
                  <input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择这条评论`"
                    data-test="user-comment-select" @change="toggleRow(item.id)"
                    class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                </td>
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
                <td colspan="8" class="px-5 py-8 text-center text-sm text-gray-400">该用户暂无评论</td>
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
import { computed, ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import request from '../utils/request';
import toast from '../utils/toast';
import AdminLayout from '../components/AdminLayout.vue';
import CommentDetailModal from '../components/CommentDetailModal.vue';
import BatchActionBar from '../components/BatchActionBar.vue';
import { LINK_UNKNOWN_TITLE, linkStatus, trustTitle } from '../utils/userLink';
import {
  BATCH_CASCADE_STATUSES,
  BATCH_STATUS_LABELS,
  updateCommentsStatus,
} from '../utils/batchModeration';

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
/** 用户概要（评论数 / 验证状态 / 链接状态 / 黑名单）：来自用户列表接口 */
const summary = ref(null);
const batchLoading = ref(false);
const selectedIds = ref([]);

const linkState = computed(() => linkStatus(summary.value));

const visibleIdSet = computed(() => new Set(comments.value.map((item) => item.id)));
const isSelected = (id) => selectedIds.value.includes(id);
const allSelected = computed(
  () => comments.value.length > 0 && comments.value.every((item) => selectedIds.value.includes(item.id))
);
const partiallySelected = computed(() => selectedIds.value.length > 0 && !allSelected.value);
const toggleRow = (id) => {
  selectedIds.value = isSelected(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id];
};
const toggleAll = () => {
  selectedIds.value = allSelected.value ? [] : comments.value.map((item) => item.id);
};
const clearSelection = () => {
  selectedIds.value = [];
};

/**
 * 拉取用户概要：用户列表接口支持按昵称/邮箱搜索，这里按邮箱**精确匹配**当前用户。
 * 老后端没有该接口或列表里找不到时保持 null，页面降级为只显示昵称/邮箱。
 */
const fetchUserSummary = async () => {
  if (!email.value) return;
  try {
    const res = await request.get('/admin/stats/users', {
      params: { search: email.value, page: 1, limit: 20 }
    });
    const list = res.data?.users || [];
    summary.value =
      list.find((user) => String(user.email || '').toLowerCase() === email.value.toLowerCase()) || null;
  } catch (error) {
    summary.value = null;
  }
};

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

const refresh = (page = pagination.value.page) => {
  fetchComments(page);
  fetchUserSummary();
};

const updateStatus = async (id, status) => {
  try {
    await request.put(`/admin/comments/status?id=${id}&status=${status}`);
    toast.success('操作成功');
    refresh();
  } catch (error) {
    toast.error('更新失败');
  }
};

/**
 * 批量审核：与主评论页一致，逐条复用单条状态接口（有限并发），失败项保留勾选。
 */
const handleBatchUpdate = async (ids, status) => {
  if (!ids || ids.length === 0) return;
  const label = BATCH_STATUS_LABELS[status] || status;
  const cascadeTip = BATCH_CASCADE_STATUSES.includes(status)
    ? `\n\n注意：${label}会连同这些评论下的所有回复一起生效。`
    : '';
  if (!window.confirm(`确定批量${label}选中的 ${ids.length} 条评论吗？${cascadeTip}`)) return;

  batchLoading.value = true;
  try {
    const result = await updateCommentsStatus(ids, status);
    if (result.succeeded > 0) {
      const failedTip = result.failed.length > 0 ? `，${result.failed.length} 条失败` : '';
      toast.success(`已${label} ${result.succeeded} 条${failedTip}`);
    } else {
      toast.error(`批量${label}失败，请重试`);
    }
    await fetchComments(pagination.value.page);
    fetchUserSummary();
    selectedIds.value = result.failedIds.filter((id) => visibleIdSet.value.has(id));
  } finally {
    batchLoading.value = false;
  }
};

const applyBatch = (status) => handleBatchUpdate(selectedIds.value.slice(), status);

const editComment = async (payload) => {
  try {
    await request.put('/admin/comments/edit', payload);
    toast.success('修改成功');
    refresh();
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

onMounted(() => {
  fetchComments(1);
  fetchUserSummary();
});
</script>
