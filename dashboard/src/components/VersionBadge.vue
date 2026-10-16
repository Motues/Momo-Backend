<template>
  <div class="flex flex-col items-center gap-1">
    <button
      type="button"
      class="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-mono text-gray-500 transition-colors hover:text-blue-600 hover:bg-gray-100 disabled:opacity-60 disabled:cursor-wait"
      :disabled="checking"
      :title="title"
      :aria-label="title"
      data-test="version-badge"
      @click="handleClick"
    >
      <span>v{{ currentVersion }}</span>
      <!-- 发现新版本时的小表情提醒 -->
      <span
        v-if="hasUpdate"
        class="text-sm leading-none"
        data-test="version-update-emoji"
        aria-hidden="true"
      >🎉</span>
      <i v-if="checking" class="fa-solid fa-arrows-rotate fa-spin text-[10px]"></i>
    </button>

    <a
      v-if="hasUpdate"
      :href="linkUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="text-[10px] text-blue-600 hover:underline"
      data-test="version-update-link"
    >
      发现新版本 v{{ latestVersion }}
    </a>
    <button
      v-else-if="error"
      type="button"
      class="text-[10px] text-gray-400 hover:text-blue-600"
      data-test="version-error"
      @click="checkNow"
    >
      检查更新失败，点击重试
    </button>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useVersionCheck } from '../composables/useVersionCheck';
import { RELEASE_PAGE_URL } from '../utils/version';

const props = defineProps({
  /** 是否在挂载后自动检查（测试里可关掉，避免意外请求） */
  autoCheck: { type: Boolean, default: true },
});

const { currentVersion, latestVersion, releaseUrl, checking, error, hasUpdate, check } =
  useVersionCheck();

const linkUrl = computed(() => releaseUrl.value || RELEASE_PAGE_URL);

const title = computed(() => {
  if (hasUpdate.value) return `发现新版本 v${latestVersion.value}，点击查看`;
  if (checking.value) return '正在检查更新...';
  return '点击检查更新';
});

const checkNow = () => check({ force: true });

const handleClick = () => {
  // 有新版时这一步是「去看新版」，否则是手动重新检查
  if (hasUpdate.value) {
    window.open?.(linkUrl.value, '_blank', 'noopener');
    return;
  }
  checkNow();
};

onMounted(() => {
  if (props.autoCheck) check();
});
</script>
