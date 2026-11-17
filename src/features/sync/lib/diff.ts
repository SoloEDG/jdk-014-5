import type {
  Bookmark,
  Chapter,
  ComicPage,
  Panel,
} from "../../../shared/document";
import { canonical } from "./hash";
import { toStructural, type SessionSnapshot } from "./snapshot";
import type { BaseRecord } from "./baseStore";
import type { WorkFilePayload } from "./workfile";
export type Side = "local" | "incoming";
export interface MergeOption {
  value: string;
  label: string;
}
export interface FieldConflictView {
  key: string;
  label: string;
  base: string;
  local: string;
  incoming: string;
}
export type MergeAction =
  | "fields" // 字段级合并（含冲突选择）
  | "add" // 对方新增，可添加或跳过
  | "remove" // 一方删除了实体
  | "restore" // 你删除了实体，可从对方恢复
  | "replace" // 双方同标识不同内容，二选一
  | "order" // 顺序调整
  | "link" // 删除 vs 书签
  | "info"; // 纯信息（本机修改，自动保留）
export interface MergeItem {
  key: string;
  kind: "meta" | "chapter" | "page" | "panel" | "order" | "bookmark" | "link";
  action: MergeAction;
  group: string; // "$meta" | "$bookmarks" | "$yours" | 章节 id
  chapterId?: string;
  pageId?: string;
  panelId?: string;
  bookmarkId?: string;
  label: string;
  path: string[];
  detail: string;
  tone: "conflict" | "auto" | "info";
  hasIncoming: boolean; // 对方在此处有工作成果
  hasLocal: boolean; // 你在此处有工作成果
  options: MergeOption[]; // 空 = 纯信息行
  default?: string;
  // 字段级三向合并结果：非冲突字段各自取自哪一边
  fieldMerge?: Record<string, Side | "base">;
  conflictFields?: FieldConflictView[];
  order?: { containerId: string; local: string[]; incoming: string[] };
  link?: {
    entityKind: "chapter" | "page";
    deletedBy: Side;
    bookmarkIds: string[];
    bookmarksFrom: Side;
  };
  dup?: { matchId: string; matchLabel: string; identical: boolean };
}
export interface MergePlan {
  items: MergeItem[];
  local: SessionSnapshot;
  incoming: SessionSnapshot;
  base: SessionSnapshot | null; // document 为结构化快照
  baseSource: "local" | "incoming" | "none";
  baseChain: string[];
  usedBaseHash: string | null;
  locationSide: Side;
  warnings: string[];
}
const eq = (a: unknown, b: unknown) => canonical(a) === canonical(b);
interface Trio<T> {
  id: string;
  b?: T;
  l?: T;
  i?: T;
}
// 三份版本按 id 对齐；返回顺序以本机为准，对方新增的跟在相邻位置后。
function trios<T extends { id: string }>(b: T[], l: T[], i: T[]): Trio<T>[] {
  const map = new Map<string, Trio<T>>();
  const get = (id: string) => {
    const t = map.get(id) ?? { id };
    map.set(id, t);
    return t;
  };
  for (const x of b) get(x.id).b = x;
  for (const x of l) get(x.id).l = x;
  for (const x of i) get(x.id).i = x;
  const li = new Map(l.map((x, n) => [x.id, n]));
  const ii = new Map(i.map((x, n) => [x.id, n]));
  return [...map.values()].sort(
    (a, z) =>
      (li.get(a.id) ?? (ii.get(a.id) ?? 0) + 0.5) -
      (li.get(z.id) ?? (ii.get(z.id) ?? 0) + 0.5),
  );
}
const SOUND_LABEL: Record<string, string> = {
  rain: "雨声",
  pulse: "电波",
  wind: "风声",
};
function displayValue(key: string, value: unknown): string {
  if (key === "image") return "已更换图片";
  if (key === "rect") return "已调整区域";
  if (key === "sound") return SOUND_LABEL[String(value)] ?? String(value);
  if (key === "duration") return `${String(value)} 秒`;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 26 ? `${s.slice(0, 26)}…` : s;
}
interface FieldDef {
  key: string;
  label: string;
}
interface FieldResult {
  merged: Record<string, Side | "base">;
  conflicts: FieldConflictView[];
  notes: string[];
  incomingChanged: number;
  localChanged: number;
}
// 字段级三向合并：同一字段只有一边改 → 取该边；两边改不同字段 → 都保留；
// 同一字段两边都改且不同 → 冲突。
function diffFields<B extends Record<string, any>>(
  b: B | undefined,
  l: B | undefined,
  i: B | undefined,
  defs: FieldDef[],
): FieldResult {
  const r: FieldResult = {
    merged: {},
    conflicts: [],
    notes: [],
    incomingChanged: 0,
    localChanged: 0,
  };
  for (const def of defs) {
    const bv = b?.[def.key],
      lv = l?.[def.key],
      iv = i?.[def.key];
    const lSame = eq(lv, bv),
      iSame = eq(iv, bv);
    if (lSame && iSame) {
      r.merged[def.key] = "base";
      continue;
    }
    if (lSame) {
      r.merged[def.key] = "incoming";
      r.incomingChanged++;
      r.notes.push(`对方修改了${def.label}`);
      continue;
    }
    if (iSame) {
      r.merged[def.key] = "local";
      r.localChanged++;
      r.notes.push(`你修改了${def.label}`);
      continue;
    }
    if (eq(lv, iv)) {
      r.merged[def.key] = "local";
      r.notes.push(`双方同样修改了${def.label}`);
      continue;
    }
    r.conflicts.push({
      key: def.key,
      label: def.label,
      base: displayValue(def.key, bv),
      local: displayValue(def.key, lv),
      incoming: displayValue(def.key, iv),
    });
  }
  return r;
}
const MY: MergeOption = { value: "local", label: "用我的" };
const THEIR: MergeOption = { value: "incoming", label: "用对方的" };
const AUTO: MergeOption = { value: "auto", label: "自动" };
function fieldsItem(
  kind: MergeItem["kind"],
  ids: { chapterId?: string; pageId?: string; panelId?: string },
  label: string,
  path: string[],
  group: string,
  fr: FieldResult,
): MergeItem | null {
  const { conflicts, notes, incomingChanged, localChanged } = fr;
  if (!conflicts.length && !incomingChanged && !localChanged) return null;
  const hasIncoming = incomingChanged + conflicts.length > 0,
    hasLocal = localChanged + conflicts.length > 0;
  const base = {
    kind,
    ...ids,
    label,
    path,
    fieldMerge: fr.merged,
    hasIncoming,
    hasLocal,
  };
  if (conflicts.length)
    return {
      ...base,
      key: `${kind}:${ids.panelId ?? ids.pageId ?? ids.chapterId ?? "doc"}`,
      group,
      action: "fields",
      tone: "conflict",
      detail:
        conflicts
          .map((c) => `${c.label}：我「${c.local}」/ 对方「${c.incoming}」`)
          .join("；") + (notes.length ? `；其余 ${notes.join("，")}` : ""),
      options: [MY, THEIR],
      conflictFields: conflicts,
    };
  if (!hasIncoming)
    return {
      ...base,
      key: `${kind}:${ids.panelId ?? ids.pageId ?? ids.chapterId ?? "doc"}`,
      group: "$yours",
      action: "info",
      tone: "info",
      detail: notes.join("，"),
      options: [],
    };
  return {
    ...base,
    key: `${kind}:${ids.panelId ?? ids.pageId ?? ids.chapterId ?? "doc"}`,
    group,
    action: "fields",
    tone: "auto",
    detail:
      notes.join("，") + (hasLocal ? " → 已自动合并，双方修改都保留" : ""),
    options: [AUTO, MY, THEIR],
    default: "auto",
  };
}
// 只比较共有条目的相对顺序：新增/删除不算重排。
function sameOrder(a: string[], b: string[]): boolean {
  const setB = new Set(b),
    setA = new Set(a);
  const fa = a.filter((x) => setB.has(x));
  const fb = b.filter((x) => setA.has(x));
  return fa.length === fb.length && fa.every((x, n) => x === fb[n]);
}
function orderItem(
  label: string,
  path: string[],
  group: string,
  containerId: string,
  bIds: string[],
  lIds: string[],
  iIds: string[],
): MergeItem | null {
  const lSame = sameOrder(bIds, lIds),
    iSame = sameOrder(bIds, iIds);
  if (lSame && iSame) return null;
  const order = { containerId, local: lIds, incoming: iIds };
  const base = {
    kind: "order" as const,
    label,
    path,
    order,
    hasIncoming: !iSame,
    hasLocal: !lSame,
  };
  if (lSame)
    return {
      ...base,
      key: `order:${containerId}`,
      group,
      action: "order",
      tone: "auto",
      detail: "对方重新调整了顺序",
      options: [AUTO, MY, THEIR],
      default: "auto",
    };
  if (iSame)
    return {
      ...base,
      key: `order:${containerId}`,
      group: "$yours",
      action: "info",
      tone: "info",
      detail: "你重新调整了顺序",
      options: [],
    };
  if (sameOrder(lIds, iIds))
    return {
      ...base,
      key: `order:${containerId}`,
      group,
      action: "info",
      tone: "info",
      detail: "双方做了相同的重排",
      options: [],
    };
  return {
    ...base,
    key: `order:${containerId}`,
    group,
    action: "order",
    tone: "conflict",
    detail: "双方以不同方式重排，请选择一种顺序",
    options: [MY, THEIR],
  };
}
const CHAPTER_FIELDS: FieldDef[] = [
  { key: "title", label: "标题" },
  { key: "subtitle", label: "副标题" },
];
const PAGE_FIELDS: FieldDef[] = [
  { key: "title", label: "标题" },
  { key: "image", label: "图片" },
];
const PANEL_FIELDS: FieldDef[] = [
  { key: "dialogue", label: "对白" },
  { key: "speaker", label: "角色" },
  { key: "sound", label: "音效" },
  { key: "duration", label: "时长" },
  { key: "rect", label: "画面区域" },
];
const META_FIELDS: FieldDef[] = [
  { key: "title", label: "作品名" },
  { key: "author", label: "作者" },
];
function subtreeSummary(b: Chapter, other: Chapter): string {
  const parts: string[] = [];
  if (!eq(b.title, other.title) || !eq(b.subtitle, other.subtitle))
    parts.push("章节信息已修改");
  let added = 0,
    removed = 0,
    changed = 0;
  for (const t of trios(b.pages, other.pages, [])) {
    if (t.b && t.l && !eq(t.b, t.l)) changed++;
    else if (!t.b && t.l) added++;
    else if (t.b && !t.l) removed++;
  }
  if (added) parts.push(`新增 ${added} 页`);
  if (removed) parts.push(`删除 ${removed} 页`);
  if (changed) parts.push(`修改 ${changed} 页`);
  return parts.join("，") || "内容有变化";
}
function pageSummary(b: ComicPage, other: ComicPage): string {
  const parts: string[] = [];
  if (!eq(b.title, other.title)) parts.push("标题已修改");
  if (!eq(b.image, other.image)) parts.push("图片已更换");
  let changed = 0;
  for (const t of trios(b.panels, other.panels, []))
    if ((t.b && t.l && !eq(t.b, t.l)) || !t.b || !t.l) changed++;
  if (changed) parts.push(`${changed} 个分镜有变化`);
  return parts.join("，") || "内容有变化";
}
// 内容等价（忽略 id）：同一图片 + 标题 + 分镜内容一致。
// 复制页面会得到新 id，不会被误判为同一对象；双方各自导入同一图片才会命中。
function pageContentEq(a: ComicPage, b: ComicPage): boolean {
  if (a.image !== b.image || a.title !== b.title) return false;
  if (a.panels.length !== b.panels.length) return false;
  return a.panels.every((p, n) => {
    const q = b.panels[n]!;
    return (
      p.dialogue === q.dialogue &&
      p.speaker === q.speaker &&
      p.sound === q.sound &&
      p.duration === q.duration &&
      eq(p.rect, q.rect)
    );
  });
}
function chapterContentEq(a: Chapter, b: Chapter): boolean {
  return (
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.pages.length === b.pages.length &&
    a.pages.every((p, n) => pageContentEq(p, b.pages[n]!))
  );
}
function panelSummary(b: Panel, other: Panel): string {
  const parts: string[] = [];
  for (const def of PANEL_FIELDS)
    if (!eq(b[def.key as keyof Panel], other[def.key as keyof Panel]))
      parts.push(`${def.label}有变化`);
  return parts.join("，") || "内容有变化";
}
export function buildPlan(
  local: SessionSnapshot,
  incoming: WorkFilePayload,
  storedBase: BaseRecord | null,
): MergePlan {
  const warnings: string[] = [];
  // 选择共同起点：哈希一致 → 本机起点；对方链上包含本机起点 → 本机起点更老，用之；
  // 否则采用文件内嵌的起点（它更老、或本机没有起点、或两条线已分叉）。
  let base: SessionSnapshot | null = null,
    baseSource: MergePlan["baseSource"] = "none",
    baseChain: string[] = [],
    usedBaseHash: string | null = null;
  if (
    storedBase &&
    (storedBase.baseHash === incoming.baseHash ||
      incoming.baseChain.includes(storedBase.baseHash))
  ) {
    base = {
      document: storedBase.base,
      bookmarks: storedBase.bookmarks,
      location: storedBase.location,
    };
    baseChain = storedBase.chain;
    usedBaseHash = storedBase.baseHash;
    baseSource = "local";
  } else if (incoming.base) {
    base = {
      document: incoming.base,
      bookmarks: incoming.baseBookmarks,
      location: incoming.baseLocation ?? incoming.location,
    };
    baseChain = incoming.baseChain;
    usedBaseHash = incoming.baseHash;
    baseSource = "incoming";
    if (storedBase)
      warnings.push("双方保存的起点不一致，已按文件内的起点对比，请仔细检查");
  } else if (storedBase) {
    base = {
      document: storedBase.base,
      bookmarks: storedBase.bookmarks,
      location: storedBase.location,
    };
    baseChain = storedBase.chain;
    usedBaseHash = storedBase.baseHash;
    baseSource = "local";
    warnings.push("文件缺少共同起点信息，已按本机保存的起点对比");
  } else {
    warnings.push("找不到共同起点，已按双方现状直接对比（删除不会生效）");
  }
  const B = base?.document ?? {
    version: 1 as const,
    id: "",
    title: "",
    author: "",
    chapters: [],
  };
  const L = toStructural(local.document),
    I = toStructural(incoming.document);
  const baseBookmarks = base?.bookmarks ?? [];
  const items: MergeItem[] = [];
  const linkedBookmarks = new Set<string>(); // 已被“删除 vs 书签”冲突吸收的书签
  const push = (item: MergeItem | null) => {
    if (item) items.push(item);
  };
  const metaItem = fieldsItem(
    "meta",
    {},
    "作品信息",
    ["作品信息"],
    "$meta",
    diffFields(B, L, I, META_FIELDS),
  );
  push(metaItem);
  const chapterTrios = trios(B.chapters, L.chapters, I.chapters);
  const makeLink = (
    entityKind: "chapter" | "page",
    ids: { chapterId: string; pageId?: string },
    deletedBy: Side,
    owner: Bookmark[],
    label: string,
    path: string[],
    group: string,
    extraDetail: string,
  ) => {
    const from: Side = deletedBy === "local" ? "incoming" : "local";
    for (const m of owner) linkedBookmarks.add(m.id);
    const names = owner
      .slice(0, 3)
      .map((m) => `「${m.label}」`)
      .join("、");
    return {
      key: `link:${ids.chapterId}:${ids.pageId ?? ""}`,
      kind: "link" as const,
      group,
      ...ids,
      label,
      path,
      action: "link" as const,
      tone: "conflict" as const,
      hasIncoming: true,
      hasLocal: true,
      detail: `${deletedBy === "local" ? "你" : "对方"}删除了${label}，但${
        from === "local" ? "你" : "对方"
      }的 ${owner.length} 个书签指向这里：${names}${
        owner.length > 3 ? " 等" : ""
      }${extraDetail ? `；${extraDetail}` : ""}`,
      options: [
        { value: "keep", label: `保留${entityKind === "chapter" ? "章节" : "页面"}和书签` },
        { value: "drop", label: `仍然删除（丢弃 ${owner.length} 个书签）` },
      ],
      link: {
        entityKind,
        deletedBy,
        bookmarkIds: owner.map((m) => m.id),
        bookmarksFrom: from,
      },
    };
  };
  const diffPanels = (
    b: ComicPage,
    l: ComicPage,
    i: ComicPage,
    path: string[],
    group: string,
    chapterId: string,
    pageId: string,
  ) => {
    for (const t of trios(b.panels, l.panels, i.panels)) {
      const panel = t.l ?? t.i ?? t.b,
        n =
          (l.panels.indexOf(t.l as Panel) + 1 || i.panels.indexOf(t.i as Panel) + 1) ||
          0;
      const label = `分镜 ${n || "?"}`,
        ppath = [...path, label];
      if (t.b && t.l && t.i) {
        push(
          fieldsItem(
            "panel",
            { chapterId, pageId, panelId: t.id },
            label,
            ppath,
            group,
            diffFields(t.b, t.l, t.i, PANEL_FIELDS),
          ),
        );
      } else if (t.b && t.l && !t.i) {
        if (eq(t.l, t.b))
          push({
            key: `panel:${t.id}`,
            kind: "panel",
            group,
            chapterId,
            pageId,
            panelId: t.id,
            label,
            path: ppath,
            tone: "auto",
            hasIncoming: true,
            hasLocal: false,
            action: "remove",
            detail: "对方删除了这个分镜",
            options: [
              { value: "incoming", label: "删除" },
              { value: "local", label: "保留" },
            ],
            default: "incoming",
          });
        else
          push({
            key: `panel:${t.id}`,
            kind: "panel",
            group,
            chapterId,
            pageId,
            panelId: t.id,
            label,
            path: ppath,
            tone: "conflict",
            hasIncoming: true,
            hasLocal: true,
            action: "remove",
            detail: `对方删除了这个分镜，但你修改了它（${panelSummary(t.b, t.l)}）`,
            options: [
              { value: "incoming", label: "删除" },
              { value: "local", label: "保留我的" },
            ],
          });
      } else if (t.b && !t.l && t.i) {
        if (eq(t.i, t.b))
          push({
            key: `panel:${t.id}`,
            kind: "panel",
            group: "$yours",
            chapterId,
            pageId,
            panelId: t.id,
            label,
            path: ppath,
            tone: "info",
            hasIncoming: false,
            hasLocal: true,
            action: "restore",
            detail: "你删除了这个分镜",
            options: [
              { value: "local", label: "保持删除" },
              { value: "incoming", label: "从对方恢复" },
            ],
            default: "local",
          });
        else
          push({
            key: `panel:${t.id}`,
            kind: "panel",
            group,
            chapterId,
            pageId,
            panelId: t.id,
            label,
            path: ppath,
            tone: "conflict",
            hasIncoming: true,
            hasLocal: true,
            action: "restore",
            detail: `你删除了这个分镜，但对方修改了它（${panelSummary(t.b, t.i)}）`,
            options: [
              { value: "local", label: "删除" },
              { value: "incoming", label: "保留对方的" },
            ],
          });
      } else if (!t.b && !t.l && t.i) {
        push({
          key: `panel:${t.id}`,
          kind: "panel",
          group,
          chapterId,
          pageId,
          panelId: t.id,
          label,
          path: ppath,
          tone: "auto",
          hasIncoming: true,
          hasLocal: false,
          action: "add",
          detail: `对方新增了分镜：${displayValue("dialogue", t.i.dialogue)}`,
          options: [
            { value: "incoming", label: "添加" },
            { value: "local", label: "不添加" },
          ],
          default: "incoming",
        });
      } else if (!t.b && t.l && !t.i) {
        push({
          key: `panel:${t.id}`,
          kind: "panel",
          group: "$yours",
          chapterId,
          pageId,
          panelId: t.id,
          label,
          path: ppath,
          tone: "info",
          hasIncoming: false,
          hasLocal: true,
          action: "info",
          detail: "你新增了这个分镜",
          options: [],
        });
      } else if (!t.b && t.l && t.i && !eq(t.l, t.i)) {
        push({
          key: `panel:${t.id}`,
          kind: "panel",
          group,
          chapterId,
          pageId,
          panelId: t.id,
          label,
          path: ppath,
          tone: "conflict",
          hasIncoming: true,
          hasLocal: true,
          action: "replace",
          detail: "双方新增了同一标识的不同分镜",
          options: [MY, THEIR],
        });
      }
    }
  };
  const localPageIndex = new Map<string, ComicPage>();
  for (const c of L.chapters) for (const p of c.pages) localPageIndex.set(p.id, p);
  const diffPages = (
    b: Chapter,
    l: Chapter,
    i: Chapter,
    path: string[],
    group: string,
  ) => {
    for (const t of trios(b.pages, l.pages, i.pages)) {
      const page = t.l ?? t.i ?? t.b,
        label = page?.title ?? t.id,
        ppath = [...path, label];
      if (t.b && t.l && t.i) {
        push(
          fieldsItem(
            "page",
            { chapterId: l.id, pageId: t.id },
            label,
            ppath,
            group,
            diffFields(t.b, t.l, t.i, PAGE_FIELDS),
          ),
        );
        push(
          orderItem(
            "分镜顺序",
            ppath,
            group,
            t.id,
            t.b.panels.map((p) => p.id),
            t.l.panels.map((p) => p.id),
            t.i.panels.map((p) => p.id),
          ),
        );
        diffPanels(t.b, t.l, t.i, ppath, group, l.id, t.id);
      } else if (t.b && t.l && !t.i) {
        const marks = local.bookmarks.filter(
          (m) => m.location.pageId === t.id && !linkedBookmarks.has(m.id),
        );
        if (marks.length)
          push(
            makeLink("page", { chapterId: l.id, pageId: t.id }, "incoming", marks, label, ppath, group,
              eq(t.l, t.b) ? "" : `你在本页还有修改（${pageSummary(t.b, t.l)}）`),
          );
        else if (eq(t.l, t.b))
          push({
            key: `page:${t.id}`,
            kind: "page",
            group,
            chapterId: l.id,
            pageId: t.id,
            label,
            path: ppath,
            tone: "auto",
            hasIncoming: true,
            hasLocal: false,
            action: "remove",
            detail: "对方删除了这一页",
            options: [
              { value: "incoming", label: "删除" },
              { value: "local", label: "保留" },
            ],
            default: "incoming",
          });
        else
          push({
            key: `page:${t.id}`,
            kind: "page",
            group,
            chapterId: l.id,
            pageId: t.id,
            label,
            path: ppath,
            tone: "conflict",
            hasIncoming: true,
            hasLocal: true,
            action: "remove",
            detail: `对方删除了这一页，但你有未同步的修改（${pageSummary(t.b, t.l)}）`,
            options: [
              { value: "incoming", label: "删除" },
              { value: "local", label: "保留我的" },
            ],
          });
      } else if (t.b && !t.l && t.i) {
        const marks = incoming.bookmarks.filter(
          (m) => m.location.pageId === t.id && !linkedBookmarks.has(m.id),
        );
        if (marks.length)
          push(
            makeLink("page", { chapterId: i.id, pageId: t.id }, "local", marks, label, ppath, group,
              eq(t.i, t.b) ? "" : `对方在本页还有修改（${pageSummary(t.b, t.i)}）`),
          );
        else if (eq(t.i, t.b))
          push({
            key: `page:${t.id}`,
            kind: "page",
            group: "$yours",
            chapterId: i.id,
            pageId: t.id,
            label,
            path: ppath,
            tone: "info",
            hasIncoming: false,
            hasLocal: true,
            action: "restore",
            detail: "你删除了这一页",
            options: [
              { value: "local", label: "保持删除" },
              { value: "incoming", label: "从对方恢复" },
            ],
            default: "local",
          });
        else
          push({
            key: `page:${t.id}`,
            kind: "page",
            group,
            chapterId: i.id,
            pageId: t.id,
            label,
            path: ppath,
            tone: "conflict",
            hasIncoming: true,
            hasLocal: true,
            action: "restore",
            detail: `你删除了这一页，但对方有未同步的修改（${pageSummary(t.b, t.i)}）`,
            options: [
              { value: "local", label: "删除" },
              { value: "incoming", label: "保留对方的" },
            ],
          });
      } else if (!t.b && !t.l && t.i) {
        // 对方新增的页面：检查是否与本机已有页面重复（同一图片）。
        // 仅当全机只有唯一同图页面时才提示，复制出的多页不会误判为同一对象。
        const matches = [...localPageIndex.values()].filter(
          (p) => p.image === (t.i as ComicPage).image,
        );
        const dup =
          matches.length === 1
            ? {
                matchId: matches[0]!.id,
                matchLabel: matches[0]!.title,
                identical: pageContentEq(matches[0]!, t.i),
              }
            : undefined;
        push({
          key: `page:${t.id}`,
          kind: "page",
          group,
          chapterId: i.id,
          pageId: t.id,
          label,
          path: ppath,
          tone: "auto",
          hasIncoming: true,
          hasLocal: false,
          detail: dup
            ? `对方新增了此页，图片与本机「${dup.matchLabel}」相同${
                dup.identical ? "，内容完全一致" : "，但分镜不同"
              }`
            : "对方新增了这一页",
          options: dup
            ? [
                { value: "skip", label: "视为重复，不添加" },
                { value: "incoming", label: "仍然添加" },
              ]
            : [
                { value: "incoming", label: "添加" },
                { value: "local", label: "不添加" },
              ],
          action: "add",
          default: dup ? (dup.identical ? "skip" : "incoming") : "incoming",
          dup,
        });
      } else if (!t.b && t.l && !t.i) {
        push({
          key: `page:${t.id}`,
          kind: "page",
          group: "$yours",
          chapterId: l.id,
          pageId: t.id,
          label,
          path: ppath,
          tone: "info",
          hasIncoming: false,
          hasLocal: true,
          action: "info",
          detail: "你新增了这一页",
          options: [],
        });
      } else if (!t.b && t.l && t.i && !eq(t.l, t.i)) {
        push({
          key: `page:${t.id}`,
          kind: "page",
          group,
          chapterId: l.id,
          pageId: t.id,
          label,
          path: ppath,
          tone: "conflict",
          hasIncoming: true,
          hasLocal: true,
          action: "replace",
          detail: "双方新增了同一标识的不同页面",
          options: [MY, THEIR],
        });
      }
    }
  };
  for (const t of chapterTrios) {
    const title = t.l?.title ?? t.i?.title ?? t.b?.title ?? t.id,
      path = [title],
      group = t.id;
    if (t.b && t.l && t.i) {
      push(
        fieldsItem(
          "chapter",
          { chapterId: t.id },
          title,
          path,
          group,
          diffFields(t.b, t.l, t.i, CHAPTER_FIELDS),
        ),
      );
      push(
        orderItem(
          "页面顺序",
          path,
          group,
          t.id,
          t.b.pages.map((p) => p.id),
          t.l.pages.map((p) => p.id),
          t.i.pages.map((p) => p.id),
        ),
      );
      diffPages(t.b, t.l, t.i, path, group);
    } else if (t.b && t.l && !t.i) {
      const pageIds = new Set(t.l.pages.map((p) => p.id));
      const marks = local.bookmarks.filter(
        (m) => pageIds.has(m.location.pageId) && !linkedBookmarks.has(m.id),
      );
      if (marks.length)
        push(
          makeLink("chapter", { chapterId: t.id }, "incoming", marks, title, path, group,
            eq(t.l, t.b) ? "" : `你在本章还有修改（${subtreeSummary(t.b, t.l)}）`),
        );
      else if (eq(t.l, t.b))
        push({
          key: `chapter:${t.id}`,
          kind: "chapter",
          group,
          chapterId: t.id,
          label: title,
          path,
          tone: "auto",
          hasIncoming: true,
          hasLocal: false,
          action: "remove",
          detail: `对方删除了整章（${t.b.pages.length} 页）`,
          options: [
            { value: "incoming", label: "删除" },
            { value: "local", label: "保留" },
          ],
          default: "incoming",
        });
      else
        push({
          key: `chapter:${t.id}`,
          kind: "chapter",
          group,
          chapterId: t.id,
          label: title,
          path,
          tone: "conflict",
          hasIncoming: true,
          hasLocal: true,
          action: "remove",
          detail: `对方删除了整章，但你有未同步的修改（${subtreeSummary(t.b, t.l)}）`,
          options: [
            { value: "incoming", label: "删除" },
            { value: "local", label: "保留我的" },
          ],
        });
    } else if (t.b && !t.l && t.i) {
      const pageIds = new Set(t.i.pages.map((p) => p.id));
      const marks = incoming.bookmarks.filter(
        (m) => pageIds.has(m.location.pageId) && !linkedBookmarks.has(m.id),
      );
      if (marks.length)
        push(
          makeLink("chapter", { chapterId: t.id }, "local", marks, title, path, group,
            eq(t.i, t.b) ? "" : `对方在本章还有修改（${subtreeSummary(t.b, t.i)}）`),
        );
      else if (eq(t.i, t.b))
        push({
          key: `chapter:${t.id}`,
          kind: "chapter",
          group: "$yours",
          chapterId: t.id,
          label: title,
          path,
          tone: "info",
          hasIncoming: false,
          hasLocal: true,
          action: "restore",
          detail: `你删除了整章（${t.b.pages.length} 页）`,
          options: [
            { value: "local", label: "保持删除" },
            { value: "incoming", label: "从对方恢复" },
          ],
          default: "local",
        });
      else
        push({
          key: `chapter:${t.id}`,
          kind: "chapter",
          group,
          chapterId: t.id,
          label: title,
          path,
          tone: "conflict",
          hasIncoming: true,
          hasLocal: true,
          action: "restore",
          detail: `你删除了整章，但对方有未同步的修改（${subtreeSummary(t.b, t.i)}）`,
          options: [
            { value: "local", label: "删除" },
            { value: "incoming", label: "保留对方的" },
          ],
        });
    } else if (!t.b && !t.l && t.i) {
      // 对方新增的整章：若每页图片都与本机某章一一相同，提示疑似重复。
      const dupChapter = L.chapters.find(
        (c) =>
          c.pages.length === t.i!.pages.length &&
          c.pages.every((p, n) => p.image === t.i!.pages[n]!.image),
      );
      const dup = dupChapter
        ? {
            matchId: dupChapter.id,
            matchLabel: dupChapter.title,
            identical: chapterContentEq(dupChapter, t.i),
          }
        : undefined;
      push({
        key: `chapter:${t.id}`,
        kind: "chapter",
        group,
        chapterId: t.id,
        label: title,
        path,
        tone: "auto",
        hasIncoming: true,
        hasLocal: false,
        detail: dup
          ? `对方新增了整章（${t.i.pages.length} 页），每页图片都与「${dup.matchLabel}」相同`
          : `对方新增了整章（${t.i.pages.length} 页）`,
        options: dup
          ? [
              { value: "skip", label: "视为重复，不添加" },
              { value: "incoming", label: "仍然添加" },
            ]
          : [
              { value: "incoming", label: "添加" },
              { value: "local", label: "不添加" },
            ],
        action: "add",
        default: dup ? (dup.identical ? "skip" : "incoming") : "incoming",
        dup,
      });
    } else if (!t.b && t.l && !t.i) {
      push({
        key: `chapter:${t.id}`,
        kind: "chapter",
        group: "$yours",
        chapterId: t.id,
        label: title,
        path,
        tone: "info",
        hasIncoming: false,
        hasLocal: true,
        action: "info",
        detail: `你新增了整章（${t.l.pages.length} 页）`,
        options: [],
      });
    } else if (!t.b && t.l && t.i && !eq(t.l, t.i)) {
      push({
        key: `chapter:${t.id}`,
        kind: "chapter",
        group,
        chapterId: t.id,
        label: title,
        path,
        tone: "conflict",
        hasIncoming: true,
        hasLocal: true,
        action: "replace",
        detail: "双方新增了同一标识的不同章节",
        options: [MY, THEIR],
      });
    }
  }
  // 章节顺序
  push(
    orderItem(
      "章节顺序",
      ["作品信息"],
      "$meta",
      "$root",
      B.chapters.map((c) => c.id),
      L.chapters.map((c) => c.id),
      I.chapters.map((c) => c.id),
    ),
  );
  // 书签
  for (const t of trios(baseBookmarks, local.bookmarks, incoming.bookmarks)) {
    const mark = t.l ?? t.i ?? t.b,
      label = mark?.label ?? "书签";
    if (linkedBookmarks.has(t.id)) continue;
    if (!t.b && t.l && !t.i) {
      push({
        key: `bookmark:${t.id}`,
        kind: "bookmark",
        group: "$yours",
        bookmarkId: t.id,
        label,
        path: ["书签"],
        tone: "info",
        hasIncoming: false,
        hasLocal: true,
        action: "info",
        detail: "你添加了这个书签",
        options: [],
      });
    } else if (!t.b && !t.l && t.i) {
      const same = local.bookmarks.find(
        (m) =>
          m.location.pageId === t.i!.location.pageId &&
          m.location.panelId === t.i!.location.panelId,
      );
      if (same)
        push({
          key: `bookmark:${t.id}`,
          kind: "bookmark",
          group: "$bookmarks",
          bookmarkId: t.id,
          label,
          path: ["书签"],
          tone: "auto",
          hasIncoming: true,
          hasLocal: false,
          action: "info",
          detail: "对方也收藏了同一分镜，已合并为一个",
          options: [],
          default: "skip",
        });
      else
        push({
          key: `bookmark:${t.id}`,
          kind: "bookmark",
          group: "$bookmarks",
          bookmarkId: t.id,
          label,
          path: ["书签"],
          tone: "auto",
          hasIncoming: true,
          hasLocal: false,
          action: "add",
          detail: "对方添加了这个书签",
          options: [
            { value: "incoming", label: "添加" },
            { value: "local", label: "不添加" },
          ],
          default: "incoming",
        });
    } else if (t.b && t.l && !t.i) {
      push({
        key: `bookmark:${t.id}`,
        kind: "bookmark",
        group: "$bookmarks",
        bookmarkId: t.id,
        label,
        path: ["书签"],
        tone: "auto",
        hasIncoming: true,
        hasLocal: false,
        action: "remove",
        detail: "对方删除了这个书签",
        options: [
          { value: "incoming", label: "删除" },
          { value: "local", label: "保留" },
        ],
        default: "incoming",
      });
    } else if (t.b && !t.l && t.i) {
      push({
        key: `bookmark:${t.id}`,
        kind: "bookmark",
        group: "$yours",
        bookmarkId: t.id,
        label,
        path: ["书签"],
        tone: "info",
        hasIncoming: false,
        hasLocal: true,
        action: "info",
        detail: "你删除了这个书签",
        options: [],
      });
    } else if (t.b && t.l && t.i && !eq(t.l, t.b) && eq(t.i, t.b)) {
      push({
        key: `bookmark:${t.id}`,
        kind: "bookmark",
        group: "$yours",
        bookmarkId: t.id,
        label,
        path: ["书签"],
        tone: "info",
        hasIncoming: false,
        hasLocal: true,
        action: "info",
        detail: "你修改了这个书签",
        options: [],
      });
    } else if (t.b && t.l && t.i && eq(t.l, t.b) && !eq(t.i, t.b)) {
      push({
        key: `bookmark:${t.id}`,
        kind: "bookmark",
        group: "$bookmarks",
        bookmarkId: t.id,
        label,
        path: ["书签"],
        tone: "auto",
        hasIncoming: true,
        hasLocal: false,
        action: "replace",
        detail: "对方修改了这个书签",
        options: [AUTO, MY, THEIR],
        default: "auto",
      });
    }
  }
  // 阅读位置：本机未动而对方动了 → 跟随对方；其余保持本机。
  const baseLocation = base?.location;
  const locationSide: Side =
    baseLocation &&
    eq(local.location, baseLocation) &&
    !eq(incoming.location, baseLocation)
      ? "incoming"
      : "local";
  if (locationSide === "incoming")
    push({
      key: "meta:location",
      kind: "meta",
      group: "$meta",
      label: "阅读进度",
      path: ["作品信息"],
      tone: "info",
      hasIncoming: true,
      hasLocal: false,
      action: "info",
      detail: "阅读进度将同步为对方的位置",
      options: [],
    });
  return {
    items,
    local,
    incoming: {
      document: incoming.document,
      bookmarks: incoming.bookmarks,
      location: incoming.location,
    },
    base,
    baseSource,
    baseChain,
    usedBaseHash,
    locationSide,
    warnings,
  };
}
