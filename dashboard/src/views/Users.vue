<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="fetchUsers(1)">
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <!-- Search bar -->
        <div class="px-5 py-4 border-b border-gray-200 bg-gray-50/50 flex flex-col sm:flex-row sm:items-center gap-3">
          <div class="flex items-center gap-2 flex-1">
            <div class="relative flex-1 max-w-md">
              <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
              <input v-model="searchKeyword" type="text" placeholder="搜索昵称或邮箱"
                class="w-full pl-9 pr-8 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                @keydown.enter="handleSearch" />
              <button v-if="searchKeyword" @click="clearSearch" title="清空搜索"
                class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <button @click="handleSearch"
              class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">
              搜索
            </button>
            <SelectMenu v-model="verifiedFilter" class="shrink-0" accent="blue" title="按邮箱验证状态筛选"
              :options="[
                { label: '全部用户', value: 'all' },
                { label: '邮箱已验证', value: 'true' },
                { label: '邮箱未验证', value: 'false' },
              ]"
              @change="handleFilterChange" />
          </div>
          <span v-if="searchKeyword.trim()" class="text-xs text-gray-500 whitespace-nowrap">
            搜索：<strong class="text-blue-600">{{ searchKeyword.trim() }}</strong>
          </span>
        </div>

        <!-- Mobile: card layout -->
        <div class="md:hidden divide-y divide-gray-100">
          <div v-for="user in users" :key="user.author + user.email" class="p-4">
            <div class="space-y-3">
              <div class="flex items-start justify-between gap-2">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-sm truncate text-gray-800">{{ user.author }}</span>
                    <span v-if="user.blacklisted"
                      class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-600 border border-red-200 whitespace-nowrap">
                      <i class="fa-solid fa-ban mr-1"></i>已拉黑
                    </span>
                    <span v-if="user.emailVerified"
                      class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-600 border border-emerald-200 whitespace-nowrap">
                      <i class="fa-solid fa-envelope-circle-check mr-1"></i>邮箱已验证
                    </span>
                    <span v-else
                      class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-200 whitespace-nowrap">
                      <i class="fa-solid fa-envelope mr-1"></i>邮箱未验证
                    </span>
                  </div>
                  <span class="text-xs block truncate text-gray-400">{{ user.email }}</span>
                </div>
                <div class="flex flex-col gap-1.5 flex-shrink-0">
                  <button @click="viewUserComments(user)"
                    class="px-3 py-1 text-xs font-medium rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white transition-all">
                    查看评论
                  </button>
                  <button v-if="user.blacklisted" @click="removeFromBlacklist(user)"
                    class="px-3 py-1 text-xs font-medium rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all">
                    取消拉黑
                  </button>
                  <button v-else @click="addToBlacklist(user)"
                    class="px-3 py-1 text-xs font-medium rounded-lg bg-red-50 text-red-600 hover:bg-red-600 hover:text-white transition-all">
                    拉黑
                  </button>
                </div>
              </div>
              <div class="border-t pt-3 border-gray-100">
                <div class="flex items-center space-x-3 text-sm">
                  <span class="text-gray-500">共 <strong class="text-blue-600">{{ user.commentCount }}</strong> 条</span>
                  <span v-if="user.approvedCount > 0" class="text-green-600">✓ {{ user.approvedCount }}</span>
                  <span v-if="user.pendingCount > 0" class="text-amber-600">⏳ {{ user.pendingCount }}</span>
                  <span v-if="user.deletedCount > 0" class="text-red-600">✗ {{ user.deletedCount }}</span>
                </div>
              </div>
              <div class="text-[10px] text-gray-400">
                最后评论：{{ formatDate(user.lastCommentDate) }}
              </div>
            </div>
          </div>
          <div v-if="users.length === 0" class="px-5 py-8 text-center text-sm text-gray-400">
            {{ searchKeyword.trim() || verifiedFilter !== 'all' ? '未找到匹配的用户' : '暂无用户数据' }}
          </div>
        </div>

        <!-- Desktop: table layout -->
        <div class="hidden md:block overflow-x-auto">
          <table class="data-table w-full text-left">
            <thead>
              <tr class="border-b bg-gray-50 border-gray-200">
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">作者</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">邮箱</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">邮箱验证</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">评论数</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">已通过</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">待审核</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">已删除</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">最后评论</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-right text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="user in users" :key="user.author + user.email" class="hover:bg-gray-50 transition-colors">
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-gray-800 max-w-[160px] truncate">{{ user.author }}</span>
                    <span v-if="user.blacklisted"
                      class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-600 border border-red-200 whitespace-nowrap">
                      <i class="fa-solid fa-ban mr-1"></i>已拉黑
                    </span>
                  </div>
                </td>
                <td class="px-4 py-3">
                  <span class="block text-sm text-gray-500 max-w-[220px] truncate" :title="user.email">{{ user.email }}</span>
                </td>
                <td class="px-4 py-3">
                  <span v-if="user.emailVerified"
                    :title="user.emailVerifiedAt ? '验证时间：' + formatDateTime(user.emailVerifiedAt) : '已通过邮箱验证'"
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-600 border border-emerald-200">
                    <i class="fa-solid fa-envelope-circle-check mr-1"></i>已验证
                  </span>
                  <span v-else class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                    <i class="fa-solid fa-envelope mr-1"></i>未验证
                  </span>
                </td>
                <td class="px-4 py-3">
                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">{{ user.commentCount }}</span>
                </td>
                <td class="px-4 py-3 text-sm text-green-600">{{ user.approvedCount }}</td>
                <td class="px-4 py-3 text-sm text-amber-600">{{ user.pendingCount }}</td>
                <td class="px-4 py-3 text-sm text-red-600">{{ user.deletedCount }}</td>
                <td class="px-4 py-3 text-sm text-gray-500">{{ formatDate(user.lastCommentDate) }}</td>
                <td class="px-4 py-3 text-right whitespace-nowrap">
                  <div class="flex items-center justify-end gap-2">
                    <button @click="viewUserComments(user)"
                      class="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white transition-all">
                      查看评论
                    </button>
                    <button v-if="user.blacklisted" @click="removeFromBlacklist(user)"
                      class="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all">
                      取消拉黑
                    </button>
                    <button v-else @click="addToBlacklist(user)"
                      class="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-50 text-red-600 hover:bg-red-600 hover:text-white transition-all">
                      拉黑
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="users.length === 0">
                <td colspan="9" class="px-5 py-8 text-center text-sm text-gray-400">
                  {{ searchKeyword.trim() || verifiedFilter !== 'all' ? '未找到匹配的用户' : '暂无用户数据' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="px-5 py-4 border-t flex items-center justify-between bg-gray-50 border-gray-200">
          <span class="text-xs text-gray-500">共 {{ pagination.totalPage }} 页</span>
          <div class="flex items-center space-x-1">
            <button @click="fetchUsers(pagination.page - 1)" :disabled="pagination.page <= 1"
              class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              上一页
            </button>
            <span class="px-4 text-xs font-bold text-gray-700">{{ pagination.page }}</span>
            <button @click="fetchUsers(pagination.page + 1)" :disabled="pagination.page >= pagination.totalPage"
              class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              下一页
            </button>
          </div>
        </div>
      </div>
    </template>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import request from '../utils/request';
import toast from '../utils/toast';
import AdminLayout from '../components/AdminLayout.vue';
import SelectMenu from '../components/SelectMenu.vue';

const router = useRouter();
const loading = ref(false);
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);
const users = ref([]);
const pagination = ref({ page: 1, limit: 20, totalPage: 1 });
const searchKeyword = ref('');
// 邮箱验证筛选：all / true（已验证）/ false（未验证）
const verifiedFilter = ref('all');

const fetchUsers = async (page = 1) => {
  loading.value = true;
  try {
    const params = { page, limit: 20 };
    const keyword = searchKeyword.value.trim();
    if (keyword) params.search = keyword;
    if (verifiedFilter.value !== 'all') params.verified = verifiedFilter.value;
    const res = await request.get('/admin/stats/users', { params });
    if (res.data) {
      users.value = res.data.users || [];
      pagination.value = res.data.pagination || { page: 1, limit: 20, totalPage: 1 };
    }
  } catch (error) {
    toast.error('加载用户列表失败');
  } finally {
    loading.value = false;
  }
};

const handleFilterChange = () => {
  fetchUsers(1);
};

const handleSearch = () => {
  fetchUsers(1);
};

const clearSearch = () => {
  searchKeyword.value = '';
  fetchUsers(1);
};

const addToBlacklist = async (user) => {
  try {
    const res = await request.post('/admin/users/blacklist', { email: user.email });
    if (res.code === 200) {
      user.blacklisted = true;
      toast.success(res.message === 'User is already in blacklist' ? '该用户已在黑名单中' : '已加入黑名单');
    }
  } catch (error) {
    toast.error('拉黑失败，请重试');
  }
};

const removeFromBlacklist = async (user) => {
  if (!window.confirm(`确定将 ${user.author}（${user.email}）移出黑名单吗？移出后该邮箱可重新提交评论。`)) return;
  try {
    const res = await request.delete('/admin/users/blacklist', { params: { email: user.email } });
    if (res.code === 200) {
      user.blacklisted = false;
      toast.success('已移出黑名单');
    }
  } catch (error) {
    toast.error('操作失败，请重试');
  }
};

const viewUserComments = (user) => {
  router.push({
    path: '/user-comments',
    query: { author: user.author, email: user.email }
  });
};

const formatDate = (str) => {
  if (!str) return '-';
  return new Date(str).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const formatDateTime = (str) => {
  if (!str) return '-';
  return new Date(str).toLocaleString('zh-CN');
};

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => fetchUsers(1));
</script>
