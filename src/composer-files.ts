import type { ProviderImage } from "./ProviderControls";
export async function readImageFiles(
  files: File[],
  validate: (images: unknown[]) => Promise<ProviderImage[]>,
) {
  if (!files.length) return [];
  if (files.length > 5) throw Error("最多添加 5 张图片");
  if (files.some((f) => f.size > 8 * 1024 * 1024))
    throw Error("单张图片不能超过 8 MB");
  if (files.reduce((sum, f) => sum + f.size, 0) > 16 * 1024 * 1024)
    throw Error("图片总大小不能超过 16 MB");
  const images = await Promise.all(
    files.map(
      (file) =>
        new Promise<{ name: string; data: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              name: file.name || "粘贴图片",
              data: String(reader.result).split(",")[1] || "",
            });
          reader.onerror = () => reject(Error("图片读取失败"));
          reader.readAsDataURL(file);
        }),
    ),
  );
  return validate(images);
}
export function imageFiles(transfer: DataTransfer) {
  return Array.from(transfer.files).filter(
    (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name),
  );
}
