import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { demoDocument, useLibrary } from "../features/library";
import { useChapters } from "../features/chapters";
import { useReader } from "../features/reader";
import { useAudio } from "../features/audio";
import { useProgress, readSession } from "../features/progress";
import { useEditing } from "../features/editing";
import { useSync } from "../features/sync";
export function useWorkspace() {
  const saved = readSession(),
    doc = ref(saved?.document ?? demoDocument()),
    reader = useReader(doc);
  if (saved) reader.dispatch({ type: "restore", location: saved.location });
  const progress = useProgress(doc, reader.location, saved),
    sync = useSync({
      get: () => ({
        document: doc.value,
        location: reader.location.value,
        bookmarks: progress.bookmarks.value,
      }),
      set: (session) => {
        doc.value = session.document;
        progress.bookmarks.value = session.bookmarks;
        reader.dispatch({ type: "restore", location: session.location });
        progress.reconcile();
      },
    }),
    library = useLibrary(doc, (id) => {
      reader.dispatch({ type: "chapter", id });
      progress.reconcile();
    }),
    chapters = useChapters(doc, () => {
      reader.reconcile();
      progress.reconcile();
    }),
    editing = useEditing(
      doc,
      reader.location,
      () => {
        reader.reconcile();
        progress.reconcile();
      },
      (pageId) => {
        for (const c of doc.value.chapters) {
          const p = c.pages.find((p) => p.id === pageId);
          if (p) {
            reader.dispatch({
              type: "restore",
              location: {
                chapterId: c.id,
                pageId: p.id,
                panelId: p.panels[0]?.id ?? "",
                zoom: 1,
                x: 0,
                y: 0,
              },
            });
            break;
          }
        }
      },
    ),
    panel = computed(() => reader.current.value.panel),
    audio = useAudio(panel);
  function resetLibrary() {
    library.reset();
    sync.resetBase();
  }
  function keydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest("input,textarea,button,select"))
      return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      reader.dispatch({ type: "move", delta: e.key === "ArrowRight" ? 1 : -1 });
    }
    if (e.key === " ") {
      e.preventDefault();
      audio.toggle();
    }
    if (e.key === "Escape") reader.setMode("page");
  }
  onMounted(() => window.addEventListener("keydown", keydown));
  onBeforeUnmount(() => window.removeEventListener("keydown", keydown));
  return {
    doc,
    reader,
    progress,
    library,
    chapters,
    audio,
    editing,
    sync,
    resetLibrary,
  };
}
