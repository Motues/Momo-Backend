<template>
  <AdminLayout
    :baseUrl="apiUrl"
    @logout="logout"
    @refresh="fetchComments(pagination.page)"
  >
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- Status filter tabs + 文章筛选（从数据统计页「热门文章 / 最新动态」跳转而来） -->
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <button v-for="tab in statusTabs" :key="tab.value"
          @click="switchFilter(tab.value)"
          :class="['px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
            currentStatus === tab.value
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50']">
          {{ tab.label }}
        </button>
        <span v-if="currentSlug"
          class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100 text-blue-700 text-xs">
          <i class="fa-solid fa-file-lines"></i>
          <span class="font-mono truncate max-w-[240px]" :title="currentSlug">{{ currentSlug }}</span>
          <button @click="clearSlugFilter" class="text-blue-500 hover:text-blue-700" title="清除文章筛选">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </span>
      </div>

      <CommentList
        ref="commentListRef"
        :data="tableData"
        :pagination="pagination"
        :batch-loading="batchLoading"
        @page-change="handlePageChange"
        @update="updateStatus"
        @edit="editComment"
        @batch-update="handleBatchUpdate"
        @filter-slug="applySlugFilter"
        @view-user="viewUserComments"
      />
    </template>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import request from '../utils/request';
import toast from '../utils/toast';
import AdminLayout from '../components/AdminLayout.vue';
import CommentList from '../components/CommentList.vue';
import {
  BATCH_CASCADE_STATUSES,
  BATCH_STATUS_LABELS,
  updateCommentsStatus,
} from '../utils/batchModeration';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const tableData = ref([]);
const pagination = ref({ page: 1, limit: 10, totalPage: 1 });
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);
const currentStatus = ref('');
/** 按文章标识精确筛选（数据统计页跳转带上 `?slug=`），空串表示不筛选 */
const currentSlug = ref('');
const batchLoading = ref(false);
const commentListRef = ref(null);

const statusTabs = [
  { label: '全部', value: '' },
  { label: '已通过', value: 'approved' },
  { label: '待审核', value: 'pending' },
  { label: '已删除', value: 'deleted' }
];

const fetchComments = async (page = 1) => {
  loading.value = true;
  try {
    const params = { page };
    if (currentStatus.value) {
      params.status = currentStatus.value;
    }
    if (currentSlug.value) {
      params.postSlug = currentSlug.value;
    }
    const res = await request.get('/admin/comments/list', { params });
    if (res.data) {
      tableData.value = res.data.comments || [];
      pagination.value = res.data.pagination || { page: 1, limit: 10, totalPage: 1 };
    }
  } catch (error) {
    toast.error('加载失败');
  } finally {
    loading.value = false;
  }
};

const switchFilter = (status) => {
  currentStatus.value = status;
  pagination.value.page = 1;
  fetchComments(1);
};

/**
 * 点表格里的「来源文章」按该文章筛选：
 * 与统计页跳转过来的 `?slug=` 走同一条路径（地址栏保留，可直接分享/刷新）。
 */
const applySlugFilter = (slug) => {
  const value = String(slug || '').trim();
  if (!value) return;
  currentSlug.value = value;
  pagination.value.page = 1;
  const query = { ...(currentStatus.value ? { status: currentStatus.value } : {}), slug: value };
  router.replace({ path: '/comments', query });
  fetchComments(1);
};

/** 清除文章筛选：地址栏与列表一起回到「全部文章」 */
const clearSlugFilter = () => {
  currentSlug.value = '';
  const query = currentStatus.value ? { status: currentStatus.value } : {};
  router.replace({ path: '/comments', query });
  fetchComments(1);
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

/**
 * 批量审核：确认后逐条调用既有单条接口（有限并发），再刷新当前页。
 * 失败项保留勾选，方便直接重试；`deleted` / `pending` 会级联到子孙回复，确认框里明确提示。
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
    // 刷新时列表被 loading 占位替换过，等新列表挂载后再回填「失败项」
    await nextTick();
    commentListRef.value?.setSelection(result.failedIds);
  } finally {
    batchLoading.value = false;
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

const handlePageChange = (p) => fetchComments(p);

/**
 * 点击评论昵称进入该用户的评论页：与用户列表「查看评论」共用 /user-comments，
 * 详情弹窗也走同一条路径。缺少邮箱时不跳转（用户页以邮箱作为身份凭据）。
 */
const viewUserComments = ({ author, email } = {}) => {
  if (!author || !email) return;
  router.push({
    path: '/user-comments',
    query: { author, email }
  });
};

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => {
  // 从 URL 查询参数读取初始 status 筛选
  const statusParam = route.query.status;
  if (statusParam && ['approved', 'pending', 'deleted'].includes(statusParam)) {
    currentStatus.value = statusParam;
  }
  // 数据统计页「热门文章 / 最新动态」点击后带过来的文章标识
  const slugParam = route.query.slug;
  if (typeof slugParam === 'string' && slugParam.trim()) {
    currentSlug.value = slugParam.trim();
  }
  fetchComments(1);
});
</script>
