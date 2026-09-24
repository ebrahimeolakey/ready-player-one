export const IMAGE_LIMITS = Object.freeze({
  count: 5,
  each: 8 * 1024 * 1024,
  total: 16 * 1024 * 1024,
});
export function normalizeImages(images = []) {
  if (!Array.isArray(images) || images.length > IMAGE_LIMITS.count)
    throw new Error("最多添加 5 张图片");
  let total = 0;
  return images.map((image) => {
    if (
      !image ||
      typeof image.data !== "string" ||
      image.data.length > Math.ceil(IMAGE_LIMITS.each / 3) * 4 + 4 ||
      image.data.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(image.data)
    )
      throw new Error("无效的图片数据");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.toString("base64") !== image.data)
      throw new Error("无效的图片数据");
    if (!bytes.length || bytes.length > IMAGE_LIMITS.each)
      throw new Error("单张图片不能超过 8 MB");
    total += bytes.length;
    if (total > IMAGE_LIMITS.total) throw new Error("图片总大小不能超过 16 MB");
    let mimeType;
    if (
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mimeType = "image/png";
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      mimeType = "image/jpeg";
    else if (
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    )
      mimeType = "image/webp";
    else throw new Error("仅支持 PNG、JPEG 和 WebP 图片");
    if (image.mimeType && image.mimeType !== mimeType)
      throw new Error("图片格式与内容不匹配");
    return {
      mimeType,
      data: bytes.toString("base64"),
      name: String(image.name || "图片").slice(0, 160),
    };
  });
}
export function codexInput(text, images = []) {
  return [
    { type: "text", text, text_elements: [] },
    ...normalizeImages(images).map((image) => ({
      type: "image",
      url: `data:${image.mimeType};base64,${image.data}`,
    })),
  ];
}
export function claudeInput(text, images = []) {
  const normalized = normalizeImages(images);
  return normalized.length
    ? [
        { type: "text", text },
        ...normalized.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.data,
          },
        })),
      ]
    : text;
}
