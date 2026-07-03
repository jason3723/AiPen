<script setup lang="ts">
import { ref } from "vue";
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";
import { useConfirm } from "../composables/useConfirm";

const { confirm } = useConfirm();

const store = useDocumentStore();
const {
  versions,
  loading,
  selectedOldVersionId,
  selectedNewVersionId,
  viewingVersionId,
} = storeToRefs(store);

// 内联重命名状态
const editingVersionId = ref("");
const editingVersionMsg = ref("");

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr.replace(" ", "T") + "Z");
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function toggleVersionSelection(versionId: string) {
  if (selectedOldVersionId.value === versionId) {
    selectedOldVersionId.value = "";
    return;
  }
  if (selectedNewVersionId.value === versionId) {
    selectedNewVersionId.value = "";
    return;
  }
  // 如果还没有选中的版本，设为旧版
  if (!selectedOldVersionId.value) {
    selectedOldVersionId.value = versionId;
  } else if (!selectedNewVersionId.value) {
    // 确保新旧版本不同
    if (versionId !== selectedOldVersionId.value) {
      selectedNewVersionId.value = versionId;
    }
  } else {
    // 两个都选中了，重新开始：旧的变成新的，新选的变成旧的
    selectedOldVersionId.value = selectedNewVersionId.value;
    selectedNewVersionId.value = versionId;
  }
}

function isSelected(versionId: string): "old" | "new" | "none" {
  if (versionId === selectedOldVersionId.value) return "old";
  if (versionId === selectedNewVersionId.value) return "new";
  return "none";
}

function isViewing(versionId: string): boolean {
  return versionId === viewingVersionId.value;
}

function handleLoadVersion(versionId: string) {
  store.loadVersionContent(versionId);
}

// ── 重命名 ──
function startRename(versionId: string, currentMsg: string) {
  editingVersionId.value = versionId;
  editingVersionMsg.value = currentMsg || `版本 ${versions.value.find(v => v.id === versionId)?.version_num || ""}`;
}

function confirmRename(versionId: string) {
  if (editingVersionMsg.value.trim()) {
    store.renameVersion(versionId, editingVersionMsg.value.trim());
  }
  editingVersionId.value = "";
  editingVersionMsg.value = "";
}

function cancelRename() {
  editingVersionId.value = "";
  editingVersionMsg.value = "";
}

// ── 删除 ──
async function handleDelete(versionId: string) {
  const v = versions.value.find((x) => x.id === versionId);
  const label = v ? `v${v.version_num}: ${v.commit_msg || ""}` : "该版本";
  const ok = await confirm({
    title: "删除版本",
    message: `确定要删除 ${label} 吗？此操作不可撤销。`,
    kind: "danger",
    okLabel: "删除",
    cancelLabel: "取消",
  });
  if (ok) {
    store.deleteVersion(versionId);
  }
}

// ── 回滚 ──
async function handleRollback(versionId: string) {
  const v = versions.value.find((x) => x.id === versionId);
  const label = v ? `v${v.version_num}: ${v.commit_msg || ""}` : "该版本";
  const ok = await confirm({
    title: "回滚版本",
    message: `确定要回滚到 ${label} 吗？\n\n回滚后，该版本的内容将覆盖当前编辑草稿。`,
    kind: "warning",
    okLabel: "回滚",
    cancelLabel: "取消",
  });
  if (ok) {
    store.rollbackToVersion(versionId);
  }
}
</script>

<template>
  <div class="space-y-2">
    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
      版本历史
    </h3>

    <!-- 空状态 -->
    <div
      v-if="!loading.versions && versions.length === 0"
      class="text-center py-8 text-gray-500 text-sm"
    >
      <p class="mb-1">暂无版本记录</p>
      <p class="text-xs">编辑文档后点击提交创建第一个版本</p>
    </div>

    <!-- 加载状态：仅在无缓存数据时显示骨架屏，避免切换文档时闪烁 -->
    <div v-if="loading.versions && versions.length === 0" class="space-y-2 animate-pulse">
      <div v-for="i in 3" :key="i" class="h-16 bg-gray-800 rounded-lg"></div>
    </div>

    <!-- 版本列表 -->
    <div v-else-if="versions.length > 0" class="space-y-1">
      <div
        v-for="v in versions"
        :key="v.id"
        class="group flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors"
        :class="{
          'bg-blue-900/30 border border-blue-700/50': isSelected(v.id) === 'old',
          'bg-green-900/30 border border-green-700/50': isSelected(v.id) === 'new',
          'bg-amber-900/20 border border-amber-700/40': isViewing(v.id) && isSelected(v.id) === 'none',
          'hover:bg-gray-800/50 border border-transparent': isSelected(v.id) === 'none' && !isViewing(v.id),
        }"
        @click="toggleVersionSelection(v.id)"
      >
        <!-- 版本号 -->
        <div
          class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
          :class="{
            'bg-blue-600 text-white': isSelected(v.id) === 'old',
            'bg-green-600 text-white': isSelected(v.id) === 'new',
            'bg-amber-600 text-white': isViewing(v.id) && isSelected(v.id) === 'none',
            'bg-gray-700 text-gray-300': isSelected(v.id) === 'none' && !isViewing(v.id),
          }"
        >
          <span v-if="isViewing(v.id) && isSelected(v.id) === 'none'">☰</span>
          <span v-else>v{{ v.version_num }}</span>
        </div>

        <!-- 信息 -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <!-- 内联重命名输入框 -->
            <input
              v-if="editingVersionId === v.id"
              v-model="editingVersionMsg"
              type="text"
              class="flex-1 text-sm bg-gray-800 border border-blue-500 rounded px-2 py-0.5 text-gray-200 outline-none"
              @keyup.enter="confirmRename(v.id)"
              @keyup.escape="cancelRename()"
              @blur="confirmRename(v.id)"
            />
            <p v-else class="text-sm font-medium text-gray-200 truncate">
              {{ v.commit_msg || `版本 ${v.version_num}` }}
            </p>
            <span
              v-if="isSelected(v.id) === 'old'"
              class="text-xs px-1.5 py-0.5 rounded bg-blue-800 text-blue-200"
            >
              旧版
            </span>
            <span
              v-if="isSelected(v.id) === 'new'"
              class="text-xs px-1.5 py-0.5 rounded bg-green-800 text-green-200"
            >
              新版
            </span>
            <span
              v-if="isViewing(v.id) && isSelected(v.id) === 'none'"
              class="text-xs px-1.5 py-0.5 rounded bg-amber-800 text-amber-200"
            >
              正在查看
            </span>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-xs text-gray-500">{{ formatDate(v.created_at) }}</span>
            <!-- 操作按钮：hover 时显示 -->
            <div class="hidden group-hover:flex items-center gap-0.5">
              <button
                class="h-5 w-5 flex items-center justify-center text-xs text-gray-500 hover:text-blue-400 hover:bg-gray-700 rounded transition-colors"
                title="查看此版本"
                @click.stop="handleLoadVersion(v.id)"
              >
                ☰
              </button>
              <button
                class="h-5 w-5 flex items-center justify-center text-xs text-gray-500 hover:text-yellow-400 hover:bg-gray-700 rounded transition-colors"
                title="重命名版本"
                @click.stop="startRename(v.id, v.commit_msg)"
              >
                ✎
              </button>
              <button
                class="h-5 w-5 flex items-center justify-center text-xs text-gray-500 hover:text-orange-400 hover:bg-gray-700 rounded transition-colors"
                title="回滚到此版本（覆盖当前草稿）"
                @click.stop="handleRollback(v.id)"
              >
                ↺
              </button>
              <button
                class="h-5 w-5 flex items-center justify-center text-xs text-gray-500 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                title="删除版本"
                @click.stop="handleDelete(v.id)"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 选择提示 -->
    <div
      v-if="versions.length > 0"
      class="text-xs text-gray-500 bg-gray-800/50 rounded-lg p-2 text-center"
    >
      <template v-if="!selectedOldVersionId && !selectedNewVersionId">
        点击版本选择旧版，再点击另一个选择新版
      </template>
      <template v-else-if="selectedOldVersionId && !selectedNewVersionId">
        已选旧版，请再选择一个版本作为新版
      </template>
    </div>
  </div>
</template>
