<template>
  <div class="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5"
    data-test="batch-action-bar">
    <span class="text-sm font-medium text-blue-700">
      已选择 <strong data-test="batch-count">{{ count }}</strong> 条
    </span>
    <button type="button" data-test="batch-clear" @click="$emit('clear')"
      class="text-xs text-blue-600 hover:underline">
      取消选择
    </button>

    <div class="ml-auto flex flex-wrap items-center gap-2">
      <span v-if="loading" class="text-xs text-blue-600">处理中…</span>
      <button type="button" data-test="batch-approve" :disabled="loading" @click="$emit('apply', 'approved')"
        class="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-600 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        <i class="fa-solid fa-check mr-1"></i>批量通过
      </button>
      <button type="button" data-test="batch-pending" :disabled="loading" @click="$emit('apply', 'pending')"
        class="rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-600 hover:bg-amber-600 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        <i class="fa-solid fa-rotate-left mr-1"></i>打回待审
      </button>
      <button type="button" data-test="batch-delete" :disabled="loading" @click="$emit('apply', 'deleted')"
        class="rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-600 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        <i class="fa-solid fa-trash-can mr-1"></i>批量删除
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  count: { type: Number, default: 0 },
  loading: { type: Boolean, default: false },
});

defineEmits(['clear', 'apply']);
</script>
