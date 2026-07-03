import { defineStore } from "pinia";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ExportSettings } from "../utils/exportWord";
import { DEFAULT_EXPORT_SETTINGS } from "../utils/exportWord";

export const useExportSettingsStore = defineStore("exportSettings", () => {
  const settings = ref<ExportSettings>({ ...DEFAULT_EXPORT_SETTINGS });
  const currentDocId = ref<string>("");
  let _saveTimer: ReturnType<typeof setTimeout> | null = null;
  let _suppressSave = false;

  /** 从数据库加载指定文档的排版设置，若为空则使用默认值 */
  async function loadForDocument(docId: string) {
    currentDocId.value = docId;
    try {
      const json = await invoke<string | null>("get_document_export_settings", { docId });
      if (json) {
        const parsed = JSON.parse(json) as ExportSettings;
        // 补全可能缺失的字段（兼容旧数据格式）
        settings.value = { ...DEFAULT_EXPORT_SETTINGS, ...parsed };
      } else {
        settings.value = { ...DEFAULT_EXPORT_SETTINGS };
      }
    } catch {
      // 加载失败回退默认值
      settings.value = { ...DEFAULT_EXPORT_SETTINGS };
    }
  }

  /** 保存当前设置到数据库（仅当已关联文档时） */
  async function saveCurrent() {
    if (!currentDocId.value) return;
    const docId = currentDocId.value;
    const json = JSON.stringify(settings.value);
    try {
      await invoke("save_document_export_settings", { docId, settingsJson: json });
    } catch {
      // 保存失败静默忽略
    }
  }

  /** 防抖保存（300ms） */
  function scheduleSave() {
    if (_suppressSave) return;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      saveCurrent();
    }, 300);
  }

  /** 重置为默认值 */
  function reset() {
    settings.value = { ...DEFAULT_EXPORT_SETTINGS };
    scheduleSave();
  }

  /** 部分更新设置 */
  function update(partial: Partial<ExportSettings>) {
    settings.value = { ...settings.value, ...partial };
    scheduleSave();
  }

  /** 静默设置（不触发保存），用于批量替换 */
  function setSilent(s: ExportSettings) {
    _suppressSave = true;
    settings.value = { ...s };
    setTimeout(() => { _suppressSave = false; }, 0);
  }

  return { settings, currentDocId, loadForDocument, saveCurrent, reset, update, setSilent };
});
