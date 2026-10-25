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

    <button
      v-if="hasUpdate"
      type="button"
      class="text-[10px] text-blue-600 hover:underline"
      title="查看升级指南"
      data-test="version-update-button"
      @click="openGuide"
    >
      发现新版本 v{{ latestVersion }}
    </button>
    <button
      v-else-if="error"
      type="button"
      class="text-[10px] text-gray-400 hover:text-blue-600"
      data-test="version-error"
      @click="checkNow"
    >
      检查更新失败，点击重试
    </button>

    <UpdateGuideModal
      :visible="showGuide"
      :current-version="currentVersion"
      :latest-version="latestVersion"
      :release-url="linkUrl"
      @close="showGuide = false"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useVersionCheck } from '../composables/useVersionCheck';
import { releaseTagUrl } from '../utils/version';
import UpdateGuideModal from './UpdateGuideModal.vue';

const props = defineProps({
  /** 是否在挂载后自动检查（测试里可关掉，避免意外请求） */
  autoCheck: { type: Boolean, default: true },
});

const { currentVersion, latestVersion, releaseUrl, checking, error, hasUpdate, check } =
  useVersionCheck();

const linkUrl = computed(() => releaseUrl.value || releaseTagUrl(latestVersion.value));
const showGuide = ref(false);

const title = computed(() => {
  if (hasUpdate.value) return `发现新版本 v${latestVersion.value}，点击查看升级指南`;
  if (checking.value) return '正在检查更新...';
  return '点击检查更新';
});

const openGuide = () => {
  if (hasUpdate.value) showGuide.value = true;
};

const checkNow = () => check({ force: true });

const handleClick = async () => {
  // 有新版时打开升级指南；没有新版时这一步是手动重新检查。
  // 如果重新检查后发现了新版本，直接把指南弹出来，省一次点击。
  if (hasUpdate.value) {
    openGuide();
    return;
  }
  const foundUpdate = await checkNow();
  if (foundUpdate) showGuide.value = true;
};

watch(hasUpdate, (value) => {
  // 版本被追平时不要让浮窗停在旧结论上
  if (!value) showGuide.value = false;
});

onMounted(() => {
  if (props.autoCheck) check();
});
</script>
