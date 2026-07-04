<script setup lang="ts">
import { ref, onMounted, computed, watch } from "vue";
import { useMaterialStore, type SuggestTagsResult } from "../stores/materialStore";

const props = defineProps<{
  content: string;
  sourceUrl?: string;
  sourceTitle?: string;
}>();

const emit = defineEmits<{
  close: [];
  saved: [materialId: string];
}>();

const store = useMaterialStore();

const step = ref<"analyzing" | "confirm" | "saving">("analyzing");
const aiResult = ref<SuggestTagsResult | null>(null);
const aiError = ref("");

// 已选标签 ID 集合（用 Set 便于 O(1) 查找 + 触发响应式）
const selectedTagIds = ref<Set<string>>(new Set());
// AI 建议的新标签（尚未创建的）
const newTagNames = ref<string[]>([]);
// 用户手动输入的自定义标签
const customTagInput = ref("");

// 监听 store.tags 变化：当标签被外部删除时，自动清理 selectedTagIds 中的无效 ID
watch(() => store.tags, (newTags) => {
  const validIds = new Set(newTags.map(t => t.id));
  let changed = false;
  const next = new Set(selectedTagIds.value);
  for (const id of selectedTagIds.value) {
    if (!validIds.has(id)) {
      next.delete(id);
      changed = true;
    }
  }
  if (changed) {
    selectedTagIds.value = next;
  }
}, { deep: true });

onMounted(async () => {
  // 每次打开对话框时强制从数据库加载最新标签（确保已删除的标签不会残留）
  try { await store.loadTags(); } catch { /* 忽略 */ }
  try {
    aiResult.value = await store.suggestTags(props.content);
    if (aiResult.value) {
      // 把 AI 匹配到的标签名解析为已存在标签的 ID（未匹配到的也保留为新标签名）
      for (const name of aiResult.value.matched_tags) {
        const existing = store.tags.find(t => t.name === name);
        if (existing) {
          selectedTagIds.value.add(existing.id);
        } else {
          newTagNames.value.push(name);
        }
      }
      // 合并 AI 建议新标签（去重）
      for (const name of aiResult.value.suggested_new_tags) {
        if (
          !newTagNames.value.includes(name) &&
          !store.tags.find(t => t.name === name)
        ) {
          newTagNames.value.push(name);
        }
      }
      // 触发响应式
      selectedTagIds.value = new Set(selectedTagIds.value);
    }
    step.value = "confirm";
  } catch (e) {
    aiError.value = String(e);
    aiResult.value = { matched_tags: [], suggested_new_tags: [] };
    step.value = "confirm";
  }
});

// ===== 操作函数 =====

function toggleExistingTag(tagId: string) {
  if (!tagId) return;
  const next = new Set(selectedTagIds.value);
  if (next.has(tagId)) next.delete(tagId);
  else next.add(tagId);
  selectedTagIds.value = next;
}

function removeNewTag(name: string) {
  const idx = newTagNames.value.indexOf(name);
  if (idx >= 0) newTagNames.value.splice(idx, 1);
}


function addCustomTag() {
  const name = customTagInput.value.trim();
  if (!name) return;
  // 已存在：直接选中
  const existing = store.tags.find(t => t.name === name);
  if (existing) {
    if (!selectedTagIds.value.has(existing.id)) {
      const next = new Set(selectedTagIds.value);
      next.add(existing.id);
      selectedTagIds.value = next;
    }
  } else if (!newTagNames.value.includes(name)) {
    newTagNames.value.push(name);
  }
  customTagInput.value = "";
}

function handleCustomKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    addCustomTag();
  }
}

// 总计
const totalSelected = computed(
  () => selectedTagIds.value.size + newTagNames.value.length
);

// AI 匹配标签解析后的展示数据：name + 是否为已存在标签
// 自动过滤"孤儿"项：标签已从 store 删除且不在建议新标签列表中的项
interface MatchedDisplay {
  name: string;
  isExisting: boolean;
  existingId: string;
}
const matchedDisplay = computed<MatchedDisplay[]>(() => {
  if (!aiResult.value) return [];
  return aiResult.value.matched_tags
    .map(name => {
      const existing = store.tags.find(t => t.name === name);
      return {
        name,
        isExisting: !!existing,
        existingId: existing?.id ?? "",
      };
    })
    .filter(item => item.isExisting || newTagNames.value.includes(item.name));
});

async function handleSave() {
  step.value = "saving";
  try {
    // 1. 先创建新标签，得到 ID 后并入 selectedTagIds
    const finalTagIds = new Set(selectedTagIds.value);
    for (const name of newTagNames.value) {
      try {
        const tag = await store.createTag(name);
        finalTagIds.add(tag.id);
      } catch (e) {
        // 标签已存在（其他路径创建）时，store 应复用
        console.warn("创建标签失败，跳过:", name, e);
      }
    }
    // 2. 保存素材
    const mat = await store.saveMaterial(
      props.content,
      props.sourceUrl,
      props.sourceTitle,
    );
    // 3. 绑定标签
    if (finalTagIds.size > 0) {
      await store.setMaterialTags(mat.id, Array.from(finalTagIds));
    }
    emit("saved", mat.id);
  } catch (e) {
    console.error("保存素材失败:", e);
    emit("close");
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[10001] flex items-center justify-center" @click.self="emit('close')">
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div class="relative w-full max-w-lg max-h-[80vh] bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl shadow-2xl flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <h2 class="text-sm font-semibold text-gray-800 dark:text-gray-200">存入素材库</h2>
          <button
            class="h-7 w-7 flex items-center justify-center rounded text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            @click="emit('close')"
          >✕</button>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <!-- 正在分析 -->
          <div v-if="step === 'analyzing'" class="flex items-center gap-3 py-6 justify-center">
            <span class="animate-spin text-blue-400 dark:text-blue-300">⏳</span>
            <span class="text-sm text-gray-600 dark:text-gray-400">AI 正在分析内容并匹配标签...</span>
          </div>

          <!-- 确认标签 -->
          <template v-if="step === 'confirm' || step === 'saving'">
            <!-- 素材预览 -->
            <div>
              <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">素材内容</h3>
              <div class="bg-gray-100/60 dark:bg-gray-800/50 border border-gray-300/50 dark:border-gray-700/50 rounded-lg px-3 py-2 text-xs text-gray-700 dark:text-gray-300 max-h-24 overflow-y-auto whitespace-pre-wrap">
                {{ content.slice(0, 200) }}{{ content.length > 200 ? '...' : '' }}
              </div>
            </div>

            <!-- 来源信息 -->
            <div v-if="sourceUrl || sourceTitle" class="text-[11px] text-gray-400 dark:text-gray-500">
              <span v-if="sourceTitle">来源：{{ sourceTitle }}</span>
              <span v-if="sourceUrl" class="ml-2 break-all">{{ sourceUrl }}</span>
            </div>

            <!-- AI 打标签错误 -->
            <div v-if="aiError" class="text-xs text-amber-600 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-950/20 border border-amber-300/50 dark:border-amber-800/30 rounded px-3 py-2">
              AI 标签分析失败：{{ aiError }}。将保存为无标签素材。
            </div>

            <!-- 1. AI 匹配标签（点击选择/取消） -->
            <div v-if="matchedDisplay.length > 0">
              <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
                AI 匹配标签 <span class="text-gray-500 dark:text-gray-600 normal-case">（点击选择/取消）</span>
              </h3>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="item in matchedDisplay"
                  :key="item.name"
                  class="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-full border transition-colors cursor-pointer select-none"
                  :class="(item.isExisting && selectedTagIds.has(item.existingId)) || (!item.isExisting && newTagNames.includes(item.name))
                    ? 'bg-blue-600/30 border-blue-500/50 text-blue-700 dark:text-blue-300'
                    : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-600'"
                  @click="item.isExisting ? toggleExistingTag(item.existingId) : removeNewTag(item.name)"
                >
                  {{ item.name }}
                </span>
              </div>
            </div>

            <!-- 2. 建议新标签（点击选择/取消） -->
            <div v-if="newTagNames.length > 0">
              <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
                建议新标签 <span class="text-gray-500 dark:text-gray-600 normal-case">（点击选择/取消）</span>
              </h3>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="name in newTagNames"
                  :key="name"
                  class="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-full bg-amber-100 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700/40 text-amber-700 dark:text-amber-300 cursor-pointer select-none hover:bg-amber-900/30 transition-colors"
                  @click="removeNewTag(name)"
                >
                  + {{ name }}
                </span>
              </div>
            </div>

            <!-- 3. 从已有标签中选择（绿色，点击切换） -->
            <div v-if="store.tags.length > 0">
              <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
                从已有标签中选择
                <span class="text-gray-500 dark:text-gray-600 normal-case">（{{ store.tags.length }} 个）</span>
              </h3>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="tag in store.tags"
                  :key="tag.id"
                  type="button"
                  class="px-2.5 py-1 text-[11px] rounded-full border transition-colors"
                  :class="selectedTagIds.has(tag.id)
                    ? 'bg-emerald-600/30 border-emerald-300 dark:border-emerald-500/50 text-emerald-700 dark:text-emerald-300'
                    : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300'"
                  @click="toggleExistingTag(tag.id)"
                >
                  {{ tag.name }}
                </button>
              </div>
            </div>

            <!-- 4. 自定义标签输入 -->
            <div>
              <h3 class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
                新增自定义标签
              </h3>
              <div class="flex items-center gap-2">
                <input
                  v-model="customTagInput"
                  type="text"
                  placeholder="输入标签名后回车"
                  maxlength="20"
                  class="flex-1 h-8 px-3 text-xs bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-gray-800 dark:text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  @keydown="handleCustomKeydown"
                />
                <button
                  type="button"
                  class="h-8 px-4 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded transition-colors disabled:opacity-50"
                  :disabled="!customTagInput.trim()"
                  @click="addCustomTag"
                >添加</button>
              </div>
            </div>
          </template>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800 shrink-0">
          <span class="text-[11px] text-gray-500 dark:text-gray-600">
            {{ step === 'analyzing' ? '正在分析...' : `已选 ${totalSelected} 个标签` }}
          </span>
          <div class="flex items-center gap-2">
            <button
              class="h-8 px-4 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
              :disabled="step === 'saving'"
              @click="emit('close')"
            >
              取消
            </button>
            <button
              class="h-8 px-5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors font-medium"
              :disabled="step !== 'confirm'"
              @click="handleSave"
            >
              {{ step === 'saving' ? '保存中...' : '确认存入' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
