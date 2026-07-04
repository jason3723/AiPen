import { ref, watch } from "vue";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "aipen-theme";
const DARK_CLASS = "dark";

/** 从 localStorage 读取持久化主题 */
function loadTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage 不可用
  }
  // 无历史记录时默认浅色
  return "light";
}

/** 保存到 localStorage */
function saveTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 忽略
  }
}

/** 应用主题到 <html> 元素 */
function applyThemeClass(mode: ThemeMode) {
  if (mode === "dark") {
    document.documentElement.classList.add(DARK_CLASS);
  } else {
    document.documentElement.classList.remove(DARK_CLASS);
  }
}

// ── 全局单例 ──
const isDark = ref(loadTheme() === "dark");

// 初始化时立即应用
applyThemeClass(isDark.value ? "dark" : "light");

// 持久化 + 同步 DOM
watch(isDark, (val) => {
  const mode: ThemeMode = val ? "dark" : "light";
  saveTheme(mode);
  applyThemeClass(mode);
});

/** 切换主题 */
function toggleTheme() {
  isDark.value = !isDark.value;
}

/** 设置主题 */
function setTheme(mode: ThemeMode) {
  isDark.value = mode === "dark";
}

export function useTheme() {
  return {
    isDark,
    toggleTheme,
    setTheme,
  };
}
