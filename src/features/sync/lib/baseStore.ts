import type { ComicDocument, Bookmark, ReadingLocation } from "../../../shared/document";
// 共同起点记录：双方分歧前最后一次一致的状态。
// 独立于会话存储——会话每次翻页都会重写，起点只在导出/合并时变化。
export interface BaseRecord {
  baseHash: string;
  chain: string[]; // 历代起点哈希（旧→新），用于在两条演化线中找最近共同祖先
  base: ComicDocument; // 结构化快照（图片只有指纹）
  bookmarks: Bookmark[];
  location: ReadingLocation;
  lastFileId?: string;
}
const KEY = "panel-jdk014-base-v1";
export function readBase(): BaseRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as BaseRecord;
    if (
      typeof value?.baseHash !== "string" ||
      !Array.isArray(value.chain) ||
      !Array.isArray(value.base?.chapters) ||
      !Array.isArray(value.bookmarks) ||
      !value.location
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function writeBase(record: BaseRecord): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(record));
    return true;
  } catch {
    return false; // 配额不足时仅保留在内存，合并与导出不受影响
  }
}
export function clearBase() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}
