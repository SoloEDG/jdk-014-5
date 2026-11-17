import type { Chapter, ComicPage } from "../../../shared/document";
import { makeId } from "../../../shared/commands";
import { readImageFile } from "../../../shared/image";
async function readPage(file: File): Promise<ComicPage> {
  const data = await readImageFile(file);
  return {
    id: makeId("page"),
    title: file.name,
    ...data,
    panels: [
      {
        id: makeId("panel"),
        rect: { x: 0, y: 0, width: data.width, height: data.height },
        dialogue: "在这一页，留下属于你的故事。",
        speaker: "旁白",
        sound: "wind",
        duration: 5,
      },
    ],
  };
}
export async function importImages(files: File[]): Promise<Chapter> {
  if (files.length === 0 || files.length > 30)
    throw new Error("一次请选择 1 至 30 张图片");
  if (files.reduce((n, f) => n + f.size, 0) > 18 * 1024 * 1024)
    throw new Error("本次导入总大小不能超过 18 MB");
  const sorted = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  const pages: ComicPage[] = [];
  for (const file of sorted) pages.push(await readPage(file));
  return {
    id: makeId("chapter"),
    title: `导入章节 · ${sorted[0]!.name.replace(/\.[^.]+$/, "")}`,
    subtitle: `本地导入 / ${pages.length} 页`,
    pages,
  };
}
