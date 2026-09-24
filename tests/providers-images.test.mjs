import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeImages,
  codexInput,
  claudeInput,
  IMAGE_LIMITS,
} from "../core/providers/input.mjs";
const png = {
  name: "pixel.png",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYc8AAAAASUVORK5CYII=",
};
test("native provider image protocol preserves original binary and prompt", () => {
  assert.equal(normalizeImages([png])[0].data, png.data);
  assert.equal(
    codexInput("see", [png])[1].url,
    `data:image/png;base64,${png.data}`,
  );
  assert.deepEqual(claudeInput("see", [png])[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: png.data },
  });
  assert.equal(claudeInput("text only"), "text only");
});
test("image input rejects disguised files, wrong formats, noncanonical base64 and oversized images", () => {
  for (const value of [
    { data: Buffer.from("private plain text").toString("base64") },
    { ...png, mimeType: "image/jpeg" },
    { ...png, data: png.data + "!" },
  ])
    assert.throws(() => normalizeImages([value]));
  assert.throws(() => normalizeImages(Array(6).fill(png)), /最多/);
  const bytes = Buffer.alloc(IMAGE_LIMITS.each + 1);
  Buffer.from(png.data, "base64").copy(bytes);
  assert.throws(() =>
    normalizeImages([{ ...png, data: bytes.toString("base64") }]),
  );
});
