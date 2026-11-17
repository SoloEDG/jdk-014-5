import type {
  Bookmark,
  ComicDocument,
  ReadingLocation,
} from "../../../shared/document";
import { hashText, hashValue } from "./hash";
// 一份完整的作品状态：文档 + 阅读位置 + 书签。
export interface SessionSnapshot {
  document: ComicDocument;
  location: ReadingLocation;
  bookmarks: Bookmark[];
}
// 图片的内容引用。数据本体可能是 dataURL（当前文档），
// 也可能是 "hash:<指纹>"（共同起点快照，只存指纹不存图片）。
export function imageRef(image: string): string {
  return image.startsWith("hash:") || image.startsWith("asset:")
    ? image.slice(image.indexOf(":") + 1)
    : hashText(image);
}
// 结构化快照：把每张图片替换为内容指纹，体积小，可安全存入 localStorage。
export function toStructural(doc: ComicDocument): ComicDocument {
  return clone({
    ...doc,
    chapters: doc.chapters.map((c) => ({
      ...c,
      pages: c.pages.map((p) => ({ ...p, image: `hash:${imageRef(p.image)}` })),
    })),
  });
}
export function hashDocument(doc: ComicDocument): string {
  return hashValue(toStructural(doc));
}
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function cloneSession(s: SessionSnapshot): SessionSnapshot {
  return clone(s);
}
