<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-guide-title"
      data-test="update-guide-modal"
    >
      <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" @click="close"></div>

      <div
        ref="dialogEl"
        tabindex="-1"
        class="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl focus:outline-none"
      >
        <header class="flex shrink-0 items-start gap-3 border-b border-slate-100 px-5 py-4">
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50"
            aria-hidden="true"
          >
            <span class="text-lg leading-none">🎉</span>
          </div>
          <div class="min-w-0 flex-1">
            <h3 id="update-guide-title" class="text-sm font-semibold text-slate-800">
              发现新版本
              <span class="font-mono text-blue-600">v{{ latestVersion }}</span>
            </h3>
            <p class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <span>当前版本</span>
              <span class="font-mono">v{{ currentVersion }}</span>
              <i class="fa-solid fa-arrow-right text-[9px] text-slate-300" aria-hidden="true"></i>
              <span class="font-mono font-medium text-blue-600">v{{ latestVersion }}</span>
            </p>
          </div>
          <button
            type="button"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="关闭升级提示"
            data-test="update-guide-close"
            @click="close"
          >
            <i class="fa-solid fa-xmark text-base" aria-hidden="true"></i>
          </button>
        </header>

        <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <section>
            <h4 class="text-[11px] font-bold uppercase tracking-widest text-slate-400">
              数据库变更
            </h4>

            <div
              v-if="changes.length"
              class="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5"
            >
              <ul class="space-y-2">
                <li
                  v-for="change in changes"
                  :key="change.version"
                  class="flex gap-2 text-xs leading-relaxed"
                >
                  <span class="shrink-0 font-mono font-semibold text-amber-800">
                    v{{ change.version }}
                  </span>
                  <span class="text-amber-900">
                    {{ change.summary }}
                    <span
                      v-if="change.manual"
                      class="ml-1 inline-block rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700"
                    >
                      需手动迁移
                    </span>
                  </span>
                </li>
              </ul>
              <p class="mt-2 border-t border-amber-200/70 pt-2 text-[11px] leading-relaxed text-amber-800">
                除标注「需手动迁移」的项外，Node.js / Go 会在启动时、Worker 会在首次请求时自动补表 /
                补列。升级前建议先备份数据库。
              </p>
            </div>

            <div
              v-else
              class="mt-2 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5"
            >
              <i
                class="fa-solid fa-circle-check mt-0.5 text-xs text-emerald-500"
                aria-hidden="true"
              ></i>
              <p class="text-xs leading-relaxed text-emerald-800">
                本次升级不涉及已知的数据库结构变更，替换文件并重启即可；如有变更请以 Release
                说明为准。升级前仍建议备份数据库。
              </p>
            </div>
          </section>

          <section>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h4 class="text-[11px] font-bold uppercase tracking-widest text-slate-400">
                升级步骤
              </h4>
              <span
                v-if="deploymentBadge"
                class="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600"
                data-test="update-guide-deployment"
              >
                {{ deploymentBadge }}
              </span>
            </div>

            <div
              v-if="runtimeLoading"
              class="mt-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-500"
              data-test="update-guide-detecting"
            >
              <i class="fa-solid fa-arrows-rotate fa-spin" aria-hidden="true"></i>
              正在识别当前部署方式…
            </div>

            <div
              v-else-if="!deployment"
              class="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5"
              data-test="update-guide-manual"
            >
              <p class="text-xs font-medium text-amber-900">无法自动识别部署方式</p>
              <p class="mt-1 text-[11px] leading-relaxed text-amber-800">
                {{ runtimeError || '当前后端没有返回运行时信息，可能是旧版本；请手动选择。' }}
              </p>
              <div class="mt-2 grid grid-cols-2 gap-2">
                <button
                  v-for="type in MANUAL_DEPLOYMENTS"
                  :key="type"
                  type="button"
                  class="rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-left text-[11px] font-medium text-amber-800 transition-colors hover:border-amber-300 hover:bg-amber-100"
                  @click="chooseManual(type)"
                >
                  {{ DEPLOYMENT_LABELS[type] }}
                </button>
              </div>
            </div>

            <template v-else>
              <div
                v-if="runtimeError && !runtimeInfo"
                class="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-slate-400"
              >
                <span>自动识别失败，当前按手动选择显示。</span>
                <button
                  type="button"
                  class="text-blue-500 hover:underline"
                  @click="detectDeployment"
                >
                  重新识别
                </button>
                <span aria-hidden="true">·</span>
                <button type="button" class="text-blue-500 hover:underline" @click="clearManual">
                  重新选择
                </button>
              </div>

              <ol class="mt-3 space-y-3">
                <li
                  v-for="(step, index) in steps"
                  :key="step.title"
                  class="flex gap-3"
                >
                  <span
                    class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[10px] font-semibold text-blue-600"
                  >
                    {{ index + 1 }}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-medium text-slate-700">{{ step.title }}</p>
                    <p
                      v-if="step.text"
                      class="mt-0.5 text-[11px] leading-relaxed text-slate-500"
                    >
                      {{ step.text }}
                    </p>
                    <code
                      v-if="step.command"
                      class="mt-1 block w-fit max-w-full whitespace-pre-wrap break-all rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                    >
                      {{ step.command }}
                    </code>
                    <p
                      v-if="step.note"
                      class="mt-1 text-[11px] leading-relaxed text-amber-700"
                    >
                      {{ step.note }}
                    </p>
                  </div>
                </li>
              </ol>
            </template>
          </section>

          <p class="text-[11px] leading-relaxed text-slate-400">
            面板与后端请一起升级；评论组件按需替换 CDN 引用。完整步骤见
            <a
              :href="UPDATE_DOC_URL"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-500 hover:underline"
            >
              更新文档
            </a>。
          </p>
        </div>

        <footer
          class="flex shrink-0 items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3"
        >
          <a
            :href="UPDATE_DOC_URL"
            target="_blank"
            rel="noopener noreferrer"
            class="text-[11px] text-slate-500 transition-colors hover:text-blue-600 hover:underline"
          >
            完整更新文档
          </a>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
              @click="close"
            >
              稍后
            </button>
            <a
              :href="releaseHref"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
              data-test="update-guide-release-link"
            >
              <i class="fa-brands fa-github" aria-hidden="true"></i>
              查看 Release 页面
            </a>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { releaseTagUrl } from '../utils/version';
import {
  DEPLOYMENT_LABELS,
  MANUAL_DEPLOYMENTS,
  deploymentFor,
  fetchRuntimeInfo,
} from '../utils/runtimeInfo';
import { UPDATE_DOC_URL, buildUpgradeSteps, getDatabaseChanges } from '../utils/updateGuide';

const DEPLOYMENT_STORAGE_KEY = 'momo_deploy_type';

const props = defineProps({
  visible: { type: Boolean, default: false },
  currentVersion: { type: String, default: '' },
  latestVersion: { type: String, default: '' },
  /** GitHub API 返回的具体 Release 地址；缺失时按版本号拼接，版本号也不可用则退回列表 */
  releaseUrl: { type: String, default: '' },
});

const emit = defineEmits(['close']);

const runtimeInfo = ref(null);
const runtimeLoading = ref(false);
const runtimeError = ref('');
const manualDeployment = ref(readManualDeployment());
const dialogEl = ref(null);

const changes = computed(() => getDatabaseChanges(props.currentVersion, props.latestVersion));
const releaseHref = computed(() => props.releaseUrl || releaseTagUrl(props.latestVersion));

/** 自动识别优先；后端是旧版本时退回用户手动选择的部署方式 */
const deployment = computed(() =>
  runtimeInfo.value ? deploymentFor(runtimeInfo.value) : manualDeployment.value
);
const deploymentLabel = computed(() => DEPLOYMENT_LABELS[deployment.value] || '');

const deploymentDetail = computed(() => {
  if (!runtimeInfo.value) return '';
  const info = runtimeInfo.value;
  if (deployment.value === 'worker') return '';
  if (deployment.value === 'docker') {
    if (info.runtime === 'node') return 'Node.js 镜像';
    if (info.runtime === 'go') return 'Go 镜像';
    return '';
  }
  return `${info.os} / ${info.arch}`;
});

const deploymentBadge = computed(() => {
  if (!deployment.value) return '';
  const suffix = runtimeInfo.value
    ? deploymentDetail.value
      ? ` · ${deploymentDetail.value}`
      : ''
    : ' · 手动选择';
  return `${deploymentLabel.value}${suffix}`;
});

const steps = computed(() =>
  buildUpgradeSteps({
    deployment: deployment.value,
    runtime: runtimeInfo.value?.runtime,
    os: runtimeInfo.value?.os,
    arch: runtimeInfo.value?.arch,
  })
);

function readManualDeployment() {
  try {
    const value = globalThis.localStorage?.getItem(DEPLOYMENT_STORAGE_KEY);
    return MANUAL_DEPLOYMENTS.includes(value) ? value : '';
  } catch {
    return '';
  }
}

function chooseManual(type) {
  if (!MANUAL_DEPLOYMENTS.includes(type)) return;
  manualDeployment.value = type;
  try {
    globalThis.localStorage?.setItem(DEPLOYMENT_STORAGE_KEY, type);
  } catch {
    // 存储不可用时只影响下次是否记住选择，不影响本次展示
  }
}

function clearManual() {
  manualDeployment.value = '';
  try {
    globalThis.localStorage?.removeItem(DEPLOYMENT_STORAGE_KEY);
  } catch {
    // 同上
  }
}

async function detectDeployment() {
  if (runtimeLoading.value) return;
  runtimeLoading.value = true;
  runtimeError.value = '';
  try {
    runtimeInfo.value = await fetchRuntimeInfo();
  } catch (error) {
    runtimeInfo.value = null;
    runtimeError.value = error?.message || '无法自动识别部署方式';
  } finally {
    runtimeLoading.value = false;
  }
}

const close = () => emit('close');

/** Esc 关闭：浮窗覆盖了整个页面，键盘用户不应该只能去点右上角 */
function onKeydown(event) {
  if (event.key === 'Escape' && props.visible) close();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return;
    await nextTick();
    dialogEl.value?.focus?.();
    detectDeployment();
  },
  { immediate: true }
);
</script>
