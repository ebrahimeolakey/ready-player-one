import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import {
  UpdateService,
  compareVersions,
  pickRelease,
  checksumFor,
  INSTALL_SCRIPT,
} from "../desktop/services/updater.mjs";
const repo = "ebrahimeolakey/ready-player-one";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const payload = Buffer.from("verified release test");
function release({
  version = "1.1.0-beta.2",
  os = "mac",
  arch = "arm64",
  data = payload,
  digest = true,
} = {}) {
  const name = `Ready-Player-One-${version}-${os}-${arch}${os === "windows" ? "-setup.exe" : os === "linux" ? ".AppImage" : ".zip"}`;
  return {
    tag_name: `v${version}`,
    prerelease: version.includes("-"),
    draft: false,
    assets: [
      {
        name,
        state: "uploaded",
        size: data.length,
        digest: digest ? `sha256:${hash(data)}` : undefined,
        browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
      },
    ],
    html_url: `https://github.com/${repo}/releases/tag/v${version}`,
  };
}
async function setup({
  entry = release(),
  data = payload,
  fetchImpl,
  platform = "darwin",
  isPackaged = false,
  ...options
} = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), "rpo-updater-test-"));
  const calls = [];
  const service = new UpdateService({
    version: "1.0.0-beta.1",
    platform,
    arch: "arm64",
    cacheDir,
    isPackaged,
    fetch:
      fetchImpl ||
      (async (url, opts) => {
        calls.push(url);
        return url.includes("api.github.com")
          ? Response.json([entry])
          : new Response(data);
      }),
    ...options,
  });
  return { service, cacheDir, calls };
}

test("version comparison respects prerelease ordering and never downgrades", () => {
  assert.equal(compareVersions("1.1.0", "1.1.0-beta.10"), 1);
  assert.equal(compareVersions("1.1.0-beta.10", "1.1.0-beta.2"), 1);
  assert.equal(compareVersions("1.1.0-beta.1", "1.1.0-beta.1"), 0);
  assert.equal(
    pickRelease([release()], {
      version: "2.0.0",
      platform: "darwin",
      arch: "arm64",
    }),
    null,
  );
});
test("release selection skips newer Windows-only releases for Mac and respects architecture", () => {
  const entries = [
    release({ version: "1.2.0", os: "windows", arch: "x64" }),
    release(),
  ];
  assert.equal(
    pickRelease(entries, {
      version: "1.0.0-beta.1",
      platform: "darwin",
      arch: "arm64",
    }).version,
    "1.1.0-beta.2",
  );
  assert.equal(
    pickRelease(entries, {
      version: "1.0.0-beta.1",
      platform: "darwin",
      arch: "x64",
    }),
    null,
  );
  assert.equal(
    pickRelease(entries, {
      version: "1.0.0",
      platform: "darwin",
      arch: "arm64",
    }),
    null,
  );
});
test("verified download is cached, cannot install in dev, and never auto-launches installer", async () => {
  let launches = 0;
  const { service } = await setup({
    spawnInstaller: () => {
      launches++;
    },
  });
  await service.check();
  assert.equal(service.getState().status, "available");
  await service.download();
  assert.equal(service.getState().status, "ready");
  assert.equal(launches, 0);
  assert.deepEqual(await readFile(service.prepared.path), payload);
  await assert.rejects(() => service.install(), /开发模式/);
});
test("tampered payload is deleted instead of being offered for installation", async () => {
  const { service, cacheDir } = await setup({
    data: Buffer.from("tampered release test"),
  });
  await service.check();
  await assert.rejects(() => service.download(), /校验|大小/);
  assert.equal(service.prepared, null);
  assert.deepEqual(await readdir(cacheDir), []);
});
test("SHA256 file fallback works and does not match partial asset names", async () => {
  const entry = release({ digest: false });
  entry.assets.push({
    name: "SHA256SUMS.txt",
    browser_download_url: `https://github.com/${repo}/releases/download/v1.1.0-beta.2/SHA256SUMS.txt`,
  });
  const { service } = await setup({
    entry,
    fetchImpl: async (url) =>
      url.includes("api.github.com")
        ? Response.json([entry])
        : new Response(`${hash(payload)}  ${entry.assets[0].name}\n`),
  });
  await service.check();
  assert.equal(service.selection.sha256, hash(payload));
  assert.equal(checksumFor(`${hash(payload)}  foobar.zip`, "bar.zip"), null);
});
test("untrusted asset and redirect URLs are refused", async () => {
  const entry = release();
  entry.assets[0].browser_download_url = "https://evil.example.com/app.zip";
  const a = await setup({ entry });
  await assert.rejects(() => a.service.check(), /官方仓库/);
  const b = await setup({
    fetchImpl: async (url) =>
      url.includes("api.github.com")
        ? Response.json([release()])
        : new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/private" },
          }),
  });
  await b.service.check();
  await assert.rejects(() => b.service.download(), /不受信任/);
});
test("install rechecks hash and Windows installer starts only after explicit install", async () => {
  let launches = 0,
    quit = 0;
  const entry = release({ os: "windows" });
  const { service } = await setup({
    entry,
    platform: "win32",
    isPackaged: true,
    quit: () => quit++,
    spawnInstaller: () => {
      launches++;
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await service.check();
  await service.download();
  await writeFile(service.prepared.path, "modified");
  await assert.rejects(() => service.install(), /已改变/);
  assert.equal(launches, 0);
  await writeFile(service.prepared.path, payload);
  await service.install();
  assert.equal(launches, 1);
  assert.equal(quit, 1);
});
test("Linux staging verifies ELF architecture and preserves executable permission", async () => {
  const elf = Buffer.alloc(32);
  elf.set([127, 69, 76, 70]);
  elf.writeUInt16LE(183, 18);
  const entry = release({ os: "linux", data: elf });
  const { service, cacheDir } = await setup({
    entry,
    data: elf,
    platform: "linux",
  });
  const installed = join(cacheDir, "app.AppImage");
  await writeFile(installed, "old");
  service.options.appImagePath = installed;
  await service.check();
  await service.download();
  const plan = await service.prepareLinux(service.prepared);
  assert.deepEqual(await readFile(plan.next), elf);
  elf.writeUInt16LE(62, 18);
  await writeFile(service.prepared.path, elf);
  await assert.rejects(() => service.prepareLinux(service.prepared), /架构/);
});
test(
  "installer script preserves prior app and handles spaces without shell expansion",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "rpo-install-script-"));
    const target = join(dir, "app $(echo broken).AppImage"),
      next = join(dir, "next file"),
      backup = join(dir, "backup file"),
      script = join(dir, "install.sh");
    await writeFile(target, "old");
    await writeFile(next, "#!/bin/sh\nexit 0\n");
    await chmod(next, 0o755);
    await writeFile(script, INSTALL_SCRIPT);
    await promisify(execFile)("/bin/sh", [
      script,
      "2147483647",
      target,
      next,
      backup,
      "linux",
    ]);
    assert.equal(await readFile(backup, "utf8"), "old");
    assert.match(await readFile(target, "utf8"), /exit 0/);
  },
);

test("Mac architecture validation supports thin and universal binaries without Xcode", async () => {
  const { machOHasArchitecture } =
    await import("../desktop/services/updater.mjs");
  const thin = Buffer.alloc(32);
  thin.writeUInt32LE(0xfeedfacf, 0);
  thin.writeUInt32LE(0x0100000c, 4);
  assert.equal(machOHasArchitecture(thin, "arm64"), true);
  assert.equal(machOHasArchitecture(thin, "x64"), false);
  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8);
  fat.writeUInt32BE(0x0100000c, 28);
  assert.equal(machOHasArchitecture(fat, "arm64"), true);
  assert.equal(machOHasArchitecture(fat, "x64"), true);
  assert.equal(machOHasArchitecture(fat.subarray(0, 15), "arm64"), false);
});

test(
  "failed replacement rolls back the previous application",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "rpo-update-rollback-"));
    const target = join(dir, "current"),
      backup = join(dir, "backup"),
      script = join(dir, "apply.sh");
    await writeFile(target, "preserve me");
    await writeFile(script, INSTALL_SCRIPT);
    await assert.rejects(() =>
      promisify(execFile)("/bin/sh", [
        script,
        "2147483647",
        target,
        join(dir, "missing"),
        backup,
        "linux",
      ]),
    );
    assert.equal(await readFile(target, "utf8"), "preserve me");
  },
);

test('Mac restart keeps the isolated data directory and starts the selected bundle as a new instance', { skip: process.platform === 'win32' }, async () => {
  const { mkdir, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'rpo-relaunch-env-'));
  const target = join(dir, 'current.app'), next = join(dir, 'next.app'), backup = join(dir, 'backup.app');
  const script = join(dir, 'apply.sh'), launcher = join(dir, 'open-fixture'), output = join(dir, 'args');
  const dataDir = join(dir, 'data $(must-not-execute) 中文');
  try {
    await mkdir(target); await mkdir(next);
    await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RPO_TEST_LAUNCH_ARGS"\n', { mode: 0o700 });
    await writeFile(script, INSTALL_SCRIPT.replaceAll('/usr/bin/open', '"' + launcher + '"'));
    await promisify(execFile)('/bin/sh', [script, '2147483647', target, next, backup, 'darwin'], { env: { ...process.env, RPO_DATA_DIR: dataDir, RPO_IDENTITY_ISSUER: 'https://identity.example.test/团队', RPO_IDENTITY_PUBLIC_KEY_FILE: join(dir, '公钥 config $(no-eval).pem'), RPO_TEST_LAUNCH_ARGS: output } });
    assert.deepEqual((await readFile(output, 'utf8')).trimEnd().split('\n'), ['-n', '--env', 'RPO_DATA_DIR=' + dataDir, '--env', 'RPO_IDENTITY_ISSUER=https://identity.example.test/团队', '--env', 'RPO_IDENTITY_PUBLIC_KEY_FILE=' + join(dir, '公钥 config $(no-eval).pem'), target]);
    assert.deepEqual(await readdir(backup), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
