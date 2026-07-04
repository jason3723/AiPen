<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDocumentStore } from "../stores/document";
import { useMaterialStore } from "../stores/materialStore";
import { storeToRefs } from "pinia";

export interface ChatConversation {
  id: string;
  title: string;
  doc_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  context_text: string | null;
  created_at: string;
}

import type { KnowledgeBase } from "../types/shared";
export type { KnowledgeBase };

const props = defineProps<{
  currentDocId: string;
  /** 外部注入的文本片段（从编辑器右键添加） */
  injectedText?: string;
  /** 全文内容，供引用全文开关使用 */
  currentContent?: string;
}>();

const emit = defineEmits<{
  "injected-text-consumed": [];
}>();

const conversations = ref<ChatConversation[]>([]);
const currentConvId = ref("");
const messages = ref<ChatMessage[]>([]);
const inputText = ref("");
const loading = ref({ list: false, send: false });
const error = ref("");
const messagesContainer = ref<HTMLDivElement>();

// 知识库选择
const knowledgeBases = ref<KnowledgeBase[]>([]);
const selectedKbIds = ref<string[]>([]);
const showKbPicker = ref(false);

// 重命名
const renamingConv = ref("");
const renameInput = ref("");

// 引用全文开关
const quoteFullText = ref(false);

onMounted(async () => {
  await Promise.all([loadConversations(), loadKnowledgeBases(), loadMaterialTags()]);
  // 自动选中或创建对话
  if (conversations.value.length > 0) {
    await selectConversation(conversations.value[0].id);
  } else {
    await createConversation();
  }
});

// 监听外部注入文本
watch(
  () => props.injectedText,
  (text) => {
    if (text) {
      pendingQuote.value = text;
      emit("injected-text-consumed");
    }
  },
  { immediate: true },
);

// 引用气泡（不占输入框空间）
const pendingQuote = ref("");
function removeQuote() { pendingQuote.value = "" }

// 本地文件附件
const attachedFiles = ref<{ name: string; content: string }[]>([]);
const fileInputRef = ref<HTMLInputElement>();

function triggerFilePicker() {
  fileInputRef.value?.click();
}

function handleFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      if (content) {
        // 去重：同名文件覆盖
        const existing = attachedFiles.value.findIndex(f => f.name === file.name);
        if (existing >= 0) attachedFiles.value.splice(existing, 1);
        attachedFiles.value.push({ name: file.name, content });
      }
    };
    reader.readAsText(file);
  }
  input.value = "";
}

function removeAttachedFile(index: number) {
  attachedFiles.value.splice(index, 1);
}

function buildContextText(): string {
  const parts: string[] = [];
  if (pendingQuote.value) parts.push(pendingQuote.value);
  for (const f of attachedFiles.value) {
    parts.push(`[文件: ${f.name}]\n${f.content}`);
  }
  if (quoteFullText.value && props.currentContent) parts.push(props.currentContent);
  return parts.join("\n\n---\n\n");
}

const materialStore = useMaterialStore();

async function loadKnowledgeBases() {
  try {
    knowledgeBases.value = await invoke<KnowledgeBase[]>("list_knowledge_bases");
  } catch {
    // 忽略加载失败
  }
}

async function loadMaterialTags() {
  await materialStore.loadTagWithCounts();
}

// 切换到「AI对话」Tab 时刷新知识库列表和素材标签
const docStore = useDocumentStore();
const { sidebarTab, dataVersion: chatDataVersion } = storeToRefs(docStore);
watch(sidebarTab, (tab) => {
  if (tab === "chat") {
    loadKnowledgeBases();
    loadMaterialTags();
  }
});
watch(chatDataVersion, () => {
  loadKnowledgeBases();
  loadMaterialTags();
});

function toggleKb(kbId: string) {
  const idx = selectedKbIds.value.indexOf(kbId);
  if (idx >= 0) {
    selectedKbIds.value.splice(idx, 1);
  } else {
    selectedKbIds.value.push(kbId);
  }
}

async function loadConversations() {
  loading.value.list = true;
  try {
    conversations.value = await invoke<ChatConversation[]>("list_conversations", {
      docId: props.currentDocId || null,
    });
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value.list = false;
  }
}

async function createConversation() {
  error.value = "";
  try {
    const conv = await invoke<ChatConversation>("create_conversation", {
      title: "新对话",
      docId: props.currentDocId || null,
    });
    conversations.value.unshift(conv);
    await selectConversation(conv.id);
  } catch (e) {
    error.value = String(e);
  }
}

async function selectConversation(convId: string) {
  currentConvId.value = convId;
  await loadMessages(convId);
}

async function loadMessages(convId: string) {
  error.value = "";
  try {
    messages.value = await invoke<ChatMessage[]>("get_chat_messages", { convId });
    await nextTick();
    scrollToBottom();
  } catch (e) {
    error.value = String(e);
  }
}

async function sendMessage() {
  const text = inputText.value.trim();
  if (!text || !currentConvId.value) return;
  const quote = buildContextText() || null;
  inputText.value = "";
  pendingQuote.value = "";
  attachedFiles.value = [];
  loading.value.send = true;
  error.value = "";

  // 乐观渲染用户消息（引用以气泡形式附加在消息内）
  const tempId = "temp-" + Date.now();
  messages.value.push({
    id: tempId,
    conversation_id: currentConvId.value,
    role: "user",
    content: text,
    context_text: quote || null,
    created_at: new Date().toISOString(),
  });
  await nextTick();
  scrollToBottom();

  // 添加临时 AI 消息占位（流式填充）
  const tempAiId = "temp-ai-" + Date.now();
  messages.value.push({
    id: tempAiId,
    conversation_id: currentConvId.value,
    role: "assistant",
    content: "",
    context_text: null,
    created_at: new Date().toISOString(),
  });
  await nextTick();
  scrollToBottom();

  try {
    const eventId = crypto.randomUUID()
    const unlisten = await listen<{ token?: string; done?: boolean }>(`ai-stream-${eventId}`, (event) => {
      if (event.payload.token && !event.payload.done) {
        const aiMsg = messages.value.find(m => m.id === tempAiId)
        if (aiMsg) {
          aiMsg.content += event.payload.token
          scrollToBottom()
        }
      }
    })

    await invoke<string>("send_chat_message_streaming", {
      convId: currentConvId.value,
      message: text,
      contextText: quote || null,
      knowledgeBaseIds: selectedKbIds.value.length > 0 ? selectedKbIds.value : null,
      materialTagIds: materialStore.selectedMaterialTagIds.length > 0 ? materialStore.selectedMaterialTagIds : null,
      temperature: 0.7,
      eventId,
    });

    unlisten()
    // 移除临时消息，从 DB 重新加载以保持一致性
    messages.value = messages.value.filter((m) => m.id !== tempId)
    await loadMessages(currentConvId.value);
    await loadConversations();
  } catch (e) {
    error.value = String(e);
    // 移除临时消息
    messages.value = messages.value.filter((m) => m.id !== tempId && m.id !== tempAiId);
  } finally {
    loading.value.send = false;
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function handleDelete(convId: string) {
  try {
    await invoke("delete_conversation", { convId });
    conversations.value = conversations.value.filter((c) => c.id !== convId);
    if (currentConvId.value === convId) {
      messages.value = [];
      currentConvId.value = "";
      if (conversations.value.length > 0) {
        await selectConversation(conversations.value[0].id);
      } else {
        await createConversation();
      }
    }
  } catch (e) {
    error.value = String(e);
  }
}

function startRename(conv: ChatConversation) {
  renamingConv.value = conv.id;
  renameInput.value = conv.title;
}

async function confirmRename() {
  if (!renamingConv.value || !renameInput.value.trim()) {
    renamingConv.value = "";
    return;
  }
  try {
    await invoke("rename_conversation", { convId: renamingConv.value, title: renameInput.value.trim() });
    const conv = conversations.value.find((c) => c.id === renamingConv.value);
    if (conv) conv.title = renameInput.value.trim();
  } catch (e) {
    error.value = String(e);
  }
  renamingConv.value = "";
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
}

function renderMarkdown(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong class='font-bold text-gray-900 dark:text-gray-100'>$1</strong>")
    .replace(/### (.+)/g, "<h4 class='text-xs font-bold text-gray-800 dark:text-gray-200 mt-2 mb-1'>$1</h4>")
    .replace(/## (.+)/g, "<h3 class='text-sm font-bold text-blue-700 dark:text-blue-300 mt-3 mb-1'>$1</h3>")
    .replace(/# (.+)/g, "<h2 class='text-sm font-bold text-blue-700 dark:text-blue-300 mt-3 mb-2'>$1</h2>")
    .replace(/^\- (.+)/gm, "<li class='ml-3 text-gray-700 dark:text-gray-300 text-xs'>• $1</li>")
    .replace(/^(\d+)\. (.+)/gm, "<li class='ml-3 text-gray-700 dark:text-gray-300 text-xs'>$1. $2</li>")
    .replace(/`([^`]+)`/g, "<code class='bg-gray-100 dark:bg-gray-800 text-yellow-700 dark:text-yellow-300 px-1 rounded text-[11px]'>$1</code>")
    .replace(/```(\w+)?\n([\s\S]*?)```/g, "<pre class='bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 p-2 rounded text-[11px] my-1 overflow-x-auto'><code>$2</code></pre>")
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

function formatTime(ts: string) {
  // DB 存的是 UTC 时间（"2026-06-26 14:30:00"），补 Z 防止 JS 当本地时间解析
  const normalized = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
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

    <!-- 对话列表 -->
    <div class="flex items-center gap-2 mb-2">
      <select
        :value="currentConvId"
        class="flex-1 h-7 px-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 focus:border-blue-500 focus:outline-none"
        @change="selectConversation(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="conv in conversations" :key="conv.id" :value="conv.id">
          {{ conv.title }}
        </option>
      </select>
      <button
        class="h-7 w-7 flex items-center justify-center text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors shrink-0"
        title="新建对话"
        @click="createConversation"
      >
        +
      </button>
    </div>

    <!-- 当前对话操作 -->
    <div v-if="currentConvId" class="flex items-center gap-1 mb-2">
      <template v-if="renamingConv === currentConvId">
        <input
          v-model="renameInput"
          type="text"
          class="flex-1 h-6 px-2 bg-gray-100 dark:bg-gray-800 border border-blue-500 rounded text-xs text-gray-800 dark:text-gray-200 focus:outline-none"
          @keyup.enter="confirmRename"
          @blur="confirmRename"
          @keyup.escape="renamingConv = ''"
        />
      </template>
      <template v-else>
        <button
          class="text-[10px] text-gray-400 dark:text-gray-500 hover:text-yellow-600 dark:hover:text-yellow-400 px-1.5 transition-colors"
          title="重命名"
          @click="startRename(conversations.find(c => c.id === currentConvId)!)"
        >
          重命名
        </button>
        <span class="text-gray-300 dark:text-gray-700">|</span>
        <button
          class="text-[10px] text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 px-1.5 transition-colors"
          title="删除对话"
          @click="handleDelete(currentConvId)"
        >
          删除
        </button>
        <!-- 引用全文开关 -->
        <div
          class="ml-auto flex items-center gap-1 cursor-pointer select-none"
          title="开启后将当前文档全文作为AI对话上下文"
          @click="quoteFullText = !quoteFullText"
        >
          <span class="text-[10px] transition-colors" :class="quoteFullText ? 'text-blue-400' : 'text-gray-500 dark:text-gray-600'">引用全文</span>
          <button
            type="button"
            class="relative inline-flex h-4 w-7 items-center rounded-full transition-colors focus:outline-none"
            :class="quoteFullText ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'"
          >
            <span
              class="inline-block h-3 w-3 transform rounded-full bg-white transition-transform"
              :class="quoteFullText ? 'translate-x-3' : 'translate-x-0.5'"
            />
          </button>
        </div>
      </template>
    </div>

    <!-- 消息区域 -->
    <div
      ref="messagesContainer"
      class="flex-1 overflow-y-auto space-y-3 mb-3 min-h-0"
    >
      <div v-if="messages.length === 0 && !loading.send" class="text-center text-gray-500 dark:text-gray-600 text-xs py-8">
        开始对话吧 🗨
      </div>

      <div
        v-for="msg in messages"
        :key="msg.id"
        class="flex"
        :class="msg.role === 'user' ? 'justify-end' : 'justify-start'"
      >
        <div
          class="max-w-[90%] rounded-lg px-3 py-2 text-xs leading-relaxed"
          :class="msg.role === 'user'
            ? 'bg-blue-600/30 text-gray-800 dark:text-gray-200'
            : 'bg-gray-100/70 dark:bg-gray-800/60 text-gray-700 dark:text-gray-300'"
        >
          <div v-if="msg.context_text" class="text-[10px] text-blue-400/70 mb-1.5 border-l-2 border-blue-600/50 pl-2 italic leading-relaxed max-h-20 overflow-y-auto">
            {{ msg.context_text }}
          </div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-html="renderMarkdown(msg.content)" />
          <div class="text-[10px] text-gray-500 dark:text-gray-600 mt-1">{{ formatTime(msg.created_at) }}</div>
        </div>
      </div>

      <!-- 加载中指示 -->
      <div v-if="loading.send" class="flex justify-start">
        <div class="bg-gray-100/70 dark:bg-gray-800/60 rounded-lg px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
          <span class="inline-flex gap-1">
            <span class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style="animation-delay: 0ms" />
            <span class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style="animation-delay: 150ms" />
            <span class="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style="animation-delay: 300ms" />
          </span>
        </div>
      </div>
    </div>

    <!-- 输入区域 -->
    <div class="border-t border-gray-200 dark:border-gray-800 pt-2">
      <!-- 引用气泡 -->
      <div
        v-if="pendingQuote"
        class="relative mb-2 px-2.5 py-2 bg-blue-100 dark:bg-blue-950/40 border border-blue-300 dark:border-blue-800/40 rounded-lg group"
      >
        <div class="text-[10px] text-blue-400 font-medium mb-0.5">📎 引用文本</div>
        <div class="text-[11px] text-gray-700 dark:text-gray-300 leading-relaxed line-clamp-3 italic">
          {{ pendingQuote }}
        </div>
        <button
          class="absolute top-1.5 right-2 h-5 w-5 flex items-center justify-center text-[10px] text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors opacity-0 group-hover:opacity-100"
          title="移除引用"
          @click="removeQuote"
        >
          ✕
        </button>
      </div>

      <!-- 知识库与素材库选择 -->
      <div class="flex items-center gap-1 flex-wrap mb-2 relative">
        <button
          v-if="knowledgeBases.length > 0 || materialStore.tagWithCounts.length > 0"
          class="text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-1 transition-colors"
          @click="showKbPicker = !showKbPicker"
        >
          📚 {{ (selectedKbIds.length + materialStore.selectedMaterialTagIds.length) > 0 ? (selectedKbIds.length + materialStore.selectedMaterialTagIds.length) + '个' : '知识库' }}
        </button>
        <button
          class="text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-1 transition-colors"
          title="上传文本文件供AI引用"
          @click="triggerFilePicker"
        >
          📁 {{ attachedFiles.length > 0 ? attachedFiles.length + '个文件' : '本地文件' }}
        </button>
        <input
          ref="fileInputRef"
          type="file"
          multiple
          accept=".txt,.md,.json,.csv,.xml,.html,.htm,.py,.js,.ts,.jsx,.tsx,.rs,.go,.java,.c,.cpp,.h,.hpp,.css,.scss,.less,.yaml,.yml,.toml,.cfg,.ini,.log,.sh,.bat,.ps1,.sql,.r,.rb,.php,.swift,.kt,.dart,.lua,.pl,.tex,.rst,.org,.vue,.svelte"
          class="hidden"
          @change="handleFilesSelected"
        />
          <span
            v-for="kid in selectedKbIds"
            :key="kid"
            class="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded cursor-pointer"
            @click="toggleKb(kid)"
          >
            {{ knowledgeBases.find(k => k.id === kid)?.name || kid }}
          </span>
          <span
            v-for="tid in materialStore.selectedMaterialTagIds"
            :key="tid"
            class="text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.5 rounded cursor-pointer"
            @click="materialStore.toggleMaterialTag(tid)"
          >
            {{ materialStore.tagWithCounts.find(t => t.id === tid)?.name || tid }}
          </span>
        <div v-if="showKbPicker" class="absolute bottom-full left-0 mb-1.5 space-y-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-2.5 min-w-[200px] z-20">
          <!-- 知识库 -->
          <div v-if="knowledgeBases.length > 0">
            <div class="text-[10px] text-amber-600/70 dark:text-amber-400/70 mb-1">知识库</div>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="kb in knowledgeBases"
                :key="kb.id"
                class="text-[10px] px-2 py-0.5 rounded transition-colors"
                :class="selectedKbIds.includes(kb.id) ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700/50' : 'text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:text-gray-700 dark:hover:text-gray-300'"
                @click="toggleKb(kb.id)"
              >
                {{ kb.name }}
              </button>
            </div>
          </div>
          <!-- 分隔符 -->
          <div v-if="knowledgeBases.length > 0 && materialStore.tagWithCounts.length > 0" class="border-t border-gray-300/50 dark:border-gray-700/50"></div>
          <!-- 素材库标签 -->
          <div v-if="materialStore.tagWithCounts.length > 0">
            <div class="text-[10px] text-emerald-600/70 dark:text-emerald-400/70 mb-1">素材库标签</div>
            <div class="flex flex-wrap gap-1">
              <button
                v-for="tag in materialStore.tagWithCounts"
                :key="tag.id"
                class="text-[10px] px-2 py-0.5 rounded transition-colors"
                :class="materialStore.selectedMaterialTagIds.includes(tag.id) ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-700/50' : 'text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:text-gray-700 dark:hover:text-gray-300'"
                @click="materialStore.toggleMaterialTag(tag.id)"
              >
                {{ tag.name }} ({{ tag.material_count }})
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 本地文件附件标签 -->
      <div v-if="attachedFiles.length > 0" class="flex items-center gap-1 flex-wrap mb-2">
        <span
          v-for="(f, i) in attachedFiles"
          :key="f.name"
          class="text-[10px] text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/40 px-1.5 py-0.5 rounded cursor-pointer"
          title="点击移除"
          @click="removeAttachedFile(i)"
        >
          📄 {{ f.name }}
        </span>
      </div>

      <div class="flex gap-2">
        <textarea
          v-model="inputText"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          rows="2"
          class="flex-1 px-2.5 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none resize-none"
          :disabled="loading.send || !currentConvId"
          @keydown="handleKeydown"
        />
        <button
          class="h-auto px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs rounded transition-colors shrink-0"
          :disabled="loading.send || !inputText.trim() || !currentConvId"
          @click="sendMessage"
        >
          {{ loading.send ? "..." : "发送" }}
        </button>
      </div>
    </div>
  </div>
</template>
