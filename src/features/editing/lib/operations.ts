import type { ComicDocument, Panel } from "../../../shared/document";
import { makeId } from "../../../shared/commands";
function findChapter(doc: ComicDocument, chapterId: string) {
  return doc.chapters.find((c) => c.id === chapterId);
}
export function movePage(
  doc: ComicDocument,
  chapterId: string,
  pageId: string,
  delta: number,
): boolean {
  const chapter = findChapter(doc, chapterId);
  if (!chapter) return false;
  const i = chapter.pages.findIndex((p) => p.id === pageId),
    j = i + delta;
  if (i < 0 || j < 0 || j >= chapter.pages.length) return false;
  const [page] = chapter.pages.splice(i, 1);
  chapter.pages.splice(j, 0, page!);
  return true;
}
export function deletePage(
  doc: ComicDocument,
  chapterId: string,
  pageId: string,
): boolean {
  const chapter = findChapter(doc, chapterId);
  if (!chapter || chapter.pages.length < 2) return false;
  const i = chapter.pages.findIndex((p) => p.id === pageId);
  if (i < 0) return false;
  chapter.pages.splice(i, 1);
  return true;
}
// 复制页面：页与分镜都分配新 id，是独立的新对象，不与原页混淆。
export function duplicatePage(
  doc: ComicDocument,
  chapterId: string,
  pageId: string,
): string | null {
  const chapter = findChapter(doc, chapterId);
  const i = chapter?.pages.findIndex((p) => p.id === pageId) ?? -1;
  if (!chapter || i < 0) return null;
  const source = chapter.pages[i]!;
  const copy: typeof source = JSON.parse(JSON.stringify(source));
  copy.id = makeId("page");
  copy.title = `${source.title} 副本`;
  copy.panels = copy.panels.map((p) => ({ ...p, id: makeId("panel") }));
  chapter.pages.splice(i + 1, 0, copy);
  return copy.id;
}
export function replacePageImage(
  doc: ComicDocument,
  pageId: string,
  image: string,
  width: number,
  height: number,
): boolean {
  for (const c of doc.chapters) {
    const page = c.pages.find((p) => p.id === pageId);
    if (page) {
      page.image = image;
      page.width = width;
      page.height = height;
      return true;
    }
  }
  return false;
}
export interface PanelDraft {
  dialogue: string;
  speaker: string;
  sound: Panel["sound"];
  duration: number;
}
export function updatePanel(
  doc: ComicDocument,
  panelId: string,
  draft: PanelDraft,
): boolean {
  const dialogue = draft.dialogue.trim(),
    speaker = draft.speaker.trim(),
    duration = Math.round(draft.duration);
  if (dialogue.length > 200 || !speaker || speaker.length > 20) return false;
  if (!["rain", "pulse", "wind"].includes(draft.sound)) return false;
  if (!Number.isFinite(duration) || duration < 1 || duration > 60) return false;
  for (const c of doc.chapters)
    for (const p of c.pages) {
      const panel = p.panels.find((p) => p.id === panelId);
      if (panel) {
        panel.dialogue = dialogue;
        panel.speaker = speaker;
        panel.sound = draft.sound;
        panel.duration = duration;
        return true;
      }
    }
  return false;
}
