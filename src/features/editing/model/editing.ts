import { ref, type Ref } from "vue";
import type { ComicDocument, ReadingLocation } from "../../../shared/document";
import { readImageFile } from "../../../shared/image";
import {
  deletePage,
  duplicatePage,
  movePage,
  replacePageImage,
  updatePanel,
  type PanelDraft,
} from "../lib/operations";
export function useEditing(
  doc: Ref<ComicDocument>,
  location: Ref<ReadingLocation>,
  changed: () => void,
  jump: (pageId: string) => void,
) {
  const message = ref("");
  function move(delta: number) {
    if (movePage(doc.value, location.value.chapterId, location.value.pageId, delta)) {
      changed();
      message.value = "已调整页面顺序";
    }
  }
  function duplicate() {
    const id = duplicatePage(doc.value, location.value.chapterId, location.value.pageId);
    if (id) {
      changed();
      jump(id);
      message.value = "已复制本页（新页面是独立对象）";
    }
  }
  function remove() {
    if (!deletePage(doc.value, location.value.chapterId, location.value.pageId)) {
      message.value = "每章至少保留一页";
      return;
    }
    changed();
    message.value = "已删除本页";
  }
  async function replaceImage(file: File) {
    try {
      const data = await readImageFile(file);
      if (!replacePageImage(doc.value, location.value.pageId, data.image, data.width, data.height))
        throw new Error("找不到要替换的页面");
      changed();
      message.value = "已替换本页图片";
    } catch (error) {
      message.value = error instanceof Error ? error.message : "图片读取失败";
    }
  }
  function savePanel(draft: PanelDraft) {
    if (!updatePanel(doc.value, location.value.panelId, draft)) {
      message.value = "分镜内容不符合要求：角色 1–20 字、对白不超过 200 字、时长 1–60 秒";
      return;
    }
    changed();
    message.value = "已保存分镜";
  }
  return { message, move, duplicate, remove, replaceImage, savePanel };
}
