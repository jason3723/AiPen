<script setup lang="ts">
import { ref, reactive, onMounted, provide } from "vue";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import EditorView from "./views/EditorView.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import { registerConfirmDialog } from "./composables/useConfirm";
import { useTheme } from "./stores/theme";

// 激活全局主题（模块级初始化）并暴露给子组件
const theme = useTheme();
provide("theme", theme);

const confirmDialog = ref<InstanceType<typeof ConfirmDialog> | null>(null);

// ── 软件更新状态 ──
export interface UpdateInfo {
  version: string;
  body: string | null;
}

export type UpdatePhase =
  | "idle"           // 尚未开始检查
  | "checking"       // 正在检查
  | "available"      // 发现新版本
  | "up-to-date"     // 已是最新版
  | "error";         // 检查失败（网络不通等）

export interface UpdateState {
  phase: UpdatePhase;
  updateInfo: UpdateInfo | null;
  errorMessage: string;
  /** 本次会话是否已放弃自动检查（3次失败后） */
  gaveUp: boolean;
  /** 上次检查时间 */
  lastCheckedAt: number | null;
}

const updateState = reactive<UpdateState>({
  phase: "idle",
  updateInfo: null,
  errorMessage: "",
  gaveUp: false,
  lastCheckedAt: null,
});

provide("updateState", updateState);

// ── 启动时自动检查更新（最多重试3次，仅网络错误重试）──
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function startupCheck() {
  updateState.phase = "checking";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const update = await check();
      // 成功：无论有无更新，都算成功，不再重试
      updateState.lastCheckedAt = Date.now();
      if (update) {
        updateState.updateInfo = {
          version: update.version,
          body: update.body ?? null,
        };
        updateState.phase = "available";
      } else {
        updateState.phase = "up-to-date";
      }
      return;
    } catch (err) {
      const isLastAttempt = attempt >= MAX_RETRIES;
      if (isLastAttempt) {
        updateState.phase = "error";
        updateState.errorMessage = "无法连接更新服务器，请检查网络后重试";
        updateState.gaveUp = true;
        return;
      }
      // 非最后一次，延时后重试
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

// ── 全局更新通知弹窗（启动时检测到更新后显示）──
const downloadProgress = ref(0);
const downloadingUpdate = ref(false);
const updateError = ref("");
/** 用户关闭弹窗后不再自动弹出（防止与设置面板冲突） */
const dismissedGlobalUpdate = ref(false);

async function handleGlobalDownload() {
  downloadingUpdate.value = true;
  downloadProgress.value = 0;
  updateError.value = "";
  try {
    const update = await check();
    if (!update) {
      updateState.phase = "up-to-date";
      return;
    }
    // 跟踪已下载字节数
    let totalBytes = 0;
    let downloadedBytes = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        if (totalBytes > 0) {
          downloadProgress.value = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
        }
      }
    });
    downloadProgress.value = 100;
    await relaunch();
  } catch (err) {
    updateError.value = `下载失败: ${String(err)}`;
  } finally {
    downloadingUpdate.value = false;
  }
}

onMounted(() => {
  if (confirmDialog.value) {
    registerConfirmDialog(confirmDialog.value);
  }
  startupCheck();
});
</script>

<template>
  <EditorView />
  <ConfirmDialog ref="confirmDialog" />

  <!-- 全局更新通知弹窗 -->
  <Teleport to="body">
    <div
      v-if="updateState.phase === 'available' && !dismissedGlobalUpdate"
      class="fixed inset-0 z-[10000] flex items-center justify-center"
    >
      <!-- 遮罩 -->
      <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <!-- 弹窗 -->
      <div class="relative w-[420px] max-w-[92vw] bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl shadow-2xl">
        <!-- 标题栏 -->
        <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-800">
          <h2 class="text-base font-semibold text-gray-800 dark:text-gray-200">软件更新</h2>
        </div>
        <!-- 内容 -->
        <div class="px-5 py-4 space-y-4">
          <div class="flex items-center gap-2">
            <span class="text-2xl">🎉</span>
            <span class="text-sm text-gray-700 dark:text-gray-300">
              发现新版本 <span class="font-semibold text-blue-400">v{{ updateState.updateInfo?.version }}</span>
            </span>
          </div>

          <div
            v-if="updateState.updateInfo?.body"
            class="text-xs text-gray-400 dark:text-gray-500 whitespace-pre-wrap leading-relaxed max-h-24 overflow-y-auto bg-white/80 dark:bg-gray-950/50 rounded-lg p-2 border border-gray-200 dark:border-gray-800"
          >
            {{ updateState.updateInfo.body }}
          </div>

          <!-- 下载进度 -->
          <div v-if="downloadingUpdate" class="space-y-1">
            <div class="w-full h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                class="h-full bg-blue-500 rounded-full transition-all duration-300"
                :style="{ width: downloadProgress + '%' }"
              />
            </div>
            <p class="text-xs text-gray-400 dark:text-gray-500 text-right">{{ downloadProgress }}%</p>
          </div>

          <!-- 错误 -->
          <div v-if="updateError" class="text-xs text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/30 border border-red-300 dark:border-red-900/30 rounded-lg px-3 py-2 break-all">
            {{ updateError }}
          </div>
        </div>
        <!-- 底部按钮 -->
        <div class="border-t border-gray-200 dark:border-gray-800 px-5 py-3 flex gap-2 justify-end">
          <button
            class="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 text-sm rounded-lg transition-colors"
            @click="dismissedGlobalUpdate = true"
          >
            {{ downloadingUpdate ? "后台更新" : "稍后更新" }}
          </button>
          <button
            class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            :disabled="downloadingUpdate"
            @click="handleGlobalDownload"
          >
            {{ downloadingUpdate ? "下载中..." : "立即更新" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
