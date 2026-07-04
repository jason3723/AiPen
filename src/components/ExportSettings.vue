<script setup lang="ts">
import { ref, watch } from "vue";
import { useExportSettingsStore } from "../stores/exportSettings";
import type { ExportSettings } from "../utils/exportWord";

const store = useExportSettingsStore();
const show = defineModel<boolean>("show", { default: false });
const local = ref<ExportSettings>({ ...store.settings });

// 弹窗打开时重新同步 local 与 store（适配切换文档后 store 变更）
watch(show, (val) => {
  if (val) {
    local.value = { ...store.settings };
  }
});

// ── 字体选项 ──
const fontOptions = [
  '方正小标宋简体', '方正黑体简体', '方正楷体简体', '方正仿宋简体',
  '宋体', '黑体', '楷体', '仿宋', '微软雅黑', 'Times New Roman',
];

// ── 字号选项（中文号数制 → pt）── 与编辑器工具栏一致 ──
const fontSizeOptions = [
  { label: '一号', pt: 26 },
  { label: '小一', pt: 24 },
  { label: '二号', pt: 22 },
  { label: '小二', pt: 18 },
  { label: '三号', pt: 16 },
  { label: '小三', pt: 15 },
  { label: '四号', pt: 14 },
  { label: '小四', pt: 12 },
  { label: '五号', pt: 10.5 },
  { label: '小五', pt: 9 },
];

function apply() {
  store.update(local.value);
  show.value = false;
}

function cancel() {
  local.value = { ...store.settings };
  show.value = false;
}

// 通用样式
const selFont = 'h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-1.5 text-[11px] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500 flex-1 min-w-0 appearance-none';
const selSize = 'h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-1 text-[11px] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500 w-14 shrink-0 text-center appearance-none';
const labelSm = 'text-[10px] text-gray-400 dark:text-gray-500 shrink-0';
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md"
      @click.self="cancel"
    >
      <div class="bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl shadow-2xl w-[560px] max-h-[80vh] overflow-hidden flex flex-col">
        <!-- 标题栏 -->
        <div class="flex items-center justify-between px-5 py-3 border-b border-gray-300 dark:border-gray-700">
          <h3 class="text-sm font-semibold text-gray-800 dark:text-gray-200">导出 Word 设置</h3>
          <button
            class="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-lg leading-none"
            @click="cancel"
          >&times;</button>
        </div>

        <!-- 内容区 -->
        <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <!-- 字体设置 -->
          <section>
            <h4 class="text-xs font-semibold text-blue-400 dark:text-blue-300 mb-3 uppercase tracking-wider">字体</h4>
            <div class="space-y-2">
              <!-- H1 -->
              <div class="flex items-center gap-1.5">
                <span class="text-[11px] text-gray-400 dark:text-gray-500 w-6 shrink-0">H1</span>
                <span :class="labelSm">字体</span>
                <select v-model="local.fontH1" :class="selFont">
                  <option v-for="f in fontOptions" :key="f" :value="f" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ f }}</option>
                </select>
                <span :class="labelSm">字号</span>
                <select v-model.number="local.sizeH1" :class="selSize">
                  <option v-for="s in fontSizeOptions" :key="s.label" :value="s.pt" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ s.label }}</option>
                </select>
                <span :class="labelSm">加粗</span>
                <label class="flex items-center cursor-pointer select-none shrink-0">
                  <input type="checkbox" v-model="local.boldH1" class="sr-only" />
                  <span class="w-8 h-5 rounded-full transition-colors inline-flex items-center px-0.5" :class="local.boldH1 ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'">
                    <span class="w-3 h-3 bg-white rounded-full transition-transform" :class="local.boldH1 ? 'translate-x-4' : 'translate-x-0'" />
                  </span>
                </label>
              </div>

              <!-- H2 -->
              <div class="flex items-center gap-1.5">
                <span class="text-[11px] text-gray-400 dark:text-gray-500 w-6 shrink-0">H2</span>
                <span :class="labelSm">字体</span>
                <select v-model="local.fontH2" :class="selFont">
                  <option v-for="f in fontOptions" :key="f" :value="f" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ f }}</option>
                </select>
                <span :class="labelSm">字号</span>
                <select v-model.number="local.sizeH2" :class="selSize">
                  <option v-for="s in fontSizeOptions" :key="s.label" :value="s.pt" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ s.label }}</option>
                </select>
                <span :class="labelSm">加粗</span>
                <label class="flex items-center cursor-pointer select-none shrink-0">
                  <input type="checkbox" v-model="local.boldH2" class="sr-only" />
                  <span class="w-8 h-5 rounded-full transition-colors inline-flex items-center px-0.5" :class="local.boldH2 ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'">
                    <span class="w-3 h-3 bg-white rounded-full transition-transform" :class="local.boldH2 ? 'translate-x-4' : 'translate-x-0'" />
                  </span>
                </label>
              </div>

              <!-- H3 -->
              <div class="flex items-center gap-1.5">
                <span class="text-[11px] text-gray-400 dark:text-gray-500 w-6 shrink-0">H3</span>
                <span :class="labelSm">字体</span>
                <select v-model="local.fontH3" :class="selFont">
                  <option v-for="f in fontOptions" :key="f" :value="f" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ f }}</option>
                </select>
                <span :class="labelSm">字号</span>
                <select v-model.number="local.sizeH3" :class="selSize">
                  <option v-for="s in fontSizeOptions" :key="s.label" :value="s.pt" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ s.label }}</option>
                </select>
                <span :class="labelSm">加粗</span>
                <label class="flex items-center cursor-pointer select-none shrink-0">
                  <input type="checkbox" v-model="local.boldH3" class="sr-only" />
                  <span class="w-8 h-5 rounded-full transition-colors inline-flex items-center px-0.5" :class="local.boldH3 ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'">
                    <span class="w-3 h-3 bg-white rounded-full transition-transform" :class="local.boldH3 ? 'translate-x-4' : 'translate-x-0'" />
                  </span>
                </label>
              </div>

              <!-- H4 -->
              <div class="flex items-center gap-1.5">
                <span class="text-[11px] text-gray-400 dark:text-gray-500 w-6 shrink-0">H4</span>
                <span :class="labelSm">字体</span>
                <select v-model="local.fontH4" :class="selFont">
                  <option v-for="f in fontOptions" :key="f" :value="f" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ f }}</option>
                </select>
                <span :class="labelSm">字号</span>
                <select v-model.number="local.sizeH4" :class="selSize">
                  <option v-for="s in fontSizeOptions" :key="s.label" :value="s.pt" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ s.label }}</option>
                </select>
                <span :class="labelSm">加粗</span>
                <label class="flex items-center cursor-pointer select-none shrink-0">
                  <input type="checkbox" v-model="local.boldH4" class="sr-only" />
                  <span class="w-8 h-5 rounded-full transition-colors inline-flex items-center px-0.5" :class="local.boldH4 ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'">
                    <span class="w-3 h-3 bg-white rounded-full transition-transform" :class="local.boldH4 ? 'translate-x-4' : 'translate-x-0'" />
                  </span>
                </label>
              </div>

              <!-- 正文 -->
              <div class="flex items-center gap-1.5">
                <span class="text-[11px] text-gray-400 dark:text-gray-500 w-6 shrink-0">正文</span>
                <span :class="labelSm">字体</span>
                <select v-model="local.fontBody" :class="selFont">
                  <option v-for="f in fontOptions" :key="f" :value="f" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ f }}</option>
                </select>
                <span :class="labelSm">字号</span>
                <select v-model.number="local.sizeBody" :class="selSize">
                  <option v-for="s in fontSizeOptions" :key="s.label" :value="s.pt" class="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200">{{ s.label }}</option>
                </select>
                <span :class="labelSm">加粗</span>
                <label class="flex items-center cursor-pointer select-none shrink-0">
                  <input type="checkbox" v-model="local.boldBody" class="sr-only" />
                  <span class="w-8 h-5 rounded-full transition-colors inline-flex items-center px-0.5" :class="local.boldBody ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'">
                    <span class="w-3 h-3 bg-white rounded-full transition-transform" :class="local.boldBody ? 'translate-x-4' : 'translate-x-0'" />
                  </span>
                </label>
              </div>
            </div>
          </section>

          <!-- 页面设置 -->
          <section>
            <h4 class="text-xs font-semibold text-blue-400 dark:text-blue-300 mb-3 uppercase tracking-wider">页面边距 (mm)</h4>
            <div class="grid grid-cols-4 gap-3">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">上</span>
                <input
                  v-model.number="local.marginTop"
                  type="number" step="0.1" min="0" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">下</span>
                <input
                  v-model.number="local.marginBottom"
                  type="number" step="0.1" min="0" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">左</span>
                <input
                  v-model.number="local.marginLeft"
                  type="number" step="0.1" min="0" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">右</span>
                <input
                  v-model.number="local.marginRight"
                  type="number" step="0.1" min="0" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
            </div>
          </section>

          <!-- 文档网格 & 段落 -->
          <section>
            <h4 class="text-xs font-semibold text-blue-400 dark:text-blue-300 mb-3 uppercase tracking-wider">文档网格 &amp; 段落</h4>
            <div class="grid grid-cols-3 gap-3">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">每行字数</span>
                <input
                  v-model.number="local.charsPerLine"
                  type="number" min="1" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">每页行数</span>
                <input
                  v-model.number="local.linesPerPage"
                  type="number" min="1" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">行间距 (pt)</span>
                <input
                  v-model.number="local.lineSpacingPt"
                  type="number" step="0.5" min="1" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
            </div>
          </section>

          <!-- 距边界 -->
          <section>
            <h4 class="text-xs font-semibold text-blue-400 dark:text-blue-300 mb-3 uppercase tracking-wider">距边界 (mm)</h4>
            <div class="flex gap-3">
              <label class="flex flex-col gap-1 flex-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">页眉</span>
                <input
                  v-model.number="local.headerMargin"
                  type="number" step="0.1" min="0" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1 flex-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">页脚</span>
                <input
                  v-model.number="local.footerMargin"
                  type="number" step="0.1" min="0" max="100"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
            </div>
          </section>

          <!-- 表格 -->
          <section>
            <h4 class="text-xs font-semibold text-blue-400 dark:text-blue-300 mb-3 uppercase tracking-wider">表格 · 单元格边距 (mm)</h4>
            <div class="grid grid-cols-4 gap-3">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">上</span>
                <input
                  v-model.number="local.cellMarginTop"
                  type="number" step="0.1" min="0" max="50"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">下</span>
                <input
                  v-model.number="local.cellMarginBottom"
                  type="number" step="0.1" min="0" max="50"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">左</span>
                <input
                  v-model.number="local.cellMarginLeft"
                  type="number" step="0.1" min="0" max="50"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-gray-400 dark:text-gray-500">右</span>
                <input
                  v-model.number="local.cellMarginRight"
                  type="number" step="0.1" min="0" max="50"
                  class="h-7 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </label>
            </div>
          </section>
        </div>

        <!-- 底部按钮 -->
        <div class="flex items-center justify-between px-5 py-3 border-t border-gray-300 dark:border-gray-700">
          <button
            class="text-xs text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            @click="store.reset(); local = { ...store.settings }"
          >
            恢复默认
          </button>
          <div class="flex items-center gap-2">
            <button
              class="h-7 px-4 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 text-xs rounded transition-colors"
              @click="cancel"
            >
              取消
            </button>
            <button
              class="h-7 px-4 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors"
              @click="apply"
            >
              应用
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
