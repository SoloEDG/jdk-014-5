import { computed, reactive, ref } from "vue";
import type { ComicDocument } from "../../../shared/document";
import { makeId } from "../../../shared/commands";
import { canonical } from "../lib/hash";
import {
  cloneSession,
  hashDocument,
  toStructural,
  type SessionSnapshot,
} from "../lib/snapshot";
import {
  readBase,
  writeBase,
  clearBase,
  type BaseRecord,
} from "../lib/baseStore";
import { buildWorkFile, parseWorkFile } from "../lib/workfile";
import { buildPlan, type MergeItem, type MergePlan } from "../lib/diff";
import {
  applyMerge,
  formatBytes,
  summarizeReport,
  type MergeReport,
} from "../lib/merge";
import { downloadText, stamp } from "../lib/download";
import { tryWriteSession } from "../../progress/lib/storage";
export interface MergeGroup {
  key: string;
  title: string;
  items: MergeItem[];
  isChapter: boolean;
}
export function useSync(hooks: {
  get: () => SessionSnapshot;
  set: (session: SessionSnapshot) => void;
}) {
  const status = ref(""),
    plan = ref<MergePlan | null>(null),
    decisions = reactive<Record<string, string>>({}),
    report = ref<MergeReport | null>(null),
    saveFailed = ref(false),
    busy = ref(false),
    baseRecord = ref<BaseRecord | null>(readBase());
  let undoSnapshot: {
    session: SessionSnapshot;
    base: BaseRecord | null;
  } | null = null;
  const canUndo = ref(false);
  function persistBase() {
    if (baseRecord.value && !writeBase(baseRecord.value))
      console.warn("共同起点仅保留在内存中（存储空间不足）");
  }
  function makeBaseRecord(session: SessionSnapshot, chain: string[] = []): BaseRecord {
    return {
      baseHash: hashDocument(session.document),
      chain,
      base: toStructural(session.document),
      bookmarks: cloneSession(session).bookmarks,
      location: cloneSession(session).location,
    };
  }
  // —— 导出：把当前状态与共同起点打包成一个离线文件 ——
  function exportWork() {
    const session = hooks.get();
    if (!baseRecord.value) {
      baseRecord.value = makeBaseRecord(session);
      persistBase();
    }
    const file = buildWorkFile(session, baseRecord.value);
    downloadText(file.name, file.text);
    status.value = "已导出作品文件，可拷贝到另一台电脑继续编辑";
  }
  // —— 导入：解析 → 对照共同起点 → 生成合并计划 ——
  async function importWork(file: File) {
    if (busy.value) return;
    busy.value = true;
    status.value = "";
    report.value = null;
    try {
      if (file.size > 90_000_000) throw new Error("文件过大，无法导入");
      const payload = parseWorkFile(await file.text());
      const session = hooks.get();
      if (
        payload.docHash === hashDocument(session.document) &&
        canonical(payload.bookmarks) === canonical(session.bookmarks)
      ) {
        if (!baseRecord.value && payload.base) {
          baseRecord.value = {
            baseHash: payload.baseHash!,
            chain: payload.baseChain,
            base: payload.base,
            bookmarks: payload.baseBookmarks,
            location: payload.baseLocation ?? payload.location,
          };
          persistBase();
        }
        status.value = "文件内容与本机一致，没有需要合并的变化";
        return;
      }
      const built = buildPlan(session, payload, baseRecord.value);
      if (!built.items.length) {
        status.value = "两份作品内容一致，无需合并";
        return;
      }
      // 只有“你的修改（自动保留）”这类信息行时，无需打开合并对话框
      if (!built.items.some((i) => i.options.length)) {
        status.value = "对方文件没有新的变化，你的本机修改会自动保留";
        return;
      }
      plan.value = built;
      for (const key of Object.keys(decisions)) delete decisions[key];
      for (const item of built.items)
        if (item.default) decisions[item.key] = item.default;
    } catch (error) {
      status.value = error instanceof Error ? error.message : "导入失败";
    } finally {
      busy.value = false;
    }
  }
  // —— 预览：分组、代价、未决冲突 ——
  const groups = computed<MergeGroup[]>(() => {
    if (!plan.value) return [];
    const p = plan.value,
      map = new Map<string, MergeGroup>();
    const chapterTitle = (id: string) =>
      p.local.document.chapters.find((c) => c.id === id)?.title ??
      p.incoming.document.chapters.find((c) => c.id === id)?.title ??
      p.base?.document.chapters.find((c) => c.id === id)?.title ??
      "章节";
    const ensure = (key: string, title: string, isChapter = false) => {
      let g = map.get(key);
      if (!g) {
        g = { key, title, items: [], isChapter };
        map.set(key, g);
      }
      return g;
    };
    for (const item of p.items) {
      if (item.group === "$meta") ensure("$meta", "作品信息").items.push(item);
      else if (item.group === "$bookmarks")
        ensure("$bookmarks", "书签").items.push(item);
      else if (item.group === "$yours")
        ensure("$yours", "你的修改（自动保留）").items.push(item);
      else ensure(item.group, chapterTitle(item.group), true).items.push(item);
    }
    const order: string[] = ["$meta"];
    const seen = new Set<string>();
    for (const c of p.local.document.chapters)
      if (map.has(c.id) && !seen.has(c.id)) {
        order.push(c.id);
        seen.add(c.id);
      }
    for (const c of p.incoming.document.chapters)
      if (map.has(c.id) && !seen.has(c.id)) {
        order.push(c.id);
        seen.add(c.id);
      }
    for (const key of map.keys())
      if (!order.includes(key) && key !== "$bookmarks" && key !== "$yours")
        order.push(key);
    order.push("$bookmarks", "$yours");
    return order.filter((k) => map.has(k)).map((k) => map.get(k)!);
  });
  const preview = computed(() => {
    if (!plan.value) return null;
    return applyMerge(plan.value, decisions).report;
  });
  const costText = computed(() => {
    const r = preview.value;
    if (!r) return "";
    const parts: string[] = [];
    if (r.chaptersAdded) parts.push(`+${r.chaptersAdded} 章`);
    if (r.chaptersRemoved) parts.push(`−${r.chaptersRemoved} 章`);
    if (r.pagesAdded) parts.push(`+${r.pagesAdded} 页`);
    if (r.pagesRemoved) parts.push(`−${r.pagesRemoved} 页`);
    if (r.panelsAdded) parts.push(`+${r.panelsAdded} 分镜`);
    if (r.panelsRemoved) parts.push(`−${r.panelsRemoved} 分镜`);
    if (r.fieldsChanged) parts.push(`${r.fieldsChanged} 处修改`);
    if (r.ordersChanged) parts.push(`${r.ordersChanged} 处重排`);
    if (r.bookmarksAdded) parts.push(`+${r.bookmarksAdded} 书签`);
    if (r.bookmarksDropped) parts.push(`−${r.bookmarksDropped} 书签`);
    const bytes = r.bytesAdded - r.bytesRemoved;
    if (bytes > 0) parts.push(`约 +${formatBytes(bytes)}`);
    else if (bytes < 0) parts.push(`约 −${formatBytes(-bytes)}`);
    return parts.length ? parts.join(" · ") : "内容无净变化";
  });
  const unresolved = computed(
    () =>
      plan.value?.items.filter((i) => i.tone === "conflict" && !decisions[i.key])
        .length ?? 0,
  );
  function decide(key: string, value: string) {
    decisions[key] = value;
  }
  function decideGroup(groupKey: string, value: string) {
    const group = groups.value.find((g) => g.key === groupKey);
    if (!group) return;
    for (const item of group.items)
      if (item.options.some((o) => o.value === value))
        decisions[item.key] = value;
  }
  function decideAll(value: string) {
    if (!plan.value) return;
    for (const item of plan.value.items)
      if (item.options.some((o) => o.value === value))
        decisions[item.key] = value;
  }
  // —— 应用合并：先留撤回快照，再推进共同起点 ——
  function apply() {
    if (!plan.value || unresolved.value) return;
    const before = hooks.get();
    undoSnapshot = {
      session: cloneSession(before),
      base: baseRecord.value
        ? (JSON.parse(JSON.stringify(baseRecord.value)) as BaseRecord)
        : null,
    };
    const { session, report: rep } = applyMerge(plan.value, decisions);
    hooks.set(session);
    baseRecord.value = makeBaseRecord(session, [
      ...plan.value.baseChain,
      ...(plan.value.usedBaseHash ? [plan.value.usedBaseHash] : []),
    ].slice(-32));
    persistBase();
    saveFailed.value = !trySave(session);
    report.value = rep;
    plan.value = null;
    canUndo.value = true;
    status.value = rep.warnings.length
      ? `已合并：${summarizeReport(rep)}。注意：${rep.warnings.join("；")}`
      : `已合并：${summarizeReport(rep)}`;
  }
  function trySave(session: SessionSnapshot): boolean {
    return tryWriteSession({
      document: session.document,
      location: session.location,
      bookmarks: session.bookmarks,
    });
  }
  function undo() {
    if (!undoSnapshot) return;
    hooks.set(cloneSession(undoSnapshot.session));
    baseRecord.value = undoSnapshot.base;
    persistBase();
    undoSnapshot = null;
    canUndo.value = false;
    report.value = null;
    saveFailed.value = false;
    status.value = "已撤回本次合并，恢复到合并前的状态";
  }
  function cancel() {
    plan.value = null;
    status.value = "已取消合并，本机内容未改动";
  }
  // 存储失败时：把当前（已合并的）状态下载下来，工作成果不丢
  function downloadCurrent() {
    const session = hooks.get();
    const file = buildWorkFile(session, baseRecord.value);
    downloadText(
      file.name.replace(".panel.json", `-恢复-${stamp()}.panel.json`),
      file.text,
    );
    status.value = "已下载当前作品文件，可稍后重新导入";
  }
  function resetBase() {
    clearBase();
    baseRecord.value = null;
    undoSnapshot = null;
    canUndo.value = false;
  }
  // —— 演示：生成一个“另一台电脑”的分支文件，便于体验合并流程 ——
  function demoBranch() {
    const session = cloneSession(hooks.get());
    const doc: ComicDocument = session.document;
    const chapter = doc.chapters[0];
    if (!chapter || chapter.pages.length < 2) {
      status.value = "当前内容太少，无法生成分支";
      return;
    }
    const page = chapter.pages[1]!;
    if (page.panels[0]) page.panels[0].dialogue = "【分支】这句对白是在另一台电脑上改的。";
    chapter.pages.push(chapter.pages.shift()!);
    const last = doc.chapters[doc.chapters.length - 1]!.pages;
    const lastPage = last[last.length - 1]!;
    session.bookmarks.push({
      id: makeId("bookmark"),
      label: `${doc.chapters[doc.chapters.length - 1]!.title} · 分支书签`,
      location: {
        chapterId: doc.chapters[doc.chapters.length - 1]!.id,
        pageId: lastPage.id,
        panelId: lastPage.panels[0]!.id,
        zoom: 1,
        x: 0,
        y: 0,
      },
      created: Date.now(),
    });
    const base = makeBaseRecord(hooks.get());
    const file = buildWorkFile(session, base);
    downloadText(file.name.replace(".panel.json", "-分支.panel.json"), file.text);
    status.value =
      "已生成分支文件：先在本机做几处修改（改对白、删页、加书签），再导入该文件体验合并";
  }
  return {
    status,
    busy,
    plan,
    decisions,
    groups,
    preview,
    costText,
    unresolved,
    report,
    saveFailed,
    canUndo,
    exportWork,
    importWork,
    decide,
    decideGroup,
    decideAll,
    apply,
    undo,
    cancel,
    downloadCurrent,
    resetBase,
    demoBranch,
  };
}
