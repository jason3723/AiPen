<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useDocumentStore } from "../stores/document";
import type { KnowledgeBase } from "../types/shared";

const store = useDocumentStore();

const knowledgeBases = ref<KnowledgeBase[]>([]);
const loading = ref({ list: false, upload: false });
const error = ref("");
const previewingId = ref("");

// 编辑弹窗
const showForm = ref(false);
const editingId = ref("");
const form = ref({ name: "", content: "" });
const saving = ref(false);

onMounted(async () => {
  await loadList();
});

watch(() => store.dataVersion, () => {
  loadList();
});

/** 规范化知识库名称：去除文件扩展名、数字前缀、多余符号 */
function normalizeKbName(raw: string): string {
  let name = raw
    .replace(/\.(docx|txt|md)$/i, "")   // 去扩展名
    .replace(/^\d+[-._\s]+/, "")         // 去 "01-" 类前缀
    .replace(/^[-._\s]+/, "")            // 去残留前缀符号
    .trim();
  return name || "未命名知识库";
}

async function loadList() {
  loading.value.list = true;
  error.value = "";
  try {
    knowledgeBases.value = await invoke<KnowledgeBase[]>("list_knowledge_bases");
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value.list = false;
  }
}

function togglePreview(kbId: string) {
  previewingId.value = previewingId.value === kbId ? "" : kbId;
}

function openEditForm(kb: KnowledgeBase) {
  editingId.value = kb.id;
  form.value = { name: kb.name, content: kb.content };
  showForm.value = true;
}

function cancelForm() {
  showForm.value = false;
  editingId.value = "";
}

async function handleSave() {
  if (!form.value.name.trim() || !form.value.content.trim()) return;
  saving.value = true;
  error.value = "";
  try {
    if (editingId.value) {
      await invoke("update_knowledge_base", {
        kbId: editingId.value,
        name: form.value.name.trim(),
        content: form.value.content,
        category: "custom",
      });
    } else {
      await invoke("create_knowledge_base", {
        name: form.value.name.trim(),
        content: form.value.content,
        category: "custom",
      });
    }
    showForm.value = false;
    editingId.value = "";
    await loadList();
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}

/** 新建知识库 = 选择文件 → 解析 → 弹出确认表单 */
async function handleCreate() {
  loading.value.upload = true;
  error.value = "";
  try {
    const selected = await open({
      multiple: false,
      filters: [{ name: "文档 (docx/txt/md)", extensions: ["docx", "txt", "md"] }],
    });
    if (selected === null || selected === undefined) return;

    const filePath = typeof selected === "string" ? selected : (selected as unknown as { path: string }).path;
    const content = await invoke<string>("parse_kb_file", { path: filePath });
    form.value = {
      name: normalizeKbName(filePath.split(/[\\/]/).pop() || ""),
      content,
    };
    editingId.value = "";
    showForm.value = true;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value.upload = false;
  }
}

async function handleDelete(kb: KnowledgeBase) {
  error.value = "";
  try {
    await invoke("delete_knowledge_base", { kbId: kb.id });
    knowledgeBases.value = knowledgeBases.value.filter((k) => k.id !== kb.id);
  } catch (e) {
    error.value = String(e);
  }
}
</script>

<template>
  <div class="flex flex-col h-full text-sm">
    <!-- 错误 -->
    <div
      v-if="error"
      class="mb-2 text-xs text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/30 border border-red-300 dark:border-red-900/30 rounded px-3 py-2"
    >
      {{ error }}
      <button class="ml-2 underline hover:text-red-600 dark:hover:text-red-300" @click="error = ''">关闭</button>
    </div>

    <!-- 操作栏 -->
    <div class="flex items-center gap-2 mb-3">
      <button
        class="h-7 px-3 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors"
        :disabled="loading.upload"
        @click="handleCreate"
      >
        {{ loading.upload ? "解析中..." : "+ 新建知识库" }}
      </button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading.list" class="text-gray-400 dark:text-gray-500 text-xs text-center py-8">加载知识库...</div>

    <!-- 知识库列表 -->
    <div v-else class="flex-1 overflow-y-auto space-y-2">
      <div
        v-for="kb in knowledgeBases"
        :key="kb.id"
        class="border border-gray-300/50 dark:border-gray-700/50 rounded-lg bg-gray-100/50 dark:bg-gray-800/30"
      >
        <!-- 头部 -->
        <div
          class="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-gray-100/50 dark:hover:bg-gray-800/50 transition-colors"
          @click="togglePreview(kb.id)"
        >
          <div class="flex-1 min-w-0 flex items-center gap-2">
            <span class="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{{ kb.name }}</span>
            <span
              class="text-[10px] px-1 rounded shrink-0"
              :class="kb.is_builtin ? 'text-gray-500 dark:text-gray-600 border border-gray-300 dark:border-gray-700' : 'bg-blue-400/25 text-gray-800 dark:text-gray-200'"
            >
              {{ kb.is_builtin ? '内置' : '自定义' }}
            </span>
            <span class="text-[10px] text-gray-500 dark:text-gray-600 shrink-0">{{ kb.content.length }} 字</span>
          </div>
          <div class="flex items-center gap-1 shrink-0 ml-2">
            <span class="text-[10px] text-gray-400 dark:text-gray-500">{{ previewingId === kb.id ? '▼' : '▶' }}</span>
          </div>
        </div>

        <!-- 内容预览 -->
        <div v-if="previewingId === kb.id" class="border-t border-gray-300/50 dark:border-gray-700/50">
          <!-- 内置：不可查看内容 -->
          <div v-if="kb.is_builtin" class="px-3 py-3 text-xs text-gray-400 dark:text-gray-500 text-center">
            内置知识库，不可查看内容
          </div>
          <!-- 自定义：显示内容 -->
          <div v-else>
            <div class="px-3 py-3 text-xs text-gray-700 dark:text-gray-300 leading-relaxed max-h-60 overflow-y-auto whitespace-pre-wrap">
              {{ kb.content }}
            </div>
            <div class="flex items-center gap-1 px-3 pb-2">
              <button
                class="text-[10px] text-gray-400 dark:text-gray-500 hover:text-yellow-600 dark:hover:text-yellow-400 px-1.5 transition-colors"
                @click.stop="openEditForm(kb)"
              >
                编辑
              </button>
              <span class="text-gray-300 dark:text-gray-700">|</span>
              <button
                class="text-[10px] text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 px-1.5 transition-colors"
                @click.stop="handleDelete(kb)"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="knowledgeBases.length === 0" class="text-center py-8 text-gray-500 dark:text-gray-600 text-xs">
        暂无知识库
      </div>
    </div>

    <!-- 新建/编辑弹窗 -->
    <div
      v-if="showForm"
      class="fixed inset-0 z-50 flex items-center justify-center"
      @click.self="cancelForm"
    >
      <div class="absolute inset-0 bg-black/60" />
      <div class="relative w-full max-w-lg max-h-[85vh] bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl shadow-2xl flex flex-col mx-4">
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <h3 class="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {{ editingId ? '编辑知识库' : '确认知识库信息' }}
          </h3>
          <button
            class="h-6 w-6 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded"
            @click="cancelForm"
          >✕</button>
        </div>
        <div class="px-4 py-3 space-y-3 overflow-y-auto">
          <div v-if="!editingId" class="text-[10px] text-gray-400 dark:text-gray-500 bg-amber-50/60 dark:bg-amber-950/20 border border-amber-300/40 dark:border-amber-900/30 rounded px-2 py-1.5">
            文件已解析完成，请确认名称后保存
          </div>
          <div>
            <label class="text-[10px] text-gray-400 dark:text-gray-500 block mb-1">名称</label>
            <input
              v-model="form.name"
              type="text"
              class="w-full h-8 px-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 focus:border-blue-500 focus:outline-none"
              placeholder="知识库名称"
            />
          </div>
          <div>
            <label class="text-[10px] text-gray-400 dark:text-gray-500 block mb-1">
              内容
              <span class="text-gray-500 dark:text-gray-600 ml-1">{{ form.content.length }} 字</span>
            </label>
            <textarea
              v-model="form.content"
              rows="8"
              class="w-full px-2 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 focus:border-blue-500 focus:outline-none resize-none"
              placeholder="知识库内容..."
            />
          </div>
        </div>
        <div class="flex gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-800">
          <button
            class="flex-1 h-7 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
            :disabled="saving || !form.name.trim() || !form.content.trim()"
            @click="handleSave"
          >
            {{ saving ? '保存中...' : '保存' }}
          </button>
          <button
            class="h-7 px-4 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
            @click="cancelForm"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
