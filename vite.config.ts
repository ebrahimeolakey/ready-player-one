import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// Bundle PDF fonts/CMaps/WASM locally; no document data or font requests leave the app.
const pdfAssets = () => ({
  name: "local-pdf-assets",
  generateBundle(this: any) {
    this.emitFile({
      type: "asset",
      fileName: "pdfjs/LICENSE",
      source: readFileSync(resolve("node_modules/pdfjs-dist/LICENSE")),
    });
    for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"])
      for (const file of readdirSync(
        resolve("node_modules/pdfjs-dist", folder),
        { withFileTypes: true },
      )) {
        if (file.isFile())
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${folder}/${file.name}`,
            source: readFileSync(
              resolve("node_modules/pdfjs-dist", folder, file.name),
            ),
          });
      }
  },
  configureServer(server: any) {
    server.middlewares.use("/pdfjs", (req: any, res: any, next: any) => {
      const path = String(req.url || "").split("?")[0];
      if (!/^\/(cmaps|standard_fonts|wasm|iccs)\/[\w.-]+$/.test(path))
        return next();
      try {
        const content = readFileSync(
          resolve("node_modules/pdfjs-dist", path.slice(1)),
        );
        res.setHeader(
          "Content-Type",
          path.endsWith(".wasm")
            ? "application/wasm"
            : "application/octet-stream",
        );
        res.end(content);
      } catch {
        next();
      }
    });
  },
});
export default defineConfig({ plugins: [react(), pdfAssets()], base: "./" });
