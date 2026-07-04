<script setup lang="ts">
import { ref, watch } from "vue";

export interface ConfirmOptions {
  title: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  kind?: "danger" | "warning" | "info";
}

const visible = ref(false);
const options = ref<ConfirmOptions>({ title: "", message: "" });
let resolvePromise: ((value: boolean) => void) | null = null;

function show(opts: ConfirmOptions): Promise<boolean> {
  options.value = opts;
  visible.value = true;
  return new Promise((resolve) => {
    resolvePromise = resolve;
  });
}

function confirm() {
  visible.value = false;
  resolvePromise?.(true);
  resolvePromise = null;
}

function cancel() {
  visible.value = false;
  resolvePromise?.(false);
  resolvePromise = null;
}

// 监听 Escape 键
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && visible.value) {
    cancel();
  }
  if (e.key === "Enter" && visible.value) {
    confirm();
  }
}

watch(visible, (val) => {
  if (val) {
    document.addEventListener("keydown", onKeydown);
  } else {
    document.removeEventListener("keydown", onKeydown);
  }
});

defineExpose({ show });
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩 -->
    <div
      v-if="visible"
      class="fixed inset-0 z-[11000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      @click.self="cancel"
    >
      <!-- 弹窗 -->
      <div
        class="w-96 rounded-xl bg-gray-50 dark:bg-gray-900 border shadow-2xl overflow-hidden"
        :class="{
          'border-red-300 dark:border-red-800/50': options.kind === 'danger',
          'border-amber-800/50': options.kind === 'warning',
          'border-blue-300 dark:border-blue-800/50': options.kind === 'info' || !options.kind,
        }"
      >
        <!-- 标题 -->
        <div class="px-5 pt-5 pb-2">
          <h3
            class="text-base font-semibold"
            :class="{
              'text-red-600 dark:text-red-400': options.kind === 'danger',
              'text-amber-600 dark:text-amber-400': options.kind === 'warning',
              'text-blue-400': options.kind === 'info' || !options.kind,
            }"
          >
            {{ options.title }}
          </h3>
        </div>
        <!-- 内容 -->
        <div class="px-5 py-2">
          <p class="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
            {{ options.message }}
          </p>
        </div>
        <!-- 按钮 -->
        <div class="flex justify-end gap-2 px-5 pb-5 pt-3">
          <button
            class="h-8 px-4 text-xs rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 transition-colors"
            @click="cancel"
          >
            {{ options.cancelLabel || "取消" }}
          </button>
          <button
            class="h-8 px-4 text-xs rounded-lg text-white transition-colors font-medium"
            :class="{
              'bg-red-600 hover:bg-red-500': options.kind === 'danger',
              'bg-amber-600 hover:bg-amber-500': options.kind === 'warning',
              'bg-blue-600 hover:bg-blue-500': options.kind === 'info' || !options.kind,
            }"
            @click="confirm"
          >
            {{ options.okLabel || "确定" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
