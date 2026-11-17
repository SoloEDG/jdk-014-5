export interface ImageData {
  image: string;
  width: number;
  height: number;
}
export async function readImageFile(file: File): Promise<ImageData> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))
    throw new Error(`不支持 ${file.name}，请选择 PNG、JPG、WebP 或 GIF`);
  if (file.size > 8 * 1024 * 1024) throw new Error("单张图片不能超过 8 MB");
  const image = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("图片读取失败"));
    r.readAsDataURL(file);
  });
  const dimensions = await new Promise<{ width: number; height: number }>(
    (resolve, reject) => {
      const img = new Image();
      img.onload = () =>
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error("图片无法解码"));
      img.src = image;
    },
  );
  if (dimensions.width * dimensions.height > 40000000)
    throw new Error("图片分辨率过大");
  return { image, ...dimensions };
}
