import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";
const projects = new Map();
const libRoot = fs.realpathSync(path.dirname(ts.getDefaultLibFilePath({})));
const within = (root, file) =>
  file === root || file.startsWith(root + path.sep);
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const maxText = 2 * 1024 * 1024;

class Project {
  constructor(root) {
    this.root = fs.realpathSync(root);
    this.memory = new Map();
    this.sequence = 0;
    this.version = 0;
    this.options = {};
    this.files = [];
    this.host = {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => [
        ...new Set([...this.files, ...this.memory.keys()]),
      ],
      getScriptVersion: (file) =>
        this.snapshot(file)?.version || `${this.version}`,
      getScriptSnapshot: (file) => {
        const text = this.read(file);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      getProjectVersion: () => String(this.version),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      readFile: (file) => this.read(file),
      fileExists: (file) =>
        (this.allowed(file) &&
          (this.memory.has(path.resolve(file)) || this.stat(file)?.isFile())) ||
        false,
      directoryExists: (file) =>
        this.allowed(file) && !!this.stat(file)?.isDirectory(),
      getDirectories: (file) => this.entries(file).directories,
      realpath: (file) =>
        this.allowed(file) ? this.canonical(file) : path.resolve(file),
      readDirectory: (...args) => this.readDirectory(...args),
    };
    this.service = ts.createLanguageService(this.host);
  }
  canonical(file) {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  }
  stat(file) {
    try {
      return fs.statSync(file);
    } catch {
      return undefined;
    }
  }
  allowed(file) {
    const absolute = path.resolve(file);
    const valid = (candidate) =>
      (within(this.root, candidate) &&
        !path
          .relative(this.root, candidate)
          .split(path.sep)
          .some((p) => [".git", ".rpo"].includes(p.toLowerCase()))) ||
      within(libRoot, candidate);
    if (!valid(absolute)) return false;
    let parent = absolute;
    while (!fs.existsSync(parent) && path.dirname(parent) !== parent)
      parent = path.dirname(parent);
    return valid(this.canonical(parent));
  }
  input(file) {
    if (
      typeof file !== "string" ||
      !file ||
      file.includes("\0") ||
      path.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      file.replaceAll("\\", "/").split("/").includes("..") ||
      !sourcePattern.test(file)
    )
      throw new Error("仅支持项目内的 JS/TS 文件");
    const absolute = path.resolve(this.root, file);
    if (
      !within(this.root, absolute) ||
      !this.allowed(absolute) ||
      !within(this.root, this.canonical(absolute))
    )
      throw new Error("不能读取项目外文件");
    return absolute;
  }
  snapshot(file) {
    const snapshots = this.memory.get(path.resolve(file));
    return (
      snapshots && [...snapshots.values()].sort((a, b) => b.seq - a.seq)[0]
    );
  }
  read(file) {
    if (!this.allowed(file)) return undefined;
    const snapshot = this.snapshot(file);
    if (snapshot) return snapshot.text;
    try {
      if (fs.statSync(file).size > maxText) return undefined;
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }
  entries(directory) {
    const files = [],
      directories = [];
    if (!this.allowed(directory)) return { files, directories };
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (!this.allowed(absolute)) continue;
        // Do not recurse directory symlinks: avoids loops and external directory traversal.
        if (entry.isDirectory()) directories.push(entry.name);
        else if (
          entry.isFile() ||
          (entry.isSymbolicLink() && this.stat(absolute)?.isFile())
        )
          files.push(entry.name);
      }
    } catch {}
    return { files, directories };
  }
  readDirectory(directory, extensions, exclude, include, depth) {
    if (!this.allowed(directory)) return [];
    let entries = 0;
    return ts.matchFiles(
      directory,
      extensions,
      exclude,
      include,
      ts.sys.useCaseSensitiveFileNames,
      this.root,
      depth ?? 30,
      (dir) => {
        if (++entries > 5000)
          throw new Error("项目过大，语言服务最多扫描 5000 个目录");
        return this.entries(dir);
      },
      (file) => this.canonical(file),
    );
  }
  refresh() {
    const configPath = path.join(this.root, "tsconfig.json");
    const jsConfigPath = path.join(this.root, "jsconfig.json");
    const selected = this.host.fileExists(configPath)
      ? configPath
      : this.host.fileExists(jsConfigPath)
        ? jsConfigPath
        : null;
    const defaults = {
      allowJs: true,
      checkJs: true,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      jsx: ts.JsxEmit.ReactJSX,
    };
    const raw = selected
      ? ts.readConfigFile(selected, (file) => this.read(file))
      : {
          config: {
            exclude: [
              "node_modules",
              ".git",
              ".rpo",
              "dist",
              "build",
              "release",
              ".next",
            ],
          },
        };
    if (raw.error)
      throw new Error(
        ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"),
      );
    const parsed = ts.parseJsonConfigFileContent(
      raw.config,
      {
        ...this.host,
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      },
      this.root,
      defaults,
      selected || undefined,
    );
    const invalid = parsed.errors.filter(
      (error) => ![18002, 18003].includes(error.code),
    );
    if (invalid.length)
      throw new Error(
        ts.flattenDiagnosticMessageText(invalid[0].messageText, "\n"),
      );
    this.options = { ...parsed.options, noEmit: true };
    this.files = parsed.fileNames.filter(
      (file) => this.allowed(file) && within(this.root, this.canonical(file)),
    );
    if (this.files.length > 2000)
      throw new Error("项目过大，语言服务最多分析 2000 个源文件");
    this.version++;
  }
  update(args) {
    const file = this.input(args.path),
      owner = String(args.documentId || "default");
    if (owner.length > 200) throw new Error("无效的文档标识");
    if (args.text !== undefined) {
      if (
        typeof args.text !== "string" ||
        Buffer.byteLength(args.text) > maxText
      )
        throw new Error("单个编辑快照不能超过 2 MB");
      const all = [...this.memory.values()].flatMap((map) => [...map.values()]);
      if (all.length >= 128 && !this.memory.get(file)?.has(owner))
        throw new Error("打开的语言文档过多");
      if (
        all.reduce((n, s) => n + Buffer.byteLength(s.text), 0) +
          Buffer.byteLength(args.text) -
          Buffer.byteLength(this.memory.get(file)?.get(owner)?.text || "") >
        16 * 1024 * 1024
      )
        throw new Error("编辑快照总量不能超过 16 MB");
      const snapshots = this.memory.get(file) || new Map();
      snapshots.set(owner, {
        text: args.text,
        version: String(++this.sequence),
        seq: this.sequence,
      });
      this.memory.set(file, snapshots);
      this.version++;
    }
    return file;
  }
  request(method, args) {
    if (method === "close") {
      const file = this.input(args.path),
        owners = this.memory.get(file);
      owners?.delete(String(args.documentId || "default"));
      if (!owners?.size) this.memory.delete(file);
      this.version++;
      return { ok: true };
    }
    const file = this.update(args);
    if (method === "update") return { ok: true };
    this.refresh();
    if (!this.files.includes(file)) this.files.push(file);
    const text = this.read(file);
    if (text === undefined) throw new Error("无法读取该文件");
    if (method === "diagnostics")
      return [
        ...this.service.getSyntacticDiagnostics(file),
        ...this.service.getSemanticDiagnostics(file),
      ]
        .slice(0, 200)
        .map((d) => ({
          from: Math.min(text.length, d.start || 0),
          to: Math.min(text.length, (d.start || 0) + (d.length || 0)),
          severity:
            d.category === ts.DiagnosticCategory.Error
              ? "error"
              : d.category === ts.DiagnosticCategory.Warning
                ? "warning"
                : "info",
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          code: d.code,
        }));
    if (
      !Number.isInteger(args.offset) ||
      args.offset < 0 ||
      args.offset > text.length
    )
      throw new Error("无效的光标位置");
    if (method === "completions") {
      const result = this.service.getCompletionsAtPosition(file, args.offset, {
        includeCompletionsForModuleExports: false,
        includeCompletionsWithInsertText: true,
      });
      return (result?.entries || [])
        .slice(0, 250)
        .map((entry) => ({
          label: entry.name,
          kind: entry.kind,
          sortText: entry.sortText,
          insertText: entry.insertText,
          from: entry.replacementSpan?.start,
          to: entry.replacementSpan
            ? entry.replacementSpan.start + entry.replacementSpan.length
            : undefined,
        }));
    }
    if (method === "definition")
      return (this.service.getDefinitionAtPosition(file, args.offset) || [])
        .filter(
          (d) =>
            within(this.root, path.resolve(d.fileName)) &&
            within(this.root, this.canonical(d.fileName)) &&
            this.allowed(d.fileName),
        )
        .map((d) => {
          const source = this.service.getProgram()?.getSourceFile(d.fileName);
          const pos = source?.getLineAndCharacterOfPosition(d.textSpan.start);
          return {
            path: path
              .relative(this.root, d.fileName)
              .split(path.sep)
              .join("/"),
            offset: d.textSpan.start,
            line: (pos?.line || 0) + 1,
            column: (pos?.character || 0) + 1,
          };
        });
    throw new Error("未知语言服务操作");
  }
}
parentPort.on("message", ({ id, method, root, args }) => {
  try {
    const canonical = fs.realpathSync(root);
    let project = projects.get(canonical);
    if (!project) {
      if (projects.size >= 8) {
        const oldest = projects.keys().next().value;
        projects.get(oldest).service.dispose();
        projects.delete(oldest);
      }
      project = new Project(canonical);
      projects.set(canonical, project);
    }
    parentPort.postMessage({ id, result: project.request(method, args) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
