<script setup lang="ts">
import { ref, watch, computed, nextTick, onMounted, onBeforeUnmount } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import RichEditor from "../components/RichEditor.vue";
import VersionList from "../components/VersionList.vue";
import DiffViewer from "../components/DiffViewer.vue";
import AIPanel from "../components/AIPanel.vue";
import ApiSettings from "../components/ApiSettings.vue";
import ExportSettings from "../components/ExportSettings.vue";
import ChatPanel from "../components/ChatPanel.vue";
import SkillPanel from "../components/SkillPanel.vue";
import KnowledgePanel from "../components/KnowledgePanel.vue";
import ComposeLauncher from "../components/ComposeLauncher.vue";
import ComposeWorkbench from "../components/ComposeWorkbench.vue";
import type { ComposeRecipe, ComposeProgress, ComposePhase } from "../types/compose";
import { useDocumentStore } from "../stores/document";
import { useExportSettingsStore } from "../stores/exportSettings";
import { useMaterialStore } from "../stores/materialStore";
import { storeToRefs } from "pinia";
import { exportToWord } from "../utils/exportWord";
import { useConfirm } from "../composables/useConfirm";
import { computeDiff } from "../utils/diff";
import { textToDocJson } from "../utils/textToDocJson";
import MaterialPanel from "../components/MaterialPanel.vue";
import MaterialClipDialog from "../components/MaterialClipDialog.vue";
import { useTheme } from "../stores/theme";

const { confirm } = useConfirm();
const { isDark, toggleTheme } = useTheme();

// ── 应用版本 ──
const appVersion = "3.0.0";

const store = useDocumentStore();
const exportSettingsStore = useExportSettingsStore();
const materialStore = useMaterialStore();
const {
  documents,
  currentContent,
  currentTitle,
  loading,
  error,
  sidebarTab,
  viewingVersionLabel,
  isViewingHistory,
  injectedChatText,
  dataVersion,
  apiConfig,
  documentScore,
  scoreLoading,
  folders,
  currentFolderFilter,
  filteredDocuments,
  draftSaveStatus,
  lastSaveTime,
} = storeToRefs(store);

// ── AI 状态标签 ──
const modelLabel = computed(() => apiConfig.value.model.includes("pro") ? "Pro" : "Flash");
const thinkingLabel = computed(() => apiConfig.value.thinking_enabled ? "Thinking" : "Direct");
const effortLabel = computed(() => apiConfig.value.reasoning_effort === "max" ? "max" : "high");

/** 从 ProseMirror JSON 文档提取纯文本（供 ChatPanel / SkillPanel 等需要字符串的组件使用） */
const documentPlainText = computed(() => {
  const c = currentContent.value;
  if (typeof c === 'string') return c;
  if (c && c.content) {
    return extractDocText(c);
  }
  return '';
});

function extractDocText(node: any): string {
  if (node.type === 'text') return node.text || '';
  if (node.content) return node.content.map((n: any) => extractDocText(n)).join('');
  return '';
}

watch(dataVersion, () => {
  store.reloadDocuments();
  materialStore.init();
});
const commitMsg = ref("");
const editingTitle = ref(false);
const titleInput = ref("");

// ── 侧栏折叠 ──
const leftCollapsed = ref(false);
const rightCollapsed = ref(false);

// ── 侧栏右键菜单 ──
const ctxMenu = ref<{ show: boolean; x: number; y: number }>({ show: false, x: 0, y: 0 });
function onSidebarContextMenu(event: MouseEvent) {
  event.preventDefault();
  ctxMenu.value = { show: true, x: event.clientX, y: event.clientY };
}
function onClickAwayContextMenu() {
  ctxMenu.value.show = false;
}
function handleReload() {
  ctxMenu.value.show = false;
  location.reload();
}

// ── 关于软件弹窗 ──
const showAbout = ref(false);
function handleShowAbout() {
  ctxMenu.value.show = false;
  showAbout.value = true;
}
const aboutCanvasRef = ref<HTMLCanvasElement | null>(null);
let _aboutAnimId = 0;

function startStarfield(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const stars: { x: number; y: number; r: number; v: number; a: number }[] = [];
  const STAR_COUNT = 150;

  function resize() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 2 + 0.5,
      v: Math.random() * 0.3 + 0.1,
      a: Math.random(),
    });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 深空背景渐变
    const bg = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width * 0.7);
    bg.addColorStop(0, "rgba(20,30,80,0.4)");
    bg.addColorStop(1, "rgba(5,5,25,0.95)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const s of stars) {
      s.a += s.v * 0.02;
      const alpha = 0.4 + 0.6 * Math.sin(s.a);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fill();
      // 亮星加光晕
      if (s.r > 1.2 && alpha > 0.8) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180,200,255,${alpha * 0.15})`;
        ctx.fill();
      }
    }

    // 偶尔划过一颗流星
    if (Math.random() < 0.008) {
      const mx = Math.random() * canvas.width;
      const my = Math.random() * canvas.height * 0.5;
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx - 80, my + 40);
      ctx.stroke();
    }

    _aboutAnimId = requestAnimationFrame(draw);
  }
  draw();
}

function stopStarfield() {
  if (_aboutAnimId) cancelAnimationFrame(_aboutAnimId);
  window.removeEventListener("resize", () => {});
}

watch(showAbout, (v) => {
  if (v) {
    nextTick(() => {
      if (aboutCanvasRef.value) startStarfield(aboutCanvasRef.value);
    });
  } else {
    stopStarfield();
  }
});

// ── 左栏 Sub-Tab + 编辑器状态机 ──
const leftSubTab = ref<'docs' | 'materials' | 'browser'>('docs');

// 编辑模式：document → 编辑本机文档；material → 浏览/编辑素材；webview → 浏览器
const isViewingTagDoc = computed(() => !!materialStore.currentTagDocumentId);
const editMode = computed(() => {
  if (leftSubTab.value === 'browser') return 'webview' as const;
  if (leftSubTab.value === 'materials' && (materialStore.currentMaterialId || materialStore.currentTagDocumentId)) return 'material' as const;
  return 'document' as const;
});
/** 传给 Editor 组件的 editMode（排除 webview，此时组件不渲染） */
const editorEditMode = computed(() => editMode.value === 'webview' ? undefined : editMode.value);

// 编辑器显示内容：根据模式切换来源
const displayedContent = computed({
  get() {
    if (editMode.value === 'material' && (materialStore.currentMaterialId || materialStore.currentTagDocumentId)) {
      return materialStore.currentMaterialContent;
    }
    if (editMode.value === 'webview') return '';
    return currentContent.value;
  },
  set(v: any) {
    if (editMode.value === 'material' && materialStore.currentMaterialId) {
      materialStore.currentMaterialContent = v;
    } else if (editMode.value === 'document') {
      store.currentContent = v;
    }
  },
});

// 从文档模式切换到其他模式时，自动保存草稿
watch(leftSubTab, async (_newTab, oldTab) => {
  if (oldTab === 'docs' && currentContent.value && store.currentDocId) {
    try {
      await invoke("save_draft", {
        docId: store.currentDocId,
        content: JSON.stringify(currentContent.value),
      });
    } catch { /* 忽略 */ }
  }
  // 切换离开素材 tab 时，清除标签文档选中状态
  if (_newTab !== 'materials') {
    materialStore.currentTagDocumentId = null;
  }
  // 初始化素材库数据
  if (_newTab === 'materials' || _newTab === 'browser') {
    materialStore.init();
  }
});

// 素材模式下，内容变更时自动保存
let _materialSaveTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => materialStore.currentMaterialContent,
  (v) => {
    if (editMode.value !== 'material' || !materialStore.currentMaterialId) return;
    if (isViewingTagDoc.value) return; // 标签文档是虚拟文档，不自动保存
    if (_materialSaveTimer) clearTimeout(_materialSaveTimer);
    _materialSaveTimer = setTimeout(async () => {
      try {
        await materialStore.updateMaterialContent(materialStore.currentMaterialId!, v);
      } catch { /* 忽略 */ }
    }, 1000);
  },
);

// ── 素材剪藏弹窗（状态在 materialStore 中，Editor.vue 直接写入） ──
const { clipText, clipSourceUrl, clipSourceTitle, showClipDialog } = storeToRefs(materialStore);

function handleClipSaved(_matId: string) {
  materialStore.closeClipDialog();
  browserManuallyHidden.value = false;
  if (browserOpen.value) {
    invoke("show_browser").catch(() => {});
  }
}

// 取消剪藏弹窗时，恢复浏览器窗口显示
function handleClipClose() {
  materialStore.closeClipDialog();
  browserManuallyHidden.value = false;
  if (browserOpen.value) {
    invoke("show_browser").catch(() => {});
  }
}

// 处理浏览器剪藏（emit 和 eval 通道共用）
function handleBrowserClip(text: string, url?: string, title?: string) {
  if (!text) return;
  // 隐藏浏览器窗口，使素材剪藏弹窗可见（浏览器 always_on_top 会遮挡主窗口）
  if (browserOpen.value) {
    browserManuallyHidden.value = true;
    invoke("hide_browser").catch(() => {});
  }
  materialStore.openClipDialog(text, url, title);
}

// ── 素材面板事件 ──
function handleMaterialPanelUpdate(action: string, ...args: any[]) {
  switch (action) {
    case 'insertToChat':
      store.injectedChatText = args[0] as string;
      store.sidebarTab = 'chat';
      break;
    case 'openBrowser':
      if (args[0]) handleOpenBrowser(args[0] as string);
      break;
  }
}

function handleMaterialSelect(matId: string) {
  materialStore.selectMaterial(matId);
  leftSubTab.value = 'materials';
}

function handleTagDocSelect(tagId: string | null) {
  materialStore.selectTagDocument(tagId);
  leftSubTab.value = 'materials';
}

// ── 编辑器素材模式操作 ──
function handleEditorInsertToChat(text: string) {
  store.injectedChatText = text;
  store.sidebarTab = 'chat';
}

/** 在标签视图中根据选中位置查找所属素材 */
function findMaterialInTagView(selectionStart: number): string | null {
  // 单素材视图不适用
  if (materialStore.currentMaterialId) return null;
  // 通过 ProseMirror 文档结构定位卡片
  const doc = richEditorRef.value?.getPMJson?.();
  if (!doc) return null;
  return materialStore.resolveDocPositionToMaterial(doc, selectionStart);
}

async function handleEditorDeleteMaterial(selectionStart: number) {
  // 单素材视图：直接删除
  if (materialStore.currentMaterialId) {
    await materialStore.deleteMaterial(materialStore.currentMaterialId);
    return;
  }
  // 标签视图：根据选中位置找到素材并删除，然后刷新视图
  const matId = findMaterialInTagView(selectionStart);
  if (!matId) return;
  await materialStore.deleteMaterial(matId);
  // 刷新标签视图内容
  refreshTagView();
}

async function handleEditorRemoveFromTag(selectionStart: number) {
  const tagId = materialStore.currentTagDocumentId === "__uncategorized__"
    ? null
    : materialStore.currentTagDocumentId;
  if (!tagId) return; // 未分类不可操作
  const matId = findMaterialInTagView(selectionStart);
  if (!matId) return;
  const mat = materialStore.materials.find(m => m.id === matId);
  if (!mat) return;
  const newTagIds = mat.tags.filter(t => t.id !== tagId).map(t => t.id);
  await materialStore.setMaterialTags(matId, newTagIds);
  // 刷新标签视图内容（该素材已从当前标签移除）
  refreshTagView();
}

/** 刷新当前标签视图内容，若标签已无素材则退回列表 */
function refreshTagView() {
  const tagId = materialStore.currentTagDocumentId === "__uncategorized__" ? null : materialStore.currentTagDocumentId;
  if (!tagId) {
    materialStore.currentTagDocumentId = null;
    materialStore.currentMaterialContent = "";
    return;
  }
  const group = materialStore.tagDocumentGroups.find(g => g.tag?.id === tagId);
  if (group && group.materials.length > 0) {
    materialStore.selectTagDocument(tagId);
  } else {
    // 标签下没有素材了，退回列表
    materialStore.currentTagDocumentId = null;
    materialStore.currentMaterialContent = "";
  }
}

// ── 浏览器嵌入式窗口 ──
const browserOpen = ref(false);
const browserUrl = ref("");
const browserUrlInput = ref("");
const mainAreaRef = ref<HTMLElement | null>(null);
const browserAddressBarRef = ref<HTMLElement | null>(null);
// 标记浏览器被手动隐藏（剪藏弹窗/退出确认时），防止 onFocusChanged 自动重新显示
const browserManuallyHidden = ref(false);

function getBrowserViewportRect(): { x: number; y: number; width: number; height: number } | null {
  const el = mainAreaRef.value;
  const bar = browserAddressBarRef.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const barHeight = bar ? bar.getBoundingClientRect().height : 0;
  return {
    x: rect.left,
    y: rect.top + barHeight,
    width: rect.width,
    height: Math.max(0, rect.height - barHeight),
  };
}

async function handleOpenBrowser(url: string) {
  const normalized = normalizeUrl(url);
  browserUrlInput.value = normalized;
  try {
    if (browserOpen.value) {
      // 浏览器已存在（可能处于隐藏状态），先恢复显示并重定位
      const vp = getBrowserViewportRect();
      if (vp) {
        await invoke("resize_browser_webview", { x: vp.x, y: vp.y, width: vp.width, height: vp.height });
      }
      await invoke("show_browser");
      await invoke("navigate_browser", { url: normalized });
    } else {
      const vp = getBrowserViewportRect();
      if (!vp) return;
      await invoke("create_browser_webview", {
        url: normalized,
        x: vp.x,
        y: vp.y,
        width: vp.width,
        height: vp.height,
      });
      browserOpen.value = true;
      browserManuallyHidden.value = false;
    }
    browserUrl.value = normalized;
  } catch (e) {
    console.error("浏览器操作失败:", e);
  }
}

function normalizeUrl(input: string): string {
  if (!input) return "";
  // 已有协议头，直接返回
  if (/^https?:\/\//i.test(input)) return input;
  // 自动补 https://
  return "https://" + input;
}

async function handleAddressBarNavigate() {
  const url = normalizeUrl(browserUrlInput.value.trim());
  if (!url) return;
  browserUrlInput.value = url;
  if (browserOpen.value) {
    try {
      await invoke("navigate_browser", { url });
      browserUrl.value = url;
    } catch (e) {
      console.error("导航失败:", e);
    }
  } else {
    handleOpenBrowser(url);
  }
}

async function handleBrowserBack() {
  try { await invoke("navigate_browser_back"); } catch (e) { console.error(e); }
}

async function handleBrowserForward() {
  try { await invoke("navigate_browser_forward"); } catch (e) { console.error(e); }
}

async function handleBrowserRefresh() {
  try { await invoke("navigate_browser_refresh"); } catch (e) { console.error(e); }
}

async function handleBrowserDestroy() {
  try {
    await invoke("close_browser");
    browserOpen.value = false;
    browserManuallyHidden.value = false;
  } catch { /* 忽略 */ }
}

// 切换 Tab 时隐藏/显示浏览器（保留 webview 状态，不销毁）
watch(leftSubTab, async (tab) => {
  if (!browserOpen.value) return;
  try {
    if (tab !== 'browser') {
      await invoke("hide_browser");
    } else {
      // 切回浏览器 tab，先 resize 再 show（窗口可能变过大小/位置）
      const vp = getBrowserViewportRect();
      if (vp) {
        await invoke("resize_browser_webview", { x: vp.x, y: vp.y, width: vp.width, height: vp.height });
      }
      await invoke("show_browser");
    }
  } catch { /* 忽略 */ }
});

// 浏览器打开时，窗口大小变化 → 重新定位 webview
function onBrowserResize() {
  if (!browserOpen.value) return;
  const vp = getBrowserViewportRect();
  if (!vp) return;
  // 通过 invoke 通知后端同步重定位
  invoke("resize_browser_webview", { x: vp.x, y: vp.y, width: vp.width, height: vp.height }).catch(() => {});
}

// ── 评分弹窗 ──
const scorePopoverShow = ref(false);

// ── 文件夹筛选下拉 & 新建文档下拉 & 移动弹窗 ──
const showFolderFilterDropdown = ref(false);
const folderFilterBtnRef = ref<HTMLElement | null>(null);
const folderFilterDropdownStyle = computed(() => {
  const el = folderFilterBtnRef.value;
  if (!el) return { left: '0px', top: '0px' };
  const rect = el.getBoundingClientRect();
  return { left: rect.left + 'px', top: (rect.bottom + 4) + 'px' };
});
const showMoveDocModal = ref(false);
const moveDocTarget = ref<{ id: string; title: string } | null>(null);
const moveDocNewFolderName = ref("");
const moveDocSelectedFolderId = ref("");

function handleScoreDocument() {
  store.scoreDocument();
}
function scoreBadgeColor(score: number): string {
  if (score >= 85) return 'bg-amber-400/25 text-gray-800 dark:text-gray-200'
  if (score >= 75) return 'bg-emerald-400/25 text-gray-800 dark:text-gray-200'
  if (score >= 65) return 'bg-sky-400/25 text-gray-800 dark:text-gray-200'
  if (score >= 55) return 'bg-gray-400/25 text-gray-800 dark:text-gray-200'
  return 'bg-rose-400/25 text-gray-800 dark:text-gray-200'
}
function scoreTextColor(score: number): string {
  if (score >= 85) return 'text-amber-600 dark:text-amber-300'
  if (score >= 75) return 'text-emerald-600 dark:text-emerald-300'
  if (score >= 65) return 'text-sky-600 dark:text-sky-300'
  if (score >= 55) return 'text-gray-600 dark:text-gray-300'
  return 'text-rose-600 dark:text-rose-300'
}
function scoreBarColor(score: number): string {
  if (score >= 85) return 'bg-amber-400'
  if (score >= 75) return 'bg-emerald-400'
  if (score >= 65) return 'bg-sky-400'
  if (score >= 55) return 'bg-gray-400'
  return 'bg-rose-400'
}
function scoreStars(score: number): string {
  if (score >= 90) return '⭐'.repeat(5)
  if (score >= 80) return '⭐'.repeat(4) + '☆'
  if (score >= 70) return '⭐'.repeat(3) + '☆'.repeat(2)
  if (score >= 55) return '⭐'.repeat(2) + '☆'.repeat(3)
  return '⭐' + '☆'.repeat(4)
}
function scoreTagline(score: number): string {
  if (score >= 90) return '太棒了！'
  if (score >= 80) return '非常优秀！'
  if (score >= 70) return '良好，继续提升！'
  if (score >= 55) return '还需打磨'
  return '需要大改'
}

// ── 编辑器引用 & 选中文本 ──
const richEditorRef = ref<InstanceType<typeof RichEditor>>();
const selectedText = ref("");

function getSelectedText() {
  if (richEditorRef.value?.getSelectedText) {
    selectedText.value = richEditorRef.value.getSelectedText();
  }
}

// 切换到「技能」tab 时，主动捕获编辑器选中文本（避免失焦丢失）
watch(sidebarTab, (tab) => {
  if (tab === "skills") getSelectedText();
});

// ── 智能写作 ──
const composeActive = ref(false);
const composeRecipe = ref<ComposeRecipe | null>(null);
const composeProgress = ref<ComposeProgress | null>(null);
const workbenchRef = ref<InstanceType<typeof ComposeWorkbench> | null>(null);

const composePhase = computed(() => composeProgress.value?.phase as ComposePhase | null);
const isWritingPhase = computed(() => {
  const p = composePhase.value;
  return p === 'generating' || p === 'reviewing' || p === 'polishing';
});

const progressPhaseColor = computed(() => {
  const p = composePhase.value;
  if (p === 'generating') return 'emerald';
  if (p === 'reviewing') return 'amber';
  if (p === 'polishing') return 'purple';
  if (p === 'outline_generating') return 'violet';
  return 'gray';
});

const reviewStatusText = computed(() => {
  const p = composeProgress.value;
  if (!p || !p.reviewSkillLabel) return '';
  const isReviewOrPolish = p.phase === 'reviewing' || p.phase === 'polishing';
  if (!isReviewOrPolish) return '';
  const label = p.phase === 'polishing' ? (p.stageLabel || p.reviewSkillLabel) : p.reviewSkillLabel;
  const count = p.reviewFindingsCount ?? -1;
  const fixed = p.reviewFixedCount ?? 0;
  // 润色阶段的特殊状态（仿审查阶段：审查中 → 发现 X 处 → 修正中 → 完成）
  if (p.phase === 'polishing' && count === -1 && fixed === -1) return `${label} · 正在审查...`;
  if (p.phase === 'polishing' && count > 0 && fixed === 0) return `${label} · 发现 ${count} 处可改进点`;
  if (p.phase === 'polishing' && count > 0 && fixed === -1) return `${label} · 发现 ${count} 处可改进点 · 正在修正...`;
  if (p.phase === 'polishing' && fixed >= count) return `${label} · 润色完成 ✓`;
  if (p.phase === 'polishing' && count === 0 && fixed === 0) return `${label} · 无需润色 ✓`;
  if (p.phase === 'polishing' && fixed === -2) return `${label} · 执行失败`;
  // 审查阶段状态
  if (count === -1) return `${label} · 正在检查...`;
  if (fixed === -1) return `${label} · 发现 ${count} 个问题 · 正在修复...`;
  if (fixed === -2) return `${label} · 执行失败`;
  if (count === 0) return `${label} · 没有问题`;
  if (fixed >= count) return `${label} · 发现 ${count} 个问题 · 已全修复 ✓`;
  return `${label} · 发现 ${count} 个问题 · 已修复 ${fixed} 个`;
});

async function handleComposeStart(recipe: ComposeRecipe) {
  // 守卫：创作进行中，禁止重复触发
  if (composeActive.value) return;
  // 新建文件，保持编辑器空白
  await store.createNewDocument(recipe.name);
  // createNewDocument 内部调用 switchDocument 会把 tab 切到「版本」，
  // 这里强制切回「写作」tab
  sidebarTab.value = 'compose';
  composeRecipe.value = recipe;
  composeActive.value = true;
  composeProgress.value = null;
}

function handleComposeDone(content: string) {
  diffPlaybackAbort = true
  if (content) {
    try {
      const parsed = JSON.parse(content)
      if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
        store.currentContent = parsed
      } else {
        // 非文档 JSON → 按段落拆分
        store.currentContent = textToDocJson(String(parsed))
      }
    } catch {
      // 纯文本 → 按双换行拆分为多个段落节点
      store.currentContent = textToDocJson(content)
    }
  }
  composeActive.value = false;
  composeRecipe.value = null;
  // 保留卡片中的「创建成功」提示 5 秒后再清除
  setTimeout(() => {
    composeProgress.value = null;
  }, 5000);
}

async function handleRequestClose() {
  const ok = await confirm({
    title: "结束写作任务",
    message: "确定要结束本次写作任务吗？\n\n已生成的内容将保留在编辑器中，您可以继续编辑。",
    kind: "info",
    okLabel: "结束任务",
    cancelLabel: "继续写作",
  });
  if (ok) {
    diffPlaybackAbort = true
    composeActive.value = false;
    composeRecipe.value = null;
    composeProgress.value = null;
  }
}

function scrollEditor() {
  nextTick(() => {
    const el = document.querySelector('.rich-content') as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// ── 串行化 diff_playback 避免并发竞态 ──
let diffPlaybackQueue: Promise<void> = Promise.resolve()

function handleStream(
  payload:
    | { type: 'append' | 'replace'; text: string }
    | { type: 'diff_playback'; oldText: string; newText: string },
) {
  if (payload.type === 'diff_playback') {
    // 取消上一次回放，等它真正终止后启动新的
    diffPlaybackAbort = true
    diffPlaybackQueue = diffPlaybackQueue.then(async () => {
      diffPlaybackAbort = false
      await handleDiffPlayback(payload.oldText, payload.newText)
    })
    return
  }
  if (payload.type === 'replace') {
    // 替换整个文档内容，按双换行拆分为多个段落
    store.currentContent = textToDocJson(payload.text)
    // 替换后滚到顶部，方便用户从头审视修改
    nextTick(() => {
      const el = document.querySelector('.rich-content') as HTMLElement | null;
      if (el) el.scrollTop = 0;
    });
  } else {
    // 增量追加：检测双换行，自动拆分段落
    const current = store.currentContent
    if (current && typeof current === 'object' && current.type === 'doc') {
      const newDoc = JSON.parse(JSON.stringify(current))
      const lastIdx = newDoc.content.length - 1

      // 获取最后一个段落的完整文本 + 新 token
      let lastText = ''
      if (lastIdx >= 0 && newDoc.content[lastIdx].type === 'paragraph') {
        const texts = newDoc.content[lastIdx].content || []
        lastText = texts.map((t: any) => t.text || '').join('')
      }
      const combined = lastText + payload.text

      // 按双换行拆分：第一部分回填到最后段落，后续创建新段落
      const parts = combined.split(/\n{2,}/)
      if (parts.length === 1) {
        // 无段落分隔 → 追加到最后一个段落
        if (lastIdx >= 0 && newDoc.content[lastIdx].type === 'paragraph') {
          if (!newDoc.content[lastIdx].content) newDoc.content[lastIdx].content = []
          const lastTextNode = newDoc.content[lastIdx].content[newDoc.content[lastIdx].content.length - 1]
          if (lastTextNode && lastTextNode.type === 'text') {
            lastTextNode.text = parts[0]
          } else {
            newDoc.content[lastIdx].content.push({ type: 'text', text: parts[0] })
          }
        } else {
          newDoc.content.push({ type: 'paragraph', content: [{ type: 'text', text: parts[0] }] })
        }
      } else {
        // 有段落分隔 → 更新最后一段 + 新增段落
        if (lastIdx >= 0 && newDoc.content[lastIdx].type === 'paragraph') {
          if (!newDoc.content[lastIdx].content) newDoc.content[lastIdx].content = []
          const lastTextNode = newDoc.content[lastIdx].content[newDoc.content[lastIdx].content.length - 1]
          if (lastTextNode && lastTextNode.type === 'text') {
            lastTextNode.text = parts[0]
          } else {
            newDoc.content[lastIdx].content = [{ type: 'text', text: parts[0] }]
          }
        } else {
          newDoc.content.push({ type: 'paragraph', content: [{ type: 'text', text: parts[0] }] })
        }
        for (let i = 1; i < parts.length; i++) {
          newDoc.content.push({
            type: 'paragraph',
            content: parts[i] ? [{ type: 'text', text: parts[i] }] : [],
          })
        }
      }
      store.currentContent = newDoc
    } else {
      // 当前内容非 JSON → 拼接为纯文本后按段落拆分
      const fullText = (typeof current === 'string' ? current : '') + payload.text
      store.currentContent = textToDocJson(fullText)
    }
    // 增量追加后滚到底部，跟随文字输出
    scrollEditor();
  }
}

// ── Diff 回放：原文不动，逐操作展示改动过程 ──
let diffPlaybackAbort = false

async function handleDiffPlayback(oldText: string, newText: string) {
  // 先终止上一次未完成的回放动画
  diffPlaybackAbort = true
  await nextTick()

  diffPlaybackAbort = false
  const changeChunks = computeDiff(oldText, newText).filter(c => c.kind !== 'keep')
  if (changeChunks.length === 0) {
    // 无改动，尝试解析为 JSON 后设置
    try {
      const parsed = JSON.parse(newText)
      if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
        store.currentContent = parsed
      }
    } catch { /* 保持原值 */ }
    workbenchRef.value?.onPlaybackComplete()
    return
  }

  const richEditor = richEditorRef.value
  if (!richEditor) return

  // 先展示原文
  try {
    const oldParsed = JSON.parse(oldText)
    if (oldParsed && typeof oldParsed === 'object' && oldParsed.type === 'doc') {
      store.currentContent = oldParsed
    }
  } catch { /* 解析失败保持原值 */ }
  await nextTick()
  await delay(200)

  let currentText = oldText
  const totalLen = Math.max(oldText.length, 1)
  const scrollEl = document.querySelector('.rich-content') as HTMLElement | null

  for (let i = 0; i < changeChunks.length; i++) {
    if (diffPlaybackAbort) break
    const chunk = changeChunks[i]

    // 构建增量文本
    const before = currentText.slice(0, chunk.oldPos)
    const after = currentText.slice(chunk.oldPos + chunk.oldText.length)
    currentText = before + chunk.newText + after
    const hlStart = before.length
    const hlEnd = hlStart + chunk.newText.length

    // 1) 平滑滚动到改动区域
    if (scrollEl) {
      const progress = Math.min(1, Math.max(0, (chunk.oldPos - 20) / totalLen))
      const targetTop = Math.max(0, progress * (scrollEl.scrollHeight - scrollEl.clientHeight))
      scrollEl.scrollTo({ top: targetTop, behavior: 'smooth' })
    }
    await delay(200)

    // 2) 构建 ProseMirror JSON 并高亮修改文本
    const json = textToDocJson(currentText)
    richEditor.setContentWithHighlight(json, hlStart, hlEnd)
    await delay(400)

    // 3) 恢复正常文本
    richEditor.setContentClean(json)
    await delay(250)
  }

  // 回放完成：确保最终内容正确，滚回顶部
  if (!diffPlaybackAbort) {
    try {
      const parsed = JSON.parse(newText)
      if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
        store.currentContent = parsed
      }
    } catch { /* 保持当前值 */ }
    await nextTick()
    if (scrollEl) scrollEl.scrollTop = 0
  }
  workbenchRef.value?.onPlaybackComplete()
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── 导出设置弹窗 ──
const showExportSettings = ref(false);
const showTutorial = ref(false);

// ── 窗口关闭拦截 ──
let closeRequestUnlisten: (() => void) | null = null;
let browserClipUnlisten: (() => void) | null = null;
let focusUnlisten: (() => void) | null = null;
let movedUnlisten: (() => void) | null = null;

onMounted(async () => {
  await store.initDocument();
  store.loadFolders();

  const win = getCurrentWindow();
  closeRequestUnlisten = await win.onCloseRequested(async (event) => {
    event.preventDefault();
    await tryExit();
  });

  // 监听浏览器中"存入素材库"事件（emit 通道）
  browserClipUnlisten = await listen<{ text: string; url?: string; title?: string }>(
    "browser-clip-selected-text",
    (event) => {
      handleBrowserClip(event.payload.text, event.payload.url, event.payload.title);
    },
  );

  // 注册全局函数，接收 eval 通道的剪藏调用（on_navigation / 自定义协议 eval 后备）
  (window as any).__aipenReceiveClip = (payload: { text: string; url?: string; title?: string }) => {
    console.log("[AiPen] __aipenReceiveClip 收到剪藏数据", payload?.text?.length ?? 0, "字符");
    handleBrowserClip(payload.text, payload.url, payload.title);
  };

  // 窗口 resize 时重定位浏览器 webview
  window.addEventListener("resize", onBrowserResize);

  // 窗口移动时也重定位浏览器 webview（与 resize 共用同一个处理函数）
  movedUnlisten = await win.onMoved(() => {
    onBrowserResize();
  });

  // 监听主窗口焦点变化：
  //   - 主窗口获焦 → 显示浏览器窗口
  //   - 主窗口失焦 → 仅在最小化时隐藏（用户点击浏览器窗口导致的失焦由 Rust 端处理）
  // always_on_top 的浏览器窗口不会自动跟随主窗口隐藏/最小化，必须手动同步。
  focusUnlisten = await win.onFocusChanged(async ({ payload: focused }) => {
    if (browserOpen.value && !browserManuallyHidden.value && leftSubTab.value === 'browser') {
      try {
        if (focused) {
          // 主窗口被聚焦 / 从最小化恢复 → 显示浏览器
          const minimized = await getCurrentWindow().isMinimized();
          if (!minimized) {
            const vp = getBrowserViewportRect();
            if (vp) {
              await invoke("resize_browser_webview", { x: vp.x, y: vp.y, width: vp.width, height: vp.height });
            }
            await invoke("show_browser");
          }
        } else {
          // 主窗口失焦，仅判断“最小化 → 隐藏浏览器”
          // “用户点击程序外”由 Rust 端浏览器窗口的 Focused(false) 事件处理
          const minimized = await getCurrentWindow().isMinimized();
          if (minimized) {
            await invoke("hide_browser");
          }
        }
      } catch { /* 忽略 */ }
    }
  });
});

onBeforeUnmount(() => {
  closeRequestUnlisten?.();
  browserClipUnlisten?.();
  focusUnlisten?.();
  movedUnlisten?.();
  window.removeEventListener("resize", onBrowserResize);
  delete (window as any).__aipenReceiveClip;
});

function handleCommit() {
  store.commitVersion(commitMsg.value || undefined);
  commitMsg.value = "";
}

// ── 窗口控制 ──
async function handleMinimize() {
  // 最小化前先隐藏浏览器子窗口（always_on_top 窗口不会跟随隐藏）
  if (browserOpen.value) {
    try {
      await invoke("hide_browser");
    } catch { /* 忽略 */ }
  }
  await getCurrentWindow().minimize();
}
async function handleMaximize() {
  const win = getCurrentWindow();
  const isMax = await win.isMaximized();
  if (isMax) {
    await win.unmaximize();
  } else {
    await win.maximize();
  }
}
async function tryExit() {
  // 隐藏浏览器窗口，避免 always_on_top 遮挡退出确认弹窗
  if (browserOpen.value) {
    browserManuallyHidden.value = true;
    try {
      await invoke("hide_browser");
    } catch { /* 忽略 */ }
  }
  if (currentContent.value) {
    try {
      await invoke("save_draft", {
        docId: store.currentDocId,
        content: JSON.stringify(currentContent.value),
      });
    } catch { /* 忽略保存错误 */ }
  }
  const ok = await confirm({
    title: "退出 AiPen",
    message: "确定要退出吗？编辑内容已自动保存。",
    kind: "info",
    okLabel: "退出",
    cancelLabel: "取消",
  });
  if (ok) {
    await invoke("exit_app");
  } else {
    // 用户取消退出，恢复浏览器窗口显示
    browserManuallyHidden.value = false;
    if (browserOpen.value) {
      try {
        await invoke("show_browser");
      } catch { /* 忽略 */ }
    }
  }
}
async function handleClose() {
  await tryExit();
}

// ── 工具栏标题重命名 ──
function startRename() {
  titleInput.value = currentTitle.value;
  editingTitle.value = true;
}

function confirmRename() {
  if (titleInput.value.trim() && titleInput.value.trim() !== currentTitle.value) {
    store.renameDocument(titleInput.value.trim());
  }
  editingTitle.value = false;
}

// ── 侧栏文档原地重命名 ──
const editingSidebarDocId = ref<string | null>(null);
const editingSidebarDocTitle = ref("");

function startRenameDialog(doc: { id: string; title: string }) {
  editingSidebarDocId.value = doc.id;
  editingSidebarDocTitle.value = doc.title;
}

function confirmRenameDialog() {
  const docId = editingSidebarDocId.value;
  const newTitle = editingSidebarDocTitle.value.trim();
  if (docId && newTitle) {
    const doc = documents.value.find(d => d.id === docId);
    if (doc && newTitle !== doc.title) {
      store.renameDocument(newTitle, docId);
    }
  }
  editingSidebarDocId.value = null;
  editingSidebarDocTitle.value = "";
}

function cancelRenameDialog() {
  editingSidebarDocId.value = null;
  editingSidebarDocTitle.value = "";
}

// ── 删除文档 ──
async function confirmDelete(doc: { id: string; title: string }) {
  const ok = await confirm({
    title: "删除文档",
    message: `确定要删除「${doc.title}」吗？此操作不可撤销。`,
    kind: "danger",
    okLabel: "删除",
    cancelLabel: "取消",
  });
  if (ok) {
    store.deleteDocument(doc.id);
  }
}

function handleNewDocument() {
  store.createNewDocument();
}

// ── 文件夹管理 ──

async function handleDeleteFolder(folderId: string) {
  const f = folders.value.find(f => f.id === folderId);
  if (!f) return;
  const ok = await confirm({
    title: "删除文件夹",
    message: `确定要删除「${f.name}」吗？文件夹内的文档将被移出（不会删除文档）。`,
    kind: "danger",
    okLabel: "删除",
    cancelLabel: "取消",
  });
  if (ok) {
    await store.deleteFolder(folderId);
  }
}

async function handleRenameFolder(folderId: string) {
  const f = folders.value.find(f => f.id === folderId);
  if (!f) return;
  const name = prompt("请输入新的文件夹名称：", f.name);
  if (name && name.trim() && name.trim() !== f.name) {
    await store.renameFolder(folderId, name.trim());
  }
}

// ── 移动文档弹窗 ──

function openMoveDocModal(doc: { id: string; title: string }) {
  moveDocTarget.value = doc;
  moveDocSelectedFolderId.value = "";
  moveDocNewFolderName.value = "";
  showMoveDocModal.value = true;
}

async function handleMoveDoc() {
  if (!moveDocTarget.value) return;
  const docId = moveDocTarget.value.id;

  if (moveDocNewFolderName.value.trim()) {
    // 先创建新文件夹，再移入
    const folder = await store.createFolder(moveDocNewFolderName.value.trim());
    await store.moveDocument(docId, folder.id);
  } else if (moveDocSelectedFolderId.value) {
    if (moveDocSelectedFolderId.value === "__uncategorized") {
      await store.removeDocumentFromFolder(docId);
    } else {
      await store.moveDocument(docId, moveDocSelectedFolderId.value);
    }
  }
  showMoveDocModal.value = false;
  moveDocTarget.value = null;
}

async function handleExportWord() {
  if (!currentContent.value) return;
  await exportToWord(JSON.stringify(currentContent.value), currentTitle.value, exportSettingsStore.settings);
}

</script>

<template>
  <div class="h-screen flex flex-col bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
    <!-- 工具栏 -->
    <header
      data-tauri-drag-region
      class="flex items-center pl-4 pr-2 h-12 border-b border-gray-200 dark:border-gray-800 bg-gray-100/80 dark:bg-gray-900/50 shrink-0 drag-region"
    >
      <div class="flex items-center gap-3">
        <h1 class="text-sm font-bold text-blue-400 dark:text-blue-300 tracking-wider">AiPen</h1>
        <span class="text-xs text-gray-500 dark:text-gray-600">|</span>
        <!-- 可编辑标题 -->
        <span
          v-if="!editingTitle"
          class="text-sm text-gray-700 dark:text-gray-300 cursor-pointer hover:text-blue-400 border-b border-dashed border-transparent hover:border-blue-400 no-drag"
          @click="startRename"
          title="点击重命名"
        >
          {{ currentTitle }}
        </span>
        <input
          v-else
          v-model="titleInput"
          type="text"
          class="text-sm bg-gray-100 dark:bg-gray-800 border border-blue-500 rounded px-2 py-0.5 text-gray-800 dark:text-gray-200 outline-none no-drag"
          @keyup.enter="confirmRename"
          @blur="confirmRename"
          @keyup.escape="editingTitle = false"
        />
      </div>
      <!-- 文档评分 Badge -->
      <div
        v-if="documentScore"
        class="relative ml-3 flex items-center gap-1 no-drag"
      >
        <button
          class="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold cursor-pointer transition-opacity hover:opacity-80"
          :class="scoreBadgeColor(documentScore.total_score)"
          @click="scorePopoverShow = !scorePopoverShow"
          :title="documentScore.encouragement"
        >
          <span class="text-[11px] leading-none">{{ scoreStars(documentScore.total_score) }}</span>
          <span>{{ documentScore.total_score }}分</span>
          <span class="opacity-70">{{ scoreTagline(documentScore.total_score) }}</span>
        </button>
        <button
          class="h-5 w-5 flex items-center justify-center rounded-full text-[10px] transition-colors"
          :class="scoreLoading ? 'text-gray-400 dark:text-gray-500 animate-spin' : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'"
          :disabled="scoreLoading"
          title="重新评分"
          @click="handleScoreDocument"
        >
          {{ scoreLoading ? '⏳' : '↻' }}
        </button>
      </div>
      <button
        v-else-if="currentContent"
        class="flex items-center gap-0.5 ml-3 px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-700 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-500 transition-colors cursor-pointer no-drag"
        :disabled="scoreLoading"
        title="AI 综合评分"
        @click="handleScoreDocument"
      >
        <span v-if="scoreLoading" class="animate-spin">⏳</span>
        <span v-else>⭐ 评分</span>
      </button>
      <div class="flex-1" />
      <div class="flex items-center gap-2">
        <!-- 导出 Word -->
        <button
          class="h-7 px-3 bg-green-700 hover:bg-green-600 text-white text-xs rounded transition-colors no-drag"
          :disabled="!currentContent"
          title="导出为 Word 文档"
          @click="handleExportWord"
        >
          导出 Word
        </button>
        <!-- 导出设置 -->
        <button
          class="h-7 px-3 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 text-xs rounded transition-colors no-drag"
          title="导出 Word 排版设置"
          @click="showExportSettings = true"
        >
          ⚙ 排版设置
        </button>
        <!-- Commit 输入区域 -->
        <input
          v-model="commitMsg"
          type="text"
          placeholder="提交信息（可选，默认时间命名）"
          class="w-52 h-7 px-3 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none no-drag"
          @keyup.enter="handleCommit"
        />
        <button
          class="h-7 px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded transition-colors no-drag"
          :disabled="loading.commit"
          @click="handleCommit"
        >
          {{ loading.commit ? "提交中..." : "提交版本" }}
        </button>
        <!-- 分隔符 -->
        <span class="h-5 w-px bg-gray-200 dark:bg-gray-700" />
        <!-- 窗口控制按钮组 -->
        <div class="flex items-center bg-gray-100/90 dark:bg-gray-800/80 rounded-md border border-gray-300/50 dark:border-gray-700/50 p-0.5 gap-1.5 h-7 no-drag">
          <button
            class="h-6 w-6 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-300/60 dark:hover:bg-gray-600/50 rounded transition-colors"
            title="最小化"
            @click="handleMinimize"
          >
            <svg class="w-3 h-3" viewBox="0 0 12 12"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button
            class="h-6 w-6 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-300/60 dark:hover:bg-gray-600/50 rounded transition-colors"
            title="最大化"
            @click="handleMaximize"
          >
            <svg class="w-3 h-3" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>
          </button>
          <button
            class="h-6 w-6 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors"
            title="关闭"
            @click="handleClose"
          >
            <svg class="w-3 h-3" viewBox="0 0 12 12"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="1.2"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="1.2"/></svg>
          </button>
        </div>
      </div>
    </header>

    <!-- 历史版本查看提示条 -->
    <div
      v-if="isViewingHistory"
      class="flex items-center justify-between px-4 py-2 bg-amber-100 dark:bg-amber-900/40 border-b border-amber-300 dark:border-amber-700/50 shrink-0"
    >
      <div class="flex items-center gap-2 text-sm">
        <span class="text-amber-600 dark:text-amber-400 text-base">ⓘ</span>
        <span class="text-amber-800 dark:text-amber-200 font-medium">
          正在查看历史版本（只读）：<span class="font-bold">{{ viewingVersionLabel }}</span>
        </span>
        <span class="text-amber-600 dark:text-amber-400/70 text-xs">
          可以选中复制，不能编辑
        </span>
      </div>
      <button
        class="h-7 px-3 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded transition-colors font-medium"
        title="回到最新编辑草稿"
        @click="store.exitHistoryView()"
      >
        ← 回到最新编辑
      </button>
    </div>

    <!-- 主内容区：左文档列表 + 编辑器 + 右侧面板 -->
    <div class="flex flex-1 min-h-0">
      <!-- 左侧文档列表 / 素材 / 浏览器 -->
      <aside
        class="flex flex-col border-r border-gray-200 dark:border-gray-800 bg-gray-100/80 dark:bg-gray-900/50 shrink-0 transition-all duration-200"
        :class="leftCollapsed ? 'w-0 overflow-hidden border-r-0' : 'w-48'"
        @contextmenu="onSidebarContextMenu"
      >
        <!-- Sub-Tab 切换 -->
        <nav class="flex border-b border-gray-200 dark:border-gray-800">
          <button
            v-for="tab in [
              { key: 'docs' as const, label: '文档' },
              { key: 'materials' as const, label: '素材' },
              { key: 'browser' as const, label: '浏览器' },
            ]"
            :key="tab.key"
            class="flex-1 py-1.5 text-[11px] font-medium transition-colors"
            :class="
              leftSubTab === tab.key
                ? 'text-blue-400 border-b-2 border-blue-500'
                : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            "
            @click="leftSubTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </nav>

        <!-- 文档列表 -->
        <template v-if="leftSubTab === 'docs'">
          <!-- 顶栏：全部 ▼ + 新建 -->
          <div class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
            <!-- 左：文件夹筛选下拉 -->
            <button
              ref="folderFilterBtnRef"
              class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider hover:text-gray-700 dark:hover:text-gray-300 transition-colors flex items-center gap-1"
              @click="showFolderFilterDropdown = !showFolderFilterDropdown"
            >
              {{ currentFolderFilter === 'all' ? '全部' : (folders.find(f => f.id === currentFolderFilter)?.name || '全部') }}
              <span class="text-[10px] leading-none transform transition-transform" :class="{ 'rotate-180': showFolderFilterDropdown }">▼</span>
            </button>
            <!-- 下拉菜单 -->
            <Teleport to="body">
              <div
                v-if="showFolderFilterDropdown"
                class="fixed inset-0 z-[10003]"
                @click.self="showFolderFilterDropdown = false"
              >
                <div
                  class="absolute w-40 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl py-1"
                  :style="folderFilterDropdownStyle"
                >
                    <div
                      class="px-3 py-1.5 text-xs cursor-pointer transition-colors"
                      :class="currentFolderFilter === 'all' ? 'text-blue-400 bg-blue-100 dark:bg-blue-900/20' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'"
                      @click.stop="store.setFolderFilter('all'); showFolderFilterDropdown = false"
                    >全部文档</div>
                    <div class="h-px bg-gray-100 dark:bg-gray-800 mx-2 my-1" v-if="folders.length > 0" />
                    <template v-for="f in folders" :key="f.id">
                      <div
                        class="flex items-center justify-between px-3 py-1.5 text-xs cursor-pointer transition-colors group"
                        :class="currentFolderFilter === f.id ? 'text-blue-400 bg-blue-100 dark:bg-blue-900/20' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'"
                        @click.stop="store.setFolderFilter(f.id); showFolderFilterDropdown = false"
                      >
                        <span>
                          <svg class="w-3 h-3 inline-block mr-1 text-gray-400 dark:text-gray-500" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
                          {{ f.name }}
                        </span>
                        <div class="hidden group-hover:flex items-center gap-1 ml-2">
                          <button class="text-gray-500 dark:text-gray-600 hover:text-yellow-600 dark:hover:text-yellow-400" title="重命名" @click.stop="handleRenameFolder(f.id)">✎</button>
                          <button class="text-gray-500 dark:text-gray-600 hover:text-red-600 dark:hover:text-red-400" title="删除" @click.stop="handleDeleteFolder(f.id)">✕</button>
                        </div>
                      </div>
                    </template>
                    <div v-if="folders.length === 0" class="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-600">暂无文件夹</div>
                  </div>
                </div>
              </Teleport>
            <!-- 右：新建按钮 -->
            <button
              class="text-xs text-gray-400 dark:text-gray-500 hover:text-blue-400 transition-colors"
              title="新建文档"
              @click="handleNewDocument"
            >+ 新建</button>
          </div>
          <div class="flex-1 overflow-y-auto">
            <div
              v-for="doc in filteredDocuments"
              :key="doc.id"
              class="group flex items-center gap-1 px-2 py-2 cursor-pointer transition-colors"
              :class="
                doc.id === store.currentDocId
                  ? 'bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500 text-blue-700 dark:text-blue-300'
                  : 'border-l-2 border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 hover:text-gray-800 dark:hover:text-gray-200'
              "
              @click="store.switchDocument(doc.id)"
            >
              <div class="flex-1 min-w-0">
                <input
                  v-if="editingSidebarDocId === doc.id"
                  v-model="editingSidebarDocTitle"
                  type="text"
                  class="w-full bg-gray-100 dark:bg-gray-800 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-gray-800 dark:text-gray-200 outline-none"
                  @keyup.enter="confirmRenameDialog()"
                  @keyup.escape="cancelRenameDialog()"
                  @blur="confirmRenameDialog()"
                  @click.stop
                />
                <p v-else class="text-xs truncate">{{ doc.title }}</p>
                <p class="text-[10px] text-gray-500 dark:text-gray-600 truncate">
                  {{ doc.updated_at?.slice(0, 10) }}
                  <span v-if="doc.folder_name" class="ml-1.5 text-gray-500 dark:text-gray-600">
                    <svg class="w-2.5 h-2.5 inline-block mr-0.5 text-gray-500 dark:text-gray-600" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
                    {{ doc.folder_name }}
                  </span>
                  <span v-else class="ml-1.5 text-gray-300 dark:text-gray-700">未分类</span>
                </p>
              </div>
              <!-- 操作按钮：编辑 | 移动 | 删除 -->
              <div class="hidden group-hover:flex items-center gap-0.5 shrink-0">
                <button
                  class="h-5 w-5 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500 hover:text-yellow-600 dark:hover:text-yellow-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                  title="重命名"
                  @click.stop="startRenameDialog(doc)"
                >✎</button>
                <button
                  class="h-5 w-5 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500 hover:text-blue-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                  title="移动到文件夹"
                  @click.stop="openMoveDocModal(doc)"
                >↗</button>
                <button
                  class="h-5 w-5 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                  title="删除"
                  @click.stop="confirmDelete(doc)"
                >✕</button>
              </div>
            </div>
            <!-- 空状态 -->
            <div
              v-if="filteredDocuments.length === 0 && !loading.init"
              class="text-center py-8 text-gray-500 dark:text-gray-600 text-xs"
            >
              <p>{{ currentFolderFilter === 'all' ? '暂无文档' : '该文件夹暂无文档' }}</p>
              <p
                class="text-blue-500 cursor-pointer hover:underline mt-1"
                @click="handleNewDocument"
              >创建第一个</p>
            </div>
          </div>
        </template>

        <!-- 移动到文件夹弹窗 -->
        <Teleport to="body">
          <div
            v-if="showMoveDocModal"
            class="fixed inset-0 z-[10004] flex items-center justify-center"
            @click.self="showMoveDocModal = false"
          >
            <div class="absolute inset-0 bg-black/60 backdrop-blur-md" />
            <div class="relative w-full max-w-sm rounded-xl shadow-2xl flex flex-col bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-gray-800 dark:text-gray-200">
              <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
                <span class="text-sm font-semibold">移动「{{ moveDocTarget?.title }}」到</span>
                <button class="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 text-lg leading-none" @click="showMoveDocModal = false">✕</button>
              </div>
              <div class="px-4 py-3 space-y-2 max-h-[50vh] overflow-y-auto">
                <!-- 未分类 -->
                <div
                  class="px-3 py-2 rounded text-xs cursor-pointer transition-colors"
                  :class="moveDocSelectedFolderId === '__uncategorized' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'"
                  @click="moveDocSelectedFolderId = '__uncategorized'"
                >未分类</div>
                <!-- 已有文件夹 -->
                <div
                  v-for="f in folders"
                  :key="f.id"
                  class="px-3 py-2 rounded text-xs cursor-pointer transition-colors"
                  :class="moveDocSelectedFolderId === f.id ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'"
                  @click="moveDocSelectedFolderId = f.id"
                >
                  <svg class="w-3 h-3 inline-block mr-1 text-gray-600 dark:text-gray-400" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>
                  {{ f.name }}
                </div>
                <!-- 创建新文件夹 -->
                <div class="flex gap-2 pt-2 border-t border-gray-200 dark:border-gray-800">
                  <input
                    v-model="moveDocNewFolderName"
                    type="text"
                    placeholder="新建文件夹..."
                    class="flex-1 h-7 px-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none"
                    @keyup.enter="handleMoveDoc"
                  />
                </div>
              </div>
              <div class="px-4 py-2.5 border-t border-gray-200 dark:border-gray-800 flex justify-end gap-2">
                <button class="h-7 px-3 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded transition-colors" @click="showMoveDocModal = false">取消</button>
                <button
                  class="h-7 px-3 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors disabled:opacity-50"
                  :disabled="!moveDocSelectedFolderId && !moveDocNewFolderName.trim()"
                  @click="handleMoveDoc"
                >确定</button>
              </div>
            </div>
          </div>
        </Teleport>

        <!-- 素材 / 浏览器面板 -->
        <MaterialPanel
          v-if="leftSubTab === 'materials' || leftSubTab === 'browser'"
          :subTab="leftSubTab"
          :activeMaterialId="materialStore.currentMaterialId"
          @selectMaterial="handleMaterialSelect"
          @selectTagDocument="handleTagDocSelect"
          @update="handleMaterialPanelUpdate"
        />
      </aside>

      <!-- 左侧折叠按钮 -->
      <button
        class="w-5 flex items-center justify-center bg-gray-100/50 dark:bg-gray-800/30 hover:bg-gray-200/60 dark:hover:bg-gray-700/50 border-r border-gray-200 dark:border-gray-800 shrink-0 transition-colors cursor-pointer group"
        :title="leftCollapsed ? '展开文档列表' : '折叠文档列表'"
        @click="leftCollapsed = !leftCollapsed"
      >
        <span class="text-gray-400 dark:text-gray-500 group-hover:text-gray-700 dark:hover:text-gray-300 text-xs transition-colors">
          {{ leftCollapsed ? '▶' : '◀' }}
        </span>
      </button>

      <!-- 中间：编辑器 + 写作进度条 -->
      <main ref="mainAreaRef" class="flex-1 min-w-0 min-h-0 flex flex-col">
        <!-- 写作进度条（生成/审查/润色阶段） -->
        <div
          v-if="composeActive && isWritingPhase"
          class="flex items-center justify-between px-4 h-9 border-b shrink-0 bg-gray-100/90 dark:bg-gray-900/90 backdrop-blur-sm"
          :class="{
            'border-emerald-800/50': progressPhaseColor === 'emerald',
            'border-amber-800/50': progressPhaseColor === 'amber',
            'border-purple-800/50': progressPhaseColor === 'purple',
          }"
        >
          <!-- 左：图标 + 炫彩文字 + 阶段名 -->
          <div class="flex items-center gap-2.5 min-w-0 shrink-0">
            <span class="text-sm">{{ composePhase === 'generating' ? '✍️' : composePhase === 'reviewing' ? '🔍' : '✨' }}</span>
            <span
              class="text-sm font-bold bg-clip-text text-transparent bg-[length:200%_100%] animate-shimmer-progress"
              :class="{
                'bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-400': progressPhaseColor === 'emerald',
                'bg-gradient-to-r from-amber-400 via-orange-300 to-amber-400': progressPhaseColor === 'amber',
                'bg-gradient-to-r from-purple-400 via-pink-300 to-purple-400': progressPhaseColor === 'purple',
              }"
            >
              {{ composePhase === 'generating' ? '正文撰写中' : composePhase === 'reviewing' ? '质量审查中' : '润色定稿中' }}
            </span>
            <span class="text-[11px] text-gray-400 dark:text-gray-500 hidden sm:inline">{{ composeProgress?.stageLabel || '' }}</span>
          </div>

          <!-- 中：审查/润色状态 -->
          <span
            v-if="reviewStatusText"
            class="flex-1 mx-4 text-center text-[11px] font-medium animate-pulse truncate"
            :class="composePhase === 'polishing' ? 'text-purple-700 dark:text-purple-300' : 'text-amber-700 dark:text-amber-300'"
          >
            {{ reviewStatusText }}
          </span>

          <!-- 右：跑马灯方块 + 步数 + 结束 -->
          <div class="flex items-center gap-2.5 shrink-0">
            <div class="flex items-center gap-1">
              <div
                v-for="i in 5"
                :key="i"
                class="w-1.5 h-1.5 rounded-sm animate-marquee-sq"
                :style="{ animationDelay: `${(i - 1) * 0.15}s` }"
                :class="{
                  'bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]': progressPhaseColor === 'emerald',
                  'bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.5)]': progressPhaseColor === 'amber',
                  'bg-purple-400 shadow-[0_0_4px_rgba(192,132,252,0.5)]': progressPhaseColor === 'purple',
                }"
              ></div>
            </div>
            <span class="text-[11px] text-gray-500 dark:text-gray-600 tabular-nums">
              {{ composeProgress?.currentStep || 0 }}/{{ composeProgress?.totalSteps || 0 }}
            </span>
            <button
              class="h-7 px-3 text-xs text-red-600 dark:text-red-400/70 bg-red-100 dark:bg-red-950/20 border border-red-300 dark:border-red-900/30 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 hover:border-red-800/50 rounded transition-colors"
              @click="handleRequestClose"
            >
              结束创作
            </button>
          </div>
        </div>

        <!-- 浏览器 / WebView -->
        <div v-if="editMode === 'webview'" class="flex-1 flex flex-col min-h-0">
          <!-- 地址栏 -->
          <div ref="browserAddressBarRef" class="flex items-center gap-2 py-2 border-b border-gray-200/40 dark:border-gray-800/30 bg-white dark:bg-[#030712] shrink-0 sticky top-0 z-10">
            <!-- 导航按钮 -->
            <div class="flex items-center gap-1 shrink-0 ml-1.5">
              <button
                class="h-7 w-7 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100/60 dark:hover:bg-gray-800/50 rounded transition-colors"
                title="后退"
                @click="handleBrowserBack"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                class="h-7 w-7 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100/60 dark:hover:bg-gray-800/50 rounded transition-colors"
                title="前进"
                @click="handleBrowserForward"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <button
                class="h-7 w-7 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100/60 dark:hover:bg-gray-800/50 rounded transition-colors"
                title="刷新"
                @click="handleBrowserRefresh"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
            <!-- URL 输入框 -->
            <input
              v-model="browserUrlInput"
              type="text"
              placeholder="输入网址..."
              class="flex-1 h-7 px-3 bg-gray-100/60 dark:bg-gray-800 border border-gray-200/60 dark:border-gray-700/50 rounded text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              @keyup.enter="handleAddressBarNavigate"
            />
            <!-- 右侧按钮组：Go + 关闭 -->
            <div class="flex items-center gap-2 shrink-0 mr-1.5">
              <button
                class="h-7 px-3 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded transition-colors shrink-0"
                @click="handleAddressBarNavigate"
              >
                前往
              </button>
              <button
                v-if="browserOpen"
                class="h-7 w-7 flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors shrink-0"
                title="关闭浏览器（释放资源）"
                @click="handleBrowserDestroy"
              >
              <svg class="w-3.5 h-3.5" viewBox="0 0 14 14"><line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="12" y1="2" x2="2" y2="12" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
            </div>
          </div>
          <!-- WebView 占位 / 提示 -->
          <div
            v-if="!browserOpen"
            class="flex-1 flex items-center justify-center bg-white dark:bg-[#030712]"
          >
            <div class="text-center space-y-3">
              <span class="text-3xl">🌐</span>
              <p class="text-sm text-gray-400 dark:text-gray-500">浏览器模式</p>
              <p class="text-xs text-gray-500 dark:text-gray-600">在上方地址栏输入网址，或点击左侧书签打开 WebView</p>
              <p class="text-xs text-gray-500 dark:text-gray-600">选择 「文档」 Tab 返回编辑器</p>
            </div>
          </div>
        </div>
        <RichEditor
          v-if="editMode !== 'webview'"
          ref="richEditorRef"
          v-model="displayedContent"
          :readonly="isViewingHistory || isWritingPhase || isViewingTagDoc"
          :editMode="editorEditMode"
          :materialId="materialStore.currentMaterialId ?? undefined"
          class="flex-1"
          @insert-to-chat="handleEditorInsertToChat"
          @delete-material="handleEditorDeleteMaterial"
          @remove-from-tag="handleEditorRemoveFromTag"
        />

        <!-- 写作工作台（问答弹窗，Teleported） -->
        <ComposeWorkbench
          ref="workbenchRef"
          v-if="composeActive && composeRecipe"
          :recipe="composeRecipe"
          @done="handleComposeDone"
          @progress="composeProgress = $event"
          @requestClose="handleRequestClose"
          @stream="handleStream"
        />
      </main>

      <!-- 右侧折叠按钮 -->
      <button
        class="w-5 flex items-center justify-center bg-gray-100/50 dark:bg-gray-800/30 hover:bg-gray-200/60 dark:hover:bg-gray-700/50 border-l border-gray-200 dark:border-gray-800 shrink-0 transition-colors cursor-pointer group"
        :title="rightCollapsed ? '展开工具面板' : '折叠工具面板'"
        @click="rightCollapsed = !rightCollapsed"
      >
        <span class="text-gray-400 dark:text-gray-500 group-hover:text-gray-700 dark:hover:text-gray-300 text-xs transition-colors">
          {{ rightCollapsed ? '◀' : '▶' }}
        </span>
      </button>

      <!-- 右侧：面板区 -->
      <aside
        class="flex flex-col border-l border-gray-200 dark:border-gray-800 bg-gray-100/60 dark:bg-gray-900/30 shrink-0 transition-all duration-200"
        :class="rightCollapsed ? 'w-0 overflow-hidden border-l-0' : 'w-80'"
        @contextmenu="onSidebarContextMenu"
      >
        <!-- Tab 切换 -->
        <nav class="flex border-b border-gray-200 dark:border-gray-800">
          <button
            v-for="tab in [
              { key: 'versions', label: '版本' },
              { key: 'diff', label: 'Diff' },
              { key: 'analysis', label: 'AI分析' },
              { key: 'chat', label: 'AI对话' },
              { key: 'skills', label: '技能' },
              { key: 'compose', label: '写作' },
              { key: 'knowledge', label: '知识库' },
              { key: 'settings', label: '设置' },
            ]"
            :key="tab.key"
            class="flex-1 py-1.5 text-[11px] font-medium transition-colors"
            :class="
              sidebarTab === tab.key
                ? 'text-blue-400 border-b-2 border-blue-500'
                : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            "
            @click="sidebarTab = tab.key as typeof sidebarTab"
          >
            {{ tab.label }}
          </button>
        </nav>

        <!-- Tab 内容 -->
        <div class="flex-1 overflow-y-auto p-4">
          <!-- 全局错误 -->
          <div
            v-if="error"
            class="mb-3 text-sm text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/30 border border-red-300 dark:border-red-900/30 rounded-lg px-3 py-2"
          >
            {{ error }}
            <button class="ml-2 text-xs underline hover:text-red-600 dark:hover:text-red-300" @click="store.error = ''">
              关闭
            </button>
          </div>

          <VersionList v-show="sidebarTab === 'versions'" />
          <DiffViewer v-show="sidebarTab === 'diff'" />
          <AIPanel v-show="sidebarTab === 'analysis'" />
          <ChatPanel
            v-show="sidebarTab === 'chat'"
            :currentDocId="store.currentDocId"
            :currentContent="documentPlainText"
            :injectedText="injectedChatText"
            @injected-text-consumed="injectedChatText = ''"
          />
          <SkillPanel
            v-show="sidebarTab === 'skills'"
            :currentContent="documentPlainText"
            :selectedText="selectedText"
            @request-selected-text="getSelectedText"
          />
          <KnowledgePanel
            v-show="sidebarTab === 'knowledge'"
          />
          <ComposeLauncher
            v-show="sidebarTab === 'compose'"
            :activeProgress="composeProgress"
            @start="handleComposeStart"
          />
          <ApiSettings v-show="sidebarTab === 'settings'" />
        </div>
      </aside>
    </div>

    <!-- 状态栏 -->
    <footer data-tauri-drag-region class="flex items-center px-4 h-7 border-t border-gray-200 dark:border-gray-800 bg-gray-100/80 dark:bg-gray-900/50 shrink-0 drag-region">
      <div class="flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-600 no-drag">
        <span v-if="editMode === 'document' && currentContent">
          字数: {{ typeof currentContent === 'object' && currentContent.content ? currentContent.content.reduce(
            (acc: number, n: any) => acc + (n.content ? n.content.reduce((s: number, t: any) => s + (t.text ? t.text.length : 0), 0) : 0), 0
          ) : 0 }}
        </span>
        <span v-else-if="editMode === 'material' && materialStore.currentMaterialContent">
          素材字数: {{ typeof materialStore.currentMaterialContent === 'object' && materialStore.currentMaterialContent.content ? materialStore.currentMaterialContent.content.reduce(
            (acc: number, n: any) => acc + (n.content ? n.content.reduce((s: number, t: any) => s + (t.text ? t.text.length : 0), 0) : 0), 0
          ) : (typeof materialStore.currentMaterialContent === 'string' ? materialStore.currentMaterialContent.length : 0) }}
        </span>
        <template v-if="editMode === 'document' && !isViewingHistory">
          <span v-if="draftSaveStatus === 'pending'" class="text-yellow-700 dark:text-yellow-500">● 检测到变更…</span>
          <span v-else-if="draftSaveStatus === 'saving'" class="text-blue-400">● 正在保存…</span>
          <span v-else-if="draftSaveStatus === 'saved'" class="text-green-600 dark:text-green-400">● 草稿已自动保存{{ lastSaveTime ? `（${lastSaveTime}）` : '' }}</span>
          <span v-else-if="draftSaveStatus === 'error'" class="text-red-500">● 保存失败</span>
          <span v-else-if="draftSaveStatus === 'idle' && lastSaveTime" class="text-gray-400 dark:text-gray-500">草稿已保存（{{ lastSaveTime }}）</span>
        </template>
      </div>
      <!-- 中间拖拽区域 -->
      <div class="flex-1 h-full" />
      <div class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-600 no-drag">
        <span v-if="loading.init" class="text-blue-400 dark:text-blue-300">初始化中...</span>
        <!-- AI 状态 -->
        <span
          class="inline-flex items-center px-1.5 py-px rounded font-medium text-gray-500 dark:text-gray-400"
          :class="apiConfig.model.includes('pro') ? 'bg-blue-400/25' : 'bg-gray-200 dark:bg-gray-800/60'"
        >
          {{ modelLabel }}
        </span>
        <span
          class="inline-flex items-center px-1.5 py-px rounded font-medium text-gray-500 dark:text-gray-400"
          :class="apiConfig.thinking_enabled ? 'bg-emerald-400/25' : 'bg-gray-200 dark:bg-gray-800/60'"
        >
          {{ thinkingLabel }}
        </span>
        <span
          v-if="apiConfig.thinking_enabled"
          class="inline-flex items-center px-1.5 py-px rounded font-medium text-gray-500 dark:text-gray-400"
          :class="apiConfig.reasoning_effort === 'max' ? 'bg-blue-400/25' : 'bg-gray-200 dark:bg-gray-800/60'"
        >
          {{ effortLabel }}
        </span>
        <!-- 深浅主题切换 -->
        <span
          :title="isDark ? '切换浅色主题' : '切换深色主题'"
          class="inline-flex items-center px-1.5 py-px rounded font-medium transition-colors cursor-pointer select-none no-drag bg-gray-200 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-700"
          @click="toggleTheme"
        >
          <svg v-if="isDark" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5"/>
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </span>
        <!-- 问号图标 -->
        <button
          title="工具使用教程"
          class="ml-1 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors flex-shrink-0 leading-none no-drag"
          @click="showTutorial = true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="11" fill="currentColor" fill-opacity="0.12" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M12 17h.01" />
          </svg>
        </button>
        <span class="text-gray-500 dark:text-gray-400">大庆油田 | 陈刚 18088793359</span>
      </div>
    </footer>

    <!-- 导出设置弹窗 -->
    <ExportSettings v-model:show="showExportSettings" />

    <!-- 素材剪藏弹窗 -->
    <MaterialClipDialog
      v-if="showClipDialog"
      :content="clipText"
      :sourceUrl="clipSourceUrl"
      :sourceTitle="clipSourceTitle"
      @close="handleClipClose"
      @saved="handleClipSaved"
    />

    <!-- 工具使用教程弹窗 -->
    <Teleport to="body">
      <div
        v-if="showTutorial"
        class="fixed inset-0 z-[10001] flex items-center justify-center"
        @click.self="showTutorial = false"
      >
        <div class="absolute inset-0 bg-black/40 backdrop-blur-md" />
        <div class="relative w-full max-w-2xl max-h-[85vh] rounded-xl shadow-2xl flex flex-col bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-800">
          <!-- 标题栏 -->
          <div class="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 dark:border-gray-800 shrink-0 rounded-t-xl">
            <h2 class="text-base font-semibold">📖 AiPen 使用教程</h2>
            <button
              class="h-7 w-7 flex items-center justify-center rounded text-lg leading-none text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              @click="showTutorial = false"
            >✕</button>
          </div>
          <!-- 内容区 -->
          <div class="px-5 py-4 overflow-y-auto text-sm leading-relaxed space-y-5">
            <p class="text-gray-400 dark:text-gray-500 text-xs border-b border-gray-200 dark:border-gray-800 pb-3 mb-1">
              AiPen 是一款面向公文写作场景的 AI 智能写作桌面工具，基于富文本编辑器（TipTap/ProseMirror），集成版本管理、AI 分析、智能写作流水线、技能库、知识库、素材库与浏览器剪藏等完整工具链。以下按模块详细介绍所有功能和使用方法。
            </p>
            <!-- 1. 基本编辑 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">1. 基本编辑</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                AiPen 采用所见即所得的<b class="text-gray-800 dark:text-gray-200">富文本编辑器</b>，基于 TipTap (ProseMirror) 引擎：<br/>
                • <b class="text-gray-800 dark:text-gray-200">文字格式</b> — 粗体（Ctrl+B）、斜体（Ctrl+I）、下划线、删除线、行内代码、上/下标<br/>
                • <b class="text-gray-800 dark:text-gray-200">段落格式</b> — H1~H4 标题、无序/有序列表、引用块、分割线<br/>
                • <b class="text-gray-800 dark:text-gray-200">表格</b> — 插入/编辑表格，支持表头加粗、行列增删、合并单元格<br/>
                • <b class="text-gray-800 dark:text-gray-200">图片</b> — 工具栏按钮选择本地图片，或截图后 <b class="text-gray-800 dark:text-gray-200">Ctrl+V</b> 直接粘贴，图片自动保存到本地<br/>
                • <b class="text-gray-800 dark:text-gray-200">字体/字号</b> — 10 种中文字体可选（等线、微软雅黑、宋体、黑体、楷体、仿宋等），Ctrl+滚轮 缩放 10~32px<br/>
                • <b class="text-gray-800 dark:text-gray-200">撤销/重做</b> — Ctrl+Z / Ctrl+Y<br/>
                • <b class="text-gray-800 dark:text-gray-200">主题切换</b> — 状态栏 ☀/🌙 按钮在深色/浅色主题间切换，偏好自动保存
              </p>
            </div>
            <!-- 2. 文档管理 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">2. 文档管理</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                左侧面板的<b class="text-gray-800 dark:text-gray-200">「文档」</b>子标签页管理所有文档：<br/>
                • <b class="text-gray-800 dark:text-gray-200">新建文档</b> — 点击「+ 新建」创建空白文档<br/>
                • <b class="text-gray-800 dark:text-gray-200">重命名</b> — 悬停文档点击 ✎ 图标，或点击顶部标题栏直接重命名<br/>
                • <b class="text-gray-800 dark:text-gray-200">删除</b> — 悬停文档点击 ✕ 图标，确认弹窗确认后不可恢复<br/>
                • <b class="text-gray-800 dark:text-gray-200">移动</b> — 悬停文档点击 ↗ 图标，弹出面板选择目标文件夹或创建新文件夹后移入<br/>
                • <b class="text-gray-800 dark:text-gray-200">自动保存</b> — 编辑内容防抖 1 秒自动保存草稿。状态栏实时显示保存状态：<span class="text-yellow-700 dark:text-yellow-500">检测到变更…</span> → <span class="text-blue-400 dark:text-blue-300">正在保存…</span> → <span class="text-green-600 dark:text-green-400">草稿已自动保存（HH:MM:SS）</span><br/>
                • <b class="text-gray-800 dark:text-gray-200">安全退出</b> — 关闭窗口时自动保存并弹出确认提示，防止误关闭<br/>
                • <b class="text-gray-800 dark:text-gray-200">切换即保</b> — 从文档切换到素材/浏览器时自动保存当前文档<br/><br/>
                <b class="text-gray-800 dark:text-gray-200">📁 文件夹管理</b><br/>
                • <b class="text-gray-800 dark:text-gray-200">筛选文档</b> — 点击「全部 ▼」下拉，选择文件夹名按文件夹筛选文档<br/>
                • <b class="text-gray-800 dark:text-gray-200">创建/重命名/删除</b> — 下拉列表中管理文件夹（删除文件夹前需确认，文档不会被删除只会被移出）<br/>
                • <b class="text-gray-800 dark:text-gray-200">归属显示</b> — 每个文档下方标注所属文件夹名称和最近更新时间
              </p>
            </div>
            <!-- 3. 版本管理 & Diff -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">3. 版本管理 &amp; Diff 对比</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                类似 Git 的文档版本管理系统，让你放心修改、轻松回溯：<br/>
                • <b class="text-gray-800 dark:text-gray-200">提交版本</b> — 在顶部工具栏输入提交信息（可选，默认时间命名），点击「提交版本」保存当前文档快照<br/>
                • <b class="text-gray-800 dark:text-gray-200">「版本」标签页</b> — 浏览所有历史版本，支持<b class="text-gray-800 dark:text-gray-200">重命名</b>、<b class="text-gray-800 dark:text-gray-200">查看</b>（只读模式，黄色提示条，可选中复制但不能编辑）、<b class="text-gray-800 dark:text-gray-200">回滚</b>（覆盖当前草稿）、<b class="text-gray-800 dark:text-gray-200">删除</b><br/>
                • <b class="text-gray-800 dark:text-gray-200">「Diff」标签页</b> — 先选旧版，再选新版，点击「开始对比」。新增内容以<span class="text-green-600 dark:text-green-400">绿色</span>高亮，删除内容以<span class="text-amber-600 dark:text-amber-400">琥珀色</span>高亮。支持<span class="text-emerald-700 dark:text-emerald-300">行内词级差异</span>细粒度展示，显示新增/删除行数统计
              </p>
            </div>
            <!-- 4. AI 智能分析 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">4. AI 智能分析</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                在<b class="text-gray-800 dark:text-gray-200">「AI分析」</b>标签页，AI 对两个版本间的修改进行<b class="text-gray-800 dark:text-gray-200">多维度结构化评审</b>：<br/>
                • <b class="text-gray-800 dark:text-gray-200">总体评估</b> — 新旧版本评分对比、提升/退步/持平判决、综合分析总结<br/>
                • <b class="text-gray-800 dark:text-gray-200">主旨与思想站位</b> — 立意提升、政治站位、视野深度、风险提示<br/>
                • <b class="text-gray-800 dark:text-gray-200">逻辑分析</b> — 逐条标注<span class="text-green-600 dark:text-green-400">逻辑优点（绿色✓）</span>和<span class="text-red-600 dark:text-red-400">逻辑弱点（红色✗）</span><br/>
                • <b class="text-gray-800 dark:text-gray-200">深度洞察</b> — 新增洞见与空话/套话分类识别<br/>
                • <b class="text-gray-800 dark:text-gray-200">表达分析</b> — 表达亮点与表达问题逐条评审<br/>
                • <b class="text-gray-800 dark:text-gray-200">修改分类</b> — 优化型/退化型/冗余型/调整型，附示例和理由<br/>
                • <b class="text-gray-800 dark:text-gray-200">改进建议</b> — 高/中/低优先级分类，含具体建议和理由<br/>
                • <b class="text-gray-800 dark:text-gray-200">维度对比</b> — 多维度雷达式对比展示<br/>
                分析结果<b class="text-gray-800 dark:text-gray-200">自动缓存</b>，下次打开同版对直接加载无需重复请求，大幅节省 token 消耗。
              </p>
            </div>
            <!-- 5. AI 对话 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">5. AI 对话</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                在<b class="text-gray-800 dark:text-gray-200">「AI对话」</b>标签页，与 AI 进行多轮自然语言对话：<br/>
                • <b class="text-gray-800 dark:text-gray-200">多对话管理</b> — 创建/切换/重命名/删除多个独立对话，互不干扰<br/>
                • <b class="text-gray-800 dark:text-gray-200">流式输出</b> — AI 回复逐字实时推送，边生成边查看<br/>
                • <b class="text-gray-800 dark:text-gray-200">右键引用全文</b> — 编辑器中右键 →「💬 添加到 AI 对话」，自动将当前文档全文作为上下文<br/>
                • <b class="text-gray-800 dark:text-gray-200">右键引用选中</b> — 选中文字右键引用，仅将选中文本作为上下文<br/>
                • <b class="text-gray-800 dark:text-gray-200">知识库上下文</b> — 可勾选知识库作为对话背景<br/>
                • <b class="text-gray-800 dark:text-gray-200">素材库上下文</b> — 可勾选素材标签，将素材内容作为对话参考<br/>
                • <b class="text-gray-800 dark:text-gray-200">快捷输入</b> — Enter 发送，Shift+Enter 换行
              </p>
            </div>
            <!-- 6. 写作技能 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">6. 写作技能</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                在<b class="text-gray-800 dark:text-gray-200">「技能」</b>标签页，技能按分类分组：<span class="text-red-600 dark:text-red-400">纠错</span> / <span class="text-yellow-600 dark:text-yellow-400">润色</span> / <span class="text-purple-600 dark:text-purple-400">创意</span> / <span class="text-blue-600 dark:text-blue-400">自定义</span>：<br/>
                • <b class="text-gray-800 dark:text-gray-200">智能选区</b> — 在编辑器中选中文本后切换到技能页，对选中文本执行；未选择则对全文执行<br/>
                • <b class="text-gray-800 dark:text-gray-200">内置技能</b> — 语法纠错、病句检查、文体规范、逻辑审查、政治审查、节奏韵律、领导用语评价等专业写作技能<br/>
                • <b class="text-gray-800 dark:text-gray-200">「精神融入」技能</b> — 自动匹配最相关内置知识库作为上下文，将企业文化精神融入文稿<br/>
                • <b class="text-gray-800 dark:text-gray-200">自定义技能</b> — 点击「+ 添加自定义技能」，设置名称、分类、提示词模板和温度参数，可关联知识库和素材标签<br/>
                • <b class="text-gray-800 dark:text-gray-200">技能管道（Pipeline）</b> — 点击「▶ 管道执行」，多技能串行执行。显示步骤进度（呼吸灯动画），完成后 diff 回放逐操作高亮展示改动。适合批量质检：纠错→审校→润色→定稿
              </p>
            </div>
            <!-- 7. 智能写作流水线 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">7. ⭐ 智能写作流水线（核心功能）</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                在<b class="text-gray-800 dark:text-gray-200">「写作」</b>标签页选择菜谱后，进入<b class="text-gray-800 dark:text-gray-200">五阶段全流程 AI 写作</b>：<br/><br/>
                <b class="text-gray-800 dark:text-gray-200">阶段一：信息采集（采访）</b><br/>
                AI 逐题提问采集写作素材，支持选项式问题和必选/可选问题。可回退修改、跳过问题、使用常用提示词快捷填充。<br/>
                <b class="text-gray-800 dark:text-gray-200">阶段二：生成提纲</b><br/>
                基于六型十四式标题风格库，结合 SCAR 模型。可设置标题风格、内联编辑条目、AI 重生成、细化要求。<br/>
                <b class="text-gray-800 dark:text-gray-200">阶段三：正文撰写</b><br/>
                AI 流式生成正文，支持有提纲/无提纲两种模式，逐字推送到编辑器。<br/>
                <b class="text-gray-800 dark:text-gray-200">阶段四：质量审查</b><br/>
                依次执行逻辑审查、病句检查、文体规范等审查技能。发现问题→自动修复→diff 回放动画展示改动。<br/>
                <b class="text-gray-800 dark:text-gray-200">阶段五：润色定稿</b><br/>
                诊断+修复两步流程，diff 动画展示所有改动。完成后输出全文 + 审查记录 + 润色记录。
              </p>
            </div>
            <!-- 8. 写作菜谱 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">8. 写作菜谱</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                在<b class="text-gray-800 dark:text-gray-200">「写作」</b>标签页管理写作模板：<br/>
                • <b class="text-gray-800 dark:text-gray-200">10 种内置菜谱</b> — 述职报告、领导讲话、工作总结、研讨材料、通讯简报、课题研究、工作通知、规章制度、经验材料、工作汇报<br/>
                • <b class="text-gray-800 dark:text-gray-200">自定义菜谱</b> — 点击「+ 新建模板」，输入名称和描述，AI 自动生成采访问题。支持编辑 systemPrompt、增删改问题、设置必选/可选、编辑选项内容、重新生成问题<br/>
                • <b class="text-gray-800 dark:text-gray-200">知识库预设</b> — 内置菜谱已关联专业知识库，点击即可开始引导式写作
              </p>
            </div>
            <!-- 9. 知识库 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">9. 知识库</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                在<b class="text-gray-800 dark:text-gray-200">「知识库」</b>标签页管理 AI 参考资料：<br/>
                • <b class="text-gray-800 dark:text-gray-200">新建知识库</b> — 点击「+ 新建知识库」，选择 <b class="text-gray-800 dark:text-gray-200">.docx</b>、<b class="text-gray-800 dark:text-gray-200">.txt</b> 或 <b class="text-gray-800 dark:text-gray-200">.md</b> 文件，系统自动解析文本内容，名称自动规范化<br/>
                • <b class="text-gray-800 dark:text-gray-200">13 个内置知识库</b> — 企业概况、发展历程、经营管理、科技进步、市场开发、党的建设、企业英模、企业故事、文化基地、社会责任、文艺体育、亲切关怀、媒体宣传<br/>
                • <b class="text-gray-800 dark:text-gray-200">自定义知识库</b> — 可展开预览、编辑内容和删除<br/>
                • <b class="text-gray-800 dark:text-gray-200">跨模块引用</b> — 知识库可在 AI 对话、写作技能、写作菜谱中被引用，为 AI 提供专业领域知识
              </p>
            </div>
            <!-- 10. 素材库 & 浏览器剪藏 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">10. 素材库 &amp; 浏览器剪藏</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                左侧面板的<b class="text-gray-800 dark:text-gray-200">「素材」</b>子标签页管理写作素材和网页剪藏：<br/><br/>
                <b class="text-gray-800 dark:text-gray-200">标签管理</b><br/>
                • <b class="text-gray-800 dark:text-gray-200">创建标签</b> — 输入标签名，回车或点击创建，用于给素材分类<br/>
                • <b class="text-gray-800 dark:text-gray-200">重命名/删除</b> — 悬停标签名出现 ✎ 重命名和 ✕ 删除按钮<br/>
                • <b class="text-gray-800 dark:text-gray-200">未分类</b> — 默认视图，显示所有未绑定标签的素材<br/><br/>
                <b class="text-gray-800 dark:text-gray-200">素材管理</b><br/>
                • <b class="text-gray-800 dark:text-gray-200">存入素材库</b> — 编辑器中选中文字，右键 →「📦 存入素材库」，弹出 AI 自动打标签弹窗<br/>
                • <b class="text-gray-800 dark:text-gray-200">AI 打标签</b> — AI 自动建议匹配已有标签 + 推荐新标签，可快速勾选/输入<br/>
                • <b class="text-gray-800 dark:text-gray-200">编辑素材</b> — 点击素材进入编辑模式，内容自动保存（防抖 1 秒）<br/>
                • <b class="text-gray-800 dark:text-gray-200">标签文档</b> — 按标签将全部素材聚合为只读文档，便于统一浏览<br/><br/>
                <b class="text-gray-800 dark:text-gray-200">浏览器剪藏</b><br/>
                • <b class="text-gray-800 dark:text-gray-200">「浏览器」标签页</b> — 左侧面板第三个 Tab，内嵌 WebView 浏览器<br/>
                • <b class="text-gray-800 dark:text-gray-200">书签管理</b> — 添加/删除常用网址书签<br/>
                • <b class="text-gray-800 dark:text-gray-200">网页剪藏</b> — 浏览器中选中文字右键 →「存入 AiPen 素材库」，自动弹出剪藏弹窗<br/>
                • <b class="text-gray-800 dark:text-gray-200">窗口同步</b> — 浏览器窗口与主窗口联动定位和显示隐藏<br/><br/>
                <b class="text-gray-800 dark:text-gray-200">跨模块引用</b> — 素材库可在 AI 对话和写作技能中按标签引用。
              </p>
            </div>
            <!-- 11. 导出 Word -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">11. 导出 Word 文档</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                点击顶部工具栏 <b class="text-gray-800 dark:text-gray-200">导出 Word</b> 一键导出 .docx。点击 <b class="text-gray-800 dark:text-gray-200">⚙ 排版设置</b> 精细化控制：<br/>
                • <b class="text-gray-800 dark:text-gray-200">字体配置</b> — H1~H4 标题、正文、表格分别设置字体与字号（pt），默认方正字体族<br/>
                • <b class="text-gray-800 dark:text-gray-200">页面参数</b> — 上/下/左/右边距（mm），A4 纸标准<br/>
                • <b class="text-gray-800 dark:text-gray-200">文档网格</b> — 每行字数、每页行数（公文标准 28×22）、行间距（pt）、首行缩进（字符）<br/>
                • <b class="text-gray-800 dark:text-gray-200">完整排版</b> — 页脚居中页码、表格宋体五号、代码块 Consolas、图片自适应缩放<br/>
                • <b class="text-gray-800 dark:text-gray-200">XML 后处理</b> — 自动禁用孤行控制、标点溢出、网格对齐等，严格遵循公文排版规范<br/>
                • <b class="text-gray-800 dark:text-gray-200">恢复默认</b> — 一键重置为公文标准排版
              </p>
            </div>
            <!-- 12. API 设置 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">12. API 设置</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                在<b class="text-gray-800 dark:text-gray-200">「设置」</b>标签页配置 AI 服务：<br/>
                • <b class="text-gray-800 dark:text-gray-200">API 密钥</b> — 填写 DeepSeek API Key（格式：<b class="text-gray-800 dark:text-gray-200">sk-...</b>），点击 ❓ 查看申请步骤<br/>
                • <b class="text-gray-800 dark:text-gray-200">API 地址</b> — 默认 <b class="text-gray-800 dark:text-gray-200">https://api.deepseek.com</b>，兼容 OpenAI 格式，也可填写其他兼容地址<br/>
                • <b class="text-gray-800 dark:text-gray-200">模型选择</b> — <b class="text-gray-800 dark:text-gray-200">Flash</b>（轻量快速）或 <b class="text-gray-800 dark:text-gray-200">Pro</b>（深度品质）<br/>
                • <b class="text-gray-800 dark:text-gray-200">思考模式</b> — 开启后模型深度推理再回答。强度<b class="text-gray-800 dark:text-gray-200"> high</b> 兼顾速度，<b class="text-gray-800 dark:text-gray-200">max</b> 推理最充分<br/>
                • <b class="text-gray-800 dark:text-gray-200">测试连接 / 查询余额</b> — 验证 API 可用性和账户余额
              </p>
            </div>
            <!-- 13. 数据备份与恢复 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">13. 数据备份与恢复</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                在<b class="text-gray-800 dark:text-gray-200">「设置」</b>标签页底部管理数据安全：<br/>
                • <b class="text-gray-800 dark:text-gray-200">数据统计</b> — 查看当前文档、文件夹、知识库、素材、技能的数量<br/>
                • <b class="text-gray-800 dark:text-gray-200">按类别导出</b> — 可选文档、知识库、素材、技能等类别，打包为 <b class="text-gray-800 dark:text-gray-200">.aipen</b> 备份文件<br/>
                • <b class="text-gray-800 dark:text-gray-200">导入恢复</b> — 从备份文件恢复，自动去重（同名文档合并版本、同名文件夹跳过）<br/>
                建议定期导出备份，防止数据丢失。
              </p>
            </div>
            <!-- 14. 文档评分 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">14. 文档综合评分</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                标题栏旁点击 <b class="text-gray-800 dark:text-gray-200">⭐ 评分</b> 按钮，AI 对当前文档进行综合质量评分：<br/>
                • <b class="text-gray-800 dark:text-gray-200">综合评分</b> — 0~100 分，五星评级，附带鼓励语<br/>
                • <b class="text-gray-800 dark:text-gray-200">多维度评析</b> — 内容质量、逻辑结构、语言表达、规范合规等维度分别评分（带进度条）<br/>
                • <b class="text-gray-800 dark:text-gray-200">优先建议</b> — AI 给出的首要改进方向和具体建议<br/>
                • <b class="text-gray-800 dark:text-gray-200">自动缓存</b> — 评分结果自动保存，打开文档直接显示，可手动刷新重新评分<br/>
                • <b class="text-gray-800 dark:text-gray-200">版本独立评分</b> — 每个历史版本也可单独评分，评分与版本绑定
              </p>
            </div>
            <!-- 15. 编辑器高级功能 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-600 dark:text-gray-400">15. 编辑器高级功能</h3>
              <p class="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
                <b class="text-gray-800 dark:text-gray-200">查找替换</b> — Ctrl+F 打开，支持大小写、正则表达式、全词匹配、逐个替换和全部替换<br/>
                <b class="text-gray-800 dark:text-gray-200">右键菜单</b> — 剪切/复制/粘贴 + 「📦 存入素材库」 + 「💬 添加到 AI 对话」<br/>
                <b class="text-gray-800 dark:text-gray-200">标题/段落折叠</b> — 点击行号左侧箭头折叠标题及其子内容，当前行号高亮<br/>
                <b class="text-gray-800 dark:text-gray-200">Diff 回放动画</b> — 技能管道执行 / 审查 / 润色完成后，逐操作高亮展示改动的动画效果<br/>
                <b class="text-gray-800 dark:text-gray-200">侧栏折叠</b> — 左侧文档列表和右侧工具面板分别通过 ◀/▶ 按钮折叠，最大化编辑空间<br/>
                <b class="text-gray-800 dark:text-gray-200">纯文本提纯优化</b> — 所有 AI 调用（diff、分析、评分、对话、技能）自动从 ProseMirror JSON 提取纯文本，节省 2~3 倍 token 消耗
              </p>
            </div>
          </div>
          <!-- 底部版权（固定） -->
          <div class="px-5 py-3 border-t border-gray-200 dark:border-gray-800 shrink-0 rounded-b-xl text-center text-xs text-gray-500 dark:text-gray-600">
            大庆油田第七采油厂  |  陈刚 18088793359<br/>
            © 2026 AiPen. All rights reserved.
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 评分详情 Popover -->
    <Teleport to="body">
      <div
        v-if="scorePopoverShow && documentScore"
        class="fixed inset-0 z-[10002]"
        @click.self="scorePopoverShow = false"
      >
        <div
          class="absolute w-[380px] bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl shadow-2xl overflow-hidden"
          :style="{ left: '50%', top: '48px', transform: 'translateX(-50%)' }"
        >
          <!-- Header -->
          <div class="px-4 py-3 flex items-center justify-between border-b border-gray-200 dark:border-gray-800">
            <div class="flex items-center gap-2">
              <span class="text-lg">📊</span>
              <span class="text-sm font-semibold text-gray-800 dark:text-gray-200">
                综合评分
              </span>
            </div>
            <div class="flex items-center gap-1">
              <button
                class="h-6 w-6 flex items-center justify-center rounded text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                :class="{ 'animate-spin': scoreLoading }"
                :disabled="scoreLoading"
                title="刷新评分"
                @click="handleScoreDocument"
              >
                {{ scoreLoading ? '⏳' : '↻' }}
              </button>
              <button
                class="h-6 w-6 flex items-center justify-center rounded text-sm text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                @click="scorePopoverShow = false"
              >✕</button>
            </div>
          </div>
          <!-- Body -->
          <div class="p-4 space-y-4">
            <!-- 总分开场 -->
            <div class="text-center space-y-1">
              <div class="text-lg mb-1">{{ scoreStars(documentScore.total_score) }}</div>
              <div class="flex items-center justify-center gap-2">
                <span class="text-3xl font-bold" :class="scoreTextColor(documentScore.total_score)">
                  {{ documentScore.total_score }}
                </span>
                <span class="text-xs text-gray-400 dark:text-gray-500">/ 100</span>
              </div>
              <p class="text-sm font-medium" :class="scoreTextColor(documentScore.total_score)">{{ scoreTagline(documentScore.total_score) }}</p>
              <p class="text-sm text-gray-700 dark:text-gray-300 italic">"{{ documentScore.encouragement }}"</p>
            </div>
            <!-- 各维度 -->
            <div class="space-y-2.5">
              <div
                v-for="dim in documentScore.dimensions"
                :key="dim.name"
                class="space-y-1"
              >
                <div class="flex items-center justify-between text-xs">
                  <span class="text-gray-700 dark:text-gray-300 font-medium">{{ dim.name }}</span>
                  <span class="text-gray-400 dark:text-gray-500">{{ dim.score }}</span>
                </div>
                <div class="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-500"
                    :class="scoreBarColor(dim.score)"
                    :style="{ width: dim.score + '%' }"
                  />
                </div>
                <p class="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed">{{ dim.comment }}</p>
              </div>
            </div>
            <!-- 优先建议 -->
            <div class="bg-blue-400/15 dark:bg-blue-950/30 border border-blue-300/40 dark:border-blue-800/30 rounded-lg px-3 py-2 flex items-start gap-2">
              <span class="text-blue-400 text-xs mt-0.5">💡</span>
              <p class="text-xs text-blue-700 dark:text-blue-300">{{ documentScore.top_suggestion }}</p>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 侧栏右键菜单 -->
    <Teleport to="body">
      <div
        v-if="ctxMenu.show"
        class="fixed inset-0 z-[10005]"
        @click.self="onClickAwayContextMenu"
        @contextmenu.prevent="onClickAwayContextMenu"
      >
        <div
          class="absolute w-32 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl py-1"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        >
          <button
            class="w-full px-3 py-1.5 text-xs text-left text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors flex items-center gap-2"
            @click="handleReload"
          >
            <span>🔄</span> 刷新
          </button>
          <div class="h-px bg-gray-100 dark:bg-gray-800 mx-2 my-1" />
          <button
            class="w-full px-3 py-1.5 text-xs text-left text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-gray-100 transition-colors flex items-center gap-2"
            @click="handleShowAbout"
          >
            <span>ℹ️</span> 关于软件
          </button>
          <div class="h-px bg-gray-100 dark:bg-gray-800 mx-2 my-1" />
          <p class="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500 text-center select-none">当前版本：v{{ appVersion }}</p>
        </div>
      </div>
    </Teleport>

    <!-- 关于软件弹窗 -->
    <Teleport to="body">
      <div
        v-if="showAbout"
        class="fixed inset-0 z-[10003] flex items-center justify-center"
        @click.self="showAbout = false"
      >
        <div class="absolute inset-0 bg-black/50 backdrop-blur-md" />
        <div class="relative w-[420px] rounded-2xl shadow-2xl overflow-hidden bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700">
          <!-- 星空画布 -->
          <div class="relative h-48 overflow-hidden">
            <canvas
              ref="aboutCanvasRef"
              class="absolute inset-0 w-full h-full"
            />
            <div class="absolute inset-0 flex flex-col items-center justify-center">
              <div class="text-5xl mb-2">✒️</div>
              <h2 class="text-2xl font-bold text-white tracking-wider">AiPen</h2>
              <p class="text-sm text-blue-700 dark:text-blue-300 mt-1 font-mono">v{{ appVersion }}</p>
            </div>
          </div>
          <!-- 信息区 -->
          <div class="px-6 py-5 space-y-3">
            <p class="text-sm text-gray-600 dark:text-gray-400 text-center leading-relaxed">
              智能写作助手 — 基于大语言模型的<br/>全流程 AI 辅助写作工具
            </p>
            <div class="flex items-center justify-center gap-4 text-xs text-gray-400 dark:text-gray-500 pt-2">
              <span>⚡ 内置 DeepSeek</span>
              <span>📝 管道式写作</span>
              <span>🔍 Diff 审查</span>
            </div>
          </div>
          <!-- 底部 -->
          <div class="px-6 py-3 border-t border-gray-200 dark:border-gray-800 text-center text-xs text-gray-500 dark:text-gray-600">
            大庆油田第七采油厂 ｜ 陈刚 18088793359<br/>
            © 2026 AiPen. All rights reserved.
          </div>
          <!-- 关闭按钮 -->
          <button
            class="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full bg-gray-100/70 dark:bg-gray-800/60 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors no-drag"
            @click="showAbout = false"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.drag-region {
  -webkit-app-region: drag;
}
.no-drag {
  -webkit-app-region: no-drag;
}

/* 炫彩文字流光 */
@keyframes shimmer-progress {
  0% { background-position: 200% center; }
  100% { background-position: -200% center; }
}
.animate-shimmer-progress {
  animation: shimmer-progress 3s linear infinite;
}

/* 跑马灯小方块闪烁 */
@keyframes marquee-sq {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.1); }
}
.animate-marquee-sq {
  animation: marquee-sq 1.2s ease-in-out infinite;
}
</style>
