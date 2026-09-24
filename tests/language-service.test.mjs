import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LanguageService } from "../desktop/services/language.mjs";
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "rpo-language-")),
    root = path.join(base, "project");
  await mkdir(root);
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        moduleResolution: "Node",
        baseUrl: ".",
        paths: { "@lib/*": ["lib/*"] },
      },
      include: ["**/*.ts"],
    }),
  );
  await mkdir(path.join(root, "lib"));
  await writeFile(
    path.join(root, "lib/util.ts"),
    'export const count: number = 42;\nexport const user = { name: "Ada", age: 20 };\n',
  );
  const text =
    'import { count, user } from "@lib/util";\nconst answer: string = count;\nuser.name;\n';
  await writeFile(path.join(root, "main.ts"), text);
  const service = new LanguageService();
  t.after(async () => {
    await service.dispose();
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, text, service };
}
test("real TS service honors tsconfig aliases, diagnoses types, completes members and jumps across files", async (t) => {
  const { root, text, service } = await fixture(t);
  const diagnostics = await service.diagnostics(root, { path: "main.ts" });
  assert.ok(
    diagnostics.some((d) => d.code === 2322 && d.message.includes("number")),
  );
  assert.ok(!diagnostics.some((d) => d.code === 2307));
  const locations = await service.definition(root, {
    path: "main.ts",
    offset: text.lastIndexOf("count") + 2,
  });
  assert.equal(locations[0].path, "lib/util.ts");
  assert.equal(locations[0].line, 1);
  const entries = await service.completions(root, {
    path: "main.ts",
    offset: text.lastIndexOf("user.") + 5,
  });
  assert.ok(entries.some((e) => e.label === "name"));
  assert.ok(entries.some((e) => e.label === "age"));
});
test("unsaved multiple-file snapshots update diagnostics; closing restores disk and preserves other owners", async (t) => {
  const { root, text, service } = await fixture(t);
  await service.update(root, {
    path: "lib/util.ts",
    documentId: "left",
    text: 'export const count: string = "42"; export const user={name:"Ada",age:20};',
  });
  assert.equal(
    (await service.diagnostics(root, { path: "main.ts" })).length,
    0,
  );
  assert.match(
    await readFile(path.join(root, "lib/util.ts"), "utf8"),
    /count: number/,
  );
  await service.update(root, {
    path: "lib/util.ts",
    documentId: "right",
    text: 'export const count: number = 9; export const user={name:"Ada",age:20};',
  });
  await service.closeDocument(root, {
    path: "lib/util.ts",
    documentId: "right",
  });
  assert.equal(
    (await service.diagnostics(root, { path: "main.ts" })).length,
    0,
  );
  await service.closeDocument(root, {
    path: "lib/util.ts",
    documentId: "left",
  });
  assert.ok(
    (await service.diagnostics(root, { path: "main.ts" })).some(
      (d) => d.code === 2322,
    ),
  );
  assert.equal(
    (
      await service.diagnostics(root, {
        path: "main.ts",
        documentId: "main",
        text: text.replace("answer: string", "answer: number"),
      })
    ).length,
    0,
  );
});
test("rejects external paths and symlinks; external imports cannot expose definitions or source", async (t) => {
  const { base, root, service } = await fixture(t);
  await writeFile(
    path.join(base, "private.ts"),
    "export const SECRET_SENTINEL = 123;",
  );
  for (const file of [
    "../private.ts",
    path.join(base, "private.ts"),
    "C:\\private.ts",
    ".git/config.ts",
  ])
    await assert.rejects(service.diagnostics(root, { path: file }));
  await symlink(path.join(base, "private.ts"), path.join(root, "link.ts"));
  await assert.rejects(
    service.diagnostics(root, { path: "link.ts" }),
    /项目外/,
  );
  const text = 'import { SECRET_SENTINEL } from "../private"; SECRET_SENTINEL;';
  const diagnostics = await service.diagnostics(root, {
    path: "import.ts",
    text,
  });
  assert.ok(diagnostics.some((d) => d.code === 2307));
  const definitions = await service.definition(root, {
    path: "import.ts",
    text,
    offset: text.lastIndexOf("SECRET_SENTINEL") + 3,
  });
  assert.ok(definitions.every((location) => location.path === "import.ts")); // TS may return the unresolved local alias itself.
  await writeFile(
    path.join(base, "tsconfig.json"),
    '{"compilerOptions":{"types":["SECRET_SENTINEL"]}}',
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    '{"extends":"../tsconfig.json"}',
  );
  await assert.rejects(
    service.diagnostics(root, { path: "main.ts" }),
    (error) =>
      !error.message.includes("SECRET_SENTINEL") &&
      /Cannot read file/.test(error.message),
  );
});
test("JavaScript checkJs and disk edits are analyzed by TypeScript", async (t) => {
  const { root, service } = await fixture(t);
  await writeFile(
    path.join(root, "main.js"),
    '/** @type {number} */\nlet amount = "wrong";\n',
  );
  assert.ok(
    (await service.diagnostics(root, { path: "main.js" })).some(
      (d) => d.code === 2322,
    ),
  );
  await writeFile(
    path.join(root, "main.js"),
    "/** @type {number} */\nlet amount = 12;\n",
  );
  assert.equal(
    (await service.diagnostics(root, { path: "main.js" })).length,
    0,
  );
});
