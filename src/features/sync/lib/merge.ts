import type {
  Bookmark,
  Chapter,
  ComicDocument,
  ComicPage,
  Panel,
  ReadingLocation,
} from "../../../shared/document";
import { firstLocation, resolveLocation } from "../../../shared/lookup";
import { cloneSession, type SessionSnapshot } from "./snapshot";
import type { MergeItem, MergePlan } from "./diff";
export interface MergeReport {
  chaptersAdded: number;
  chaptersRemoved: number;
  pagesAdded: number;
  pagesRemoved: number;
  panelsAdded: number;
  panelsRemoved: number;
  fieldsChanged: number;
  ordersChanged: number;
  bookmarksAdded: number;
  bookmarksRemoved: number;
  bookmarksDropped: number;
  bytesAdded: number;
  bytesRemoved: number;
  discardedIncoming: number;
  discardedLocal: number;
  warnings: string[];
}
function emptyReport(): MergeReport {
  return {
    chaptersAdded: 0,
    chaptersRemoved: 0,
    pagesAdded: 0,
    pagesRemoved: 0,
    panelsAdded: 0,
    panelsRemoved: 0,
    fieldsChanged: 0,
    ordersChanged: 0,
    bookmarksAdded: 0,
    bookmarksRemoved: 0,
    bookmarksDropped: 0,
    bytesAdded: 0,
    bytesRemoved: 0,
    discardedIncoming: 0,
    discardedLocal: 0,
    warnings: [],
  };
}
const imageBytes = (p: ComicPage) => p.image.length;
const chapterBytes = (c: Chapter) =>
  c.pages.reduce((n, p) => n + imageBytes(p), 0);
// 按参照序列（对方版本的 id 顺序）把新增实体插到相近位置。
function insertAt<T extends { id: string }>(
  container: T[],
  entity: T,
  referenceIds: string[],
) {
  const idx = referenceIds.indexOf(entity.id);
  for (let k = idx - 1; k >= 0; k--) {
    const at = container.findIndex((x) => x.id === referenceIds[k]);
    if (at >= 0) {
      container.splice(at + 1, 0, entity);
      return;
    }
  }
  for (let k = idx + 1; k < referenceIds.length; k++) {
    const at = container.findIndex((x) => x.id === referenceIds[k]);
    if (at >= 0) {
      container.splice(at, 0, entity);
      return;
    }
  }
  container.push(entity);
}
// 以选中一方的顺序为骨架重排；本机独有的条目跟在原来的相邻项之后。
function applyOrder<T extends { id: string }>(current: T[], chosen: string[]): T[] {
  const byId = new Map(current.map((x) => [x.id, x]));
  const used = new Set<string>();
  const result: T[] = [];
  for (const id of chosen) {
    const e = byId.get(id);
    if (e && !used.has(id)) {
      result.push(e);
      used.add(id);
    }
  }
  current.forEach((e, idx) => {
    if (used.has(e.id)) return;
    let at = -1;
    for (let k = idx - 1; k >= 0; k--) {
      const pos = result.findIndex((r) => r.id === current[k]!.id);
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    result.splice(at < 0 ? 0 : at, 0, e);
    used.add(e.id);
  });
  return result;
}
function normalizeLocation(
  doc: ComicDocument,
  at: ReadingLocation,
): ReadingLocation {
  const { chapter, page, panel } = resolveLocation(doc, at);
  if (!chapter || !page || !panel) return firstLocation(doc);
  return {
    ...at,
    chapterId: chapter.id,
    pageId: page.id,
    panelId: panel.id,
    zoom: Math.max(1, Math.min(3, at.zoom)),
    x: Number.isFinite(at.x) ? at.x : 0,
    y: Number.isFinite(at.y) ? at.y : 0,
  };
}
export function applyMerge(
  plan: MergePlan,
  decisions: Record<string, string>,
): { session: SessionSnapshot; report: MergeReport } {
  const report = emptyReport();
  const eff = (item: MergeItem) =>
    decisions[item.key] ?? item.default ?? item.options[0]?.value ?? "";
  const out = cloneSession(plan.local);
  const inChapters = new Map(plan.incoming.document.chapters.map((c) => [c.id, c]));
  const inPages = new Map<string, { page: ComicPage; chapter: Chapter }>();
  const inPanels = new Map<string, Panel>();
  for (const c of plan.incoming.document.chapters)
    for (const p of c.pages) {
      inPages.set(p.id, { page: p, chapter: c });
      for (const panel of p.panels) inPanels.set(panel.id, panel);
    }
  const inBookmarks = new Map(plan.incoming.bookmarks.map((b) => [b.id, b]));
  const idRemapPage = new Map<string, string>();
  const idRemapPanel = new Map<string, string>();
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  // —— 字段应用：out 已带着本机内容，只需写入“对方”来源与冲突选择 ——
  function assignField(
    target: Record<string, any>,
    key: string,
    source: Record<string, any> | undefined,
  ) {
    if (!source) return;
    target[key] = clone(source[key]);
    if (key === "image") {
      target.width = source.width;
      target.height = source.height;
    }
  }
  function applyFields(
    item: MergeItem,
    target: Record<string, any>,
    localSrc: Record<string, any> | undefined,
    incomingSrc: Record<string, any> | undefined,
  ) {
    const choice = eff(item);
    for (const [key, side] of Object.entries(item.fieldMerge ?? {}))
      if (side === "incoming") assignField(target, key, incomingSrc);
    for (const c of item.conflictFields ?? [])
      assignField(target, c.key, choice === "incoming" ? incomingSrc : localSrc);
    report.fieldsChanged++;
  }
  function noteDupPage(pageId: string, matchId: string) {
    const incoming = inPages.get(pageId)?.page;
    const local = out.document.chapters
      .flatMap((c) => c.pages)
      .find((p) => p.id === matchId);
    if (!incoming || !local) return;
    idRemapPage.set(pageId, local.id);
    if (incoming.panels.length === local.panels.length)
      incoming.panels.forEach((p, n) =>
        idRemapPanel.set(p.id, local.panels[n]!.id),
      );
  }
  function noteDupChapter(chapterId: string, matchId: string) {
    const incoming = inChapters.get(chapterId);
    const local = out.document.chapters.find((c) => c.id === matchId);
    if (!incoming || !local) return;
    incoming.pages.forEach((p, n) => {
      const lp = local.pages[n];
      if (lp) {
        idRemapPage.set(p.id, lp.id);
        p.panels.forEach((panel, m) => {
          const lp2 = lp.panels[m];
          if (lp2) idRemapPanel.set(panel.id, lp2.id);
        });
      }
    });
  }
  const items = plan.items;
  // —— 章节结构 ——
  function removeChapter(id: string) {
    const idx = out.document.chapters.findIndex((c) => c.id === id);
    if (idx < 0) return;
    report.bytesRemoved += chapterBytes(out.document.chapters[idx]!);
    out.document.chapters.splice(idx, 1);
    report.chaptersRemoved++;
  }
  function insertChapter(id: string) {
    if (out.document.chapters.some((c) => c.id === id)) return;
    const source = inChapters.get(id);
    if (!source) return;
    insertAt(
      out.document.chapters,
      clone(source),
      plan.incoming.document.chapters.map((c) => c.id),
    );
    report.chaptersAdded++;
    report.bytesAdded += chapterBytes(source);
  }
  for (const item of items.filter((i) => i.kind === "chapter")) {
    const choice = eff(item),
      id = item.chapterId!;
    if (item.action === "remove" && choice === "incoming") removeChapter(id);
    else if (item.action === "add") {
      if (choice === "incoming") insertChapter(id);
      else if (choice === "skip" && item.dup) noteDupChapter(id, item.dup.matchId);
    } else if (item.action === "restore" && choice === "incoming")
      insertChapter(id);
    else if (item.action === "replace" && choice === "incoming") {
      removeChapter(id);
      insertChapter(id);
    } else if (item.action === "fields") {
      const target = out.document.chapters.find((c) => c.id === id);
      if (target)
        applyFields(
          item,
          target,
          plan.local.document.chapters.find((c) => c.id === id),
          inChapters.get(id),
        );
    }
  }
  // —— 删除 vs 书签 冲突（章） ——
  for (const item of items.filter(
    (i) => i.kind === "link" && i.link?.entityKind === "chapter",
  )) {
    const choice = eff(item),
      id = item.chapterId!;
    if (choice === "drop") removeChapter(id);
    else if (choice === "keep" && item.link!.deletedBy === "local")
      insertChapter(id);
  }
  // —— 章节顺序 ——
  const rootOrder = items.find(
    (i) => i.kind === "order" && i.order?.containerId === "$root",
  );
  if (rootOrder) {
    const choice = eff(rootOrder);
    const useIncoming =
      choice === "incoming" || (choice === "auto" && rootOrder.hasIncoming);
    out.document.chapters = applyOrder(
      out.document.chapters,
      useIncoming ? rootOrder.order!.incoming : rootOrder.order!.local,
    );
    report.ordersChanged++;
  }
  // —— 页面 ——
  function removePage(chapterId: string, pageId: string) {
    const chapter = out.document.chapters.find((c) => c.id === chapterId);
    if (!chapter) return;
    const idx = chapter.pages.findIndex((p) => p.id === pageId);
    if (idx < 0) return;
    report.bytesRemoved += imageBytes(chapter.pages[idx]!);
    chapter.pages.splice(idx, 1);
    report.pagesRemoved++;
  }
  function insertPage(chapterId: string, pageId: string) {
    const chapter = out.document.chapters.find((c) => c.id === chapterId);
    const found = inPages.get(pageId);
    if (!chapter || !found) return;
    if (chapter.pages.some((p) => p.id === pageId)) return;
    insertAt(
      chapter.pages,
      clone(found.page),
      found.chapter.pages.map((p) => p.id),
    );
    report.pagesAdded++;
    report.bytesAdded += imageBytes(found.page);
  }
  for (const item of items.filter((i) => i.kind === "page")) {
    const choice = eff(item),
      cid = item.chapterId!,
      pid = item.pageId!;
    if (item.action === "remove" && choice === "incoming") removePage(cid, pid);
    else if (item.action === "add") {
      if (choice === "incoming") insertPage(cid, pid);
      else if (choice === "skip" && item.dup) noteDupPage(pid, item.dup.matchId);
    } else if (item.action === "restore" && choice === "incoming")
      insertPage(cid, pid);
    else if (item.action === "replace" && choice === "incoming") {
      removePage(cid, pid);
      insertPage(cid, pid);
    } else if (item.action === "fields") {
      const chapter = out.document.chapters.find((c) => c.id === cid);
      const target = chapter?.pages.find((p) => p.id === pid);
      if (target)
        applyFields(
          item,
          target,
          plan.local.document.chapters
            .find((c) => c.id === cid)
            ?.pages.find((p) => p.id === pid),
          inPages.get(pid)?.page,
        );
    }
  }
  for (const item of items.filter(
    (i) => i.kind === "link" && i.link?.entityKind === "page",
  )) {
    const choice = eff(item);
    if (choice === "drop") removePage(item.chapterId!, item.pageId!);
    else if (choice === "keep" && item.link!.deletedBy === "local")
      insertPage(item.chapterId!, item.pageId!);
  }
  // —— 页面顺序（逐章） ——
  for (const item of items.filter(
    (i) => i.kind === "order" && i.order && i.order.containerId !== "$root",
  )) {
    const containerId = item.order!.containerId;
    const isPageOrder = out.document.chapters.some((c) => c.id === containerId);
    if (!isPageOrder) continue;
    const chapter = out.document.chapters.find((c) => c.id === containerId);
    if (!chapter) continue;
    const choice = eff(item);
    const useIncoming =
      choice === "incoming" || (choice === "auto" && item.hasIncoming);
    chapter.pages = applyOrder(
      chapter.pages,
      useIncoming ? item.order!.incoming : item.order!.local,
    );
    report.ordersChanged++;
  }
  // —— 分镜 ——
  function findPage(id: string) {
    for (const c of out.document.chapters) {
      const p = c.pages.find((p) => p.id === id);
      if (p) return p;
    }
    return undefined;
  }
  for (const item of items.filter((i) => i.kind === "panel")) {
    const choice = eff(item),
      page = findPage(item.pageId!);
    if (!page) continue;
    const pid = item.panelId!;
    if (item.action === "remove" && choice === "incoming") {
      const idx = page.panels.findIndex((p) => p.id === pid);
      if (idx >= 0) {
        page.panels.splice(idx, 1);
        report.panelsRemoved++;
      }
    } else if (item.action === "add" && choice === "incoming") {
      const source = inPanels.get(pid);
      if (source && !page.panels.some((p) => p.id === pid)) {
        const ref = inPages.get(item.pageId!)?.page.panels.map((p) => p.id) ?? [];
        insertAt(page.panels, clone(source), ref);
        report.panelsAdded++;
      }
    } else if (item.action === "restore" && choice === "incoming") {
      const source = inPanels.get(pid);
      if (source && !page.panels.some((p) => p.id === pid)) {
        const ref = inPages.get(item.pageId!)?.page.panels.map((p) => p.id) ?? [];
        insertAt(page.panels, clone(source), ref);
        report.panelsAdded++;
      }
    } else if (item.action === "replace" && choice === "incoming") {
      const source = inPanels.get(pid);
      const idx = page.panels.findIndex((p) => p.id === pid);
      if (source && idx >= 0) page.panels[idx] = clone(source);
    } else if (item.action === "fields") {
      const target = page.panels.find((p) => p.id === pid);
      if (target)
        applyFields(
          item,
          target,
          plan.local.document.chapters
            .flatMap((c) => c.pages)
            .find((p) => p.id === item.pageId)
            ?.panels.find((p) => p.id === pid),
          inPanels.get(pid),
        );
    }
  }
  // —— 分镜顺序（逐页） ——
  for (const item of items.filter((i) => i.kind === "order" && i.order)) {
    const containerId = item.order!.containerId;
    if (containerId === "$root") continue;
    if (out.document.chapters.some((c) => c.id === containerId)) continue;
    const page = findPage(containerId);
    if (!page) continue;
    const choice = eff(item);
    const useIncoming =
      choice === "incoming" || (choice === "auto" && item.hasIncoming);
    page.panels = applyOrder(
      page.panels,
      useIncoming ? item.order!.incoming : item.order!.local,
    );
    report.ordersChanged++;
  }
  // —— 作品信息 ——
  for (const item of items.filter(
    (i) => i.kind === "meta" && i.action === "fields",
  ))
    applyFields(
      item,
      out.document,
      plan.local.document,
      plan.incoming.document,
    );
  // —— 书签 ——
  const remapLocation = (m: Bookmark): Bookmark => {
    const copy = clone(m);
    copy.location.pageId =
      idRemapPage.get(copy.location.pageId) ?? copy.location.pageId;
    copy.location.panelId =
      idRemapPanel.get(copy.location.panelId) ?? copy.location.panelId;
    return copy;
  };
  for (const item of items.filter((i) => i.kind === "bookmark")) {
    const choice = eff(item),
      id = item.bookmarkId!;
    if (item.action === "add" && choice === "incoming") {
      const source = inBookmarks.get(id);
      if (source && !out.bookmarks.some((b) => b.id === id)) {
        out.bookmarks.push(remapLocation(source));
        report.bookmarksAdded++;
      }
    } else if (item.action === "remove" && choice === "incoming") {
      const before = out.bookmarks.length;
      out.bookmarks = out.bookmarks.filter((b) => b.id !== id);
      if (out.bookmarks.length < before) report.bookmarksRemoved++;
    } else if (
      item.action === "replace" &&
      (choice === "incoming" || choice === "auto")
    ) {
      const source = inBookmarks.get(id);
      const idx = out.bookmarks.findIndex((b) => b.id === id);
      if (source && idx >= 0) out.bookmarks[idx] = remapLocation(source);
    }
  }
  // 删除 vs 书签：保留 → 补上对方的书签；丢弃 → 移除指向已删实体的书签
  for (const item of items.filter((i) => i.kind === "link")) {
    const choice = eff(item),
      link = item.link!;
    if (choice === "keep" && link.bookmarksFrom === "incoming") {
      for (const id of link.bookmarkIds) {
        const source = inBookmarks.get(id);
        if (source && !out.bookmarks.some((b) => b.id === id)) {
          out.bookmarks.push(remapLocation(source));
          report.bookmarksAdded++;
        }
      }
    } else if (choice === "drop" && link.bookmarksFrom === "local") {
      const drop = new Set(link.bookmarkIds);
      const before = out.bookmarks.length;
      out.bookmarks = out.bookmarks.filter((b) => !drop.has(b.id));
      report.bookmarksDropped += before - out.bookmarks.length;
    } else if (choice === "drop" && link.bookmarksFrom === "incoming") {
      report.bookmarksDropped += link.bookmarkIds.length;
    }
  }
  // 同一分镜只留一个书签
  const seen = new Set<string>();
  out.bookmarks = out.bookmarks.filter((b) => {
    const key = `${b.location.pageId}:${b.location.panelId}`;
    if (seen.has(key)) {
      report.bookmarksRemoved++;
      return false;
    }
    seen.add(key);
    return true;
  });
  // —— 兜底：每章至少一页、全书至少一章 ——
  out.document.chapters = out.document.chapters.filter((c) => {
    if (c.pages.length) return true;
    report.warnings.push(`「${c.title}」已没有页面，整章移除`);
    return false;
  });
  if (!out.document.chapters.length) {
    const fallback = plan.local.document.chapters[0];
    if (fallback) {
      out.document.chapters = [clone(fallback)];
      report.warnings.push("双方删除了全部章节，已保留本机第一章作为兜底");
    }
  }
  // —— 阅读位置与书签指向同一组有效身份 ——
  out.location = normalizeLocation(
    out.document,
    plan.locationSide === "incoming" ? plan.incoming.location : plan.local.location,
  );
  const validPages = new Set(
    out.document.chapters.flatMap((c) => c.pages.map((p) => p.id)),
  );
  const beforeReconcile = out.bookmarks.length;
  out.bookmarks = out.bookmarks.filter((b) => validPages.has(b.location.pageId));
  report.bookmarksDropped += beforeReconcile - out.bookmarks.length;
  // —— 代价统计 ——
  for (const item of items) {
    if (item.tone === "info") continue;
    const choice = eff(item);
    if (item.kind === "link") {
      if (choice === "drop") {
        if (item.link!.deletedBy === "incoming") report.discardedLocal++;
        else report.discardedIncoming++;
      }
      continue;
    }
    if (choice === "local" && item.hasIncoming) report.discardedIncoming++;
    if (choice === "incoming" && item.hasLocal) report.discardedLocal++;
  }
  if (report.discardedIncoming)
    report.warnings.push(`将放弃对方的 ${report.discardedIncoming} 处修改`);
  if (report.discardedLocal)
    report.warnings.push(`将放弃你的 ${report.discardedLocal} 处修改`);
  return { session: out, report };
}
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
export function summarizeReport(r: MergeReport): string {
  const parts: string[] = [];
  if (r.chaptersAdded) parts.push(`新增 ${r.chaptersAdded} 章`);
  if (r.chaptersRemoved) parts.push(`删除 ${r.chaptersRemoved} 章`);
  if (r.pagesAdded) parts.push(`新增 ${r.pagesAdded} 页`);
  if (r.pagesRemoved) parts.push(`删除 ${r.pagesRemoved} 页`);
  if (r.panelsAdded) parts.push(`新增 ${r.panelsAdded} 个分镜`);
  if (r.panelsRemoved) parts.push(`删除 ${r.panelsRemoved} 个分镜`);
  if (r.fieldsChanged) parts.push(`应用 ${r.fieldsChanged} 处修改`);
  if (r.ordersChanged) parts.push(`调整 ${r.ordersChanged} 处顺序`);
  if (r.bookmarksAdded) parts.push(`新增 ${r.bookmarksAdded} 个书签`);
  if (r.bookmarksRemoved) parts.push(`合并 ${r.bookmarksRemoved} 个重复书签`);
  if (r.bookmarksDropped) parts.push(`丢弃 ${r.bookmarksDropped} 个失效书签`);
  return parts.length ? parts.join("，") : "没有需要应用的变化";
}
