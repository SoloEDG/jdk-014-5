import type {
  Bookmark,
  ComicDocument,
  ReadingLocation,
} from "../../../shared/document";
import { makeId } from "../../../shared/commands";
import { hashText } from "./hash";
import {
  cloneSession,
  hashDocument,
  imageRef,
  toStructural,
  type SessionSnapshot,
} from "./snapshot";
import type { BaseRecord } from "./baseStore";
import { stamp } from "./download";
// 作品文件：两台电脑之间离线传递的全部状态。
// document 中的图片以 "asset:<指纹>" 引用 assets 表（同一图片只存一次，
// 复制页面不会重复占用体积）；base 只存图片指纹，不带图片本体。
export interface WorkFilePayload {
  fileId: string;
  created: number;
  docHash: string;
  document: ComicDocument; // 已还原图片
  bookmarks: Bookmark[];
  location: ReadingLocation;
  base: ComicDocument | null; // 结构化快照
  baseHash: string | null;
  baseChain: string[];
  baseBookmarks: Bookmark[];
  baseLocation: ReadingLocation | null;
}
interface WorkFileJson {
  format: string;
  version: number;
  fileId: string;
  created: number;
  docHash: string;
  baseHash: string | null;
  baseChain: string[];
  assets: Record<string, string>;
  document: ComicDocument;
  bookmarks: Bookmark[];
  location: ReadingLocation;
  base: ComicDocument | null;
  baseBookmarks: Bookmark[];
  baseLocation: ReadingLocation | null;
}
export function buildWorkFile(
  session: SessionSnapshot,
  baseRecord: BaseRecord | null,
): { name: string; text: string } {
  const assets: Record<string, string> = {};
  const document = cloneSession(session).document;
  for (const c of document.chapters)
    for (const p of c.pages) {
      const hash = imageRef(p.image);
      assets[hash] = p.image;
      p.image = `asset:${hash}`;
    }
  const base = baseRecord?.base ?? toStructural(session.document);
  const file: WorkFileJson = {
    format: "panel-work",
    version: 1,
    fileId: makeId("work"),
    created: Date.now(),
    docHash: hashDocument(session.document),
    baseHash: baseRecord?.baseHash ?? hashDocument(base),
    baseChain: baseRecord?.chain ?? [],
    assets,
    document,
    bookmarks: cloneSession(session).bookmarks,
    location: cloneSession(session).location,
    base,
    baseBookmarks: baseRecord?.bookmarks ?? [],
    baseLocation: baseRecord?.location ?? null,
  };
  const title = session.document.title.replace(/[\\/:*?"<>|]/g, "") || "comic";
  return { name: `${title}-${stamp()}.panel.json`, text: JSON.stringify(file) };
}
function checkDocument(doc: ComicDocument, structural: boolean): string | null {
  if (doc?.version !== 1 || !Array.isArray(doc.chapters) || !doc.chapters.length)
    return "作品数据不完整";
  for (const c of doc.chapters) {
    if (!Array.isArray(c.pages) || !c.pages.length) return "作品数据不完整";
    for (const p of c.pages) {
      if (!Array.isArray(p.panels) || !p.panels.length || typeof p.image !== "string")
        return "作品数据不完整";
      if (structural && !p.image.startsWith("hash:")) return "文件已损坏";
      if (!structural && !p.image.startsWith("asset:")) return "文件已损坏";
    }
  }
  return null;
}
export function parseWorkFile(text: string): WorkFilePayload {
  if (text.length > 90_000_000) throw new Error("文件过大，无法导入");
  let file: WorkFileJson;
  try {
    file = JSON.parse(text) as WorkFileJson;
  } catch {
    throw new Error("不是有效的 JSON 文件");
  }
  if (file?.format !== "panel-work") throw new Error("不是 PANEL 作品文件");
  if (file.version !== 1) throw new Error("文件版本不兼容，请升级后再导入");
  if (typeof file.assets !== "object" || !file.assets)
    throw new Error("文件缺少图片数据");
  const docError = checkDocument(file.document, false);
  if (docError) throw new Error(docError);
  const document = file.document;
  for (const c of document.chapters)
    for (const p of c.pages) {
      const hash = p.image.slice("asset:".length);
      const image = file.assets[hash];
      if (!image || hashText(image) !== hash)
        throw new Error("文件缺少图片数据或已损坏");
      p.image = image;
    }
  if (hashDocument(document) !== file.docHash)
    throw new Error("文件内容校验失败，可能已被修改");
  if (file.base) {
    const baseError = checkDocument(file.base, true);
    if (baseError) throw new Error(baseError);
  }
  if (!Array.isArray(file.bookmarks) || !file.location)
    throw new Error("作品数据不完整");
  return {
    fileId: String(file.fileId ?? ""),
    created: Number(file.created) || 0,
    docHash: file.docHash,
    document,
    bookmarks: file.bookmarks,
    location: file.location,
    base: file.base ?? null,
    baseHash: file.baseHash ?? null,
    baseChain: Array.isArray(file.baseChain) ? file.baseChain : [],
    baseBookmarks: Array.isArray(file.baseBookmarks) ? file.baseBookmarks : [],
    baseLocation: file.baseLocation ?? null,
  };
}
