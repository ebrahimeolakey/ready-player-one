import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function verify(app) {
  // Verify the resource seal and nested code, not just the main executable.
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
}

// electron-builder hook: a broken bundle must never reach the archiver.
export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  verify(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}

// Also verify extracted ZIPs, including when builder skips its signing hook.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'darwin') throw new Error('Mac package verification requires macOS.');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const archives = process.argv.slice(2);
  if (!archives.length) {
    for (const arch of ['arm64', 'x64']) archives.push(resolve('release', `Ready-Player-One-${pkg.version}-mac-${arch}.zip`));
  }
  for (const archive of archives) {
    const folder = await mkdtemp(join(tmpdir(), 'rpo-signature-'));
    try {
      execFileSync('/usr/bin/ditto', ['-x', '-k', resolve(archive), folder]);
      const apps = (await readdir(folder)).filter(name => name.endsWith('.app'));
      if (apps.length !== 1) throw new Error(`Expected one app in ${basename(archive)}`);
      verify(join(folder, apps[0]));
      console.log(`Verified archived signature: ${basename(archive)}`);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
}
