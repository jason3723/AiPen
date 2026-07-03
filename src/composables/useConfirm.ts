import { ref, type Ref } from "vue";
import type { ConfirmOptions } from "../components/ConfirmDialog.vue";

const dialogRef: Ref<{ show: (opts: ConfirmOptions) => Promise<boolean> } | null> = ref(null);

export function registerConfirmDialog(instance: { show: (opts: ConfirmOptions) => Promise<boolean> }) {
  dialogRef.value = instance;
}

export function useConfirm() {
  function confirm(opts: ConfirmOptions): Promise<boolean> {
    if (!dialogRef.value) {
      // 回退：使用浏览器 confirm
      return Promise.resolve(window.confirm(opts.message));
    }
    return dialogRef.value.show(opts);
  }

  return { confirm };
}
