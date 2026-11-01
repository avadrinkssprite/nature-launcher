// Publishes a new build to GitHub:
//   new version.txt -> build app -> zip -> GitHub release (zip + installer) -> push version.txt
// Order matters: the release must exist before version.txt changes on main,
// otherwise installed launchers would prompt for an update that can't be downloaded yet.
// Usage: npm run release -- "What changed"   (commit and push code changes first)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const GH = process.env.GH || 'gh';
const sh = cmd => execSync(cmd, { cwd: root, stdio: 'inherit' });
const out = cmd => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
const notes = process.argv[2] || 'Bug fixes and improvements.';

if (out('git status --porcelain')) throw new Error('Commit (and push) your changes before releasing.');
sh('git push');

const id = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(root, 'version.txt'), id + '\n');
try {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
  sh('npx electron-builder --win');
  sh('node scripts/build-installer.js');
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // Windows bsdtar writes .zip
  execFileSync(tar, ['-a', '-c', '-f', path.join(root, 'dist', 'NatureLauncher-win-x64.zip'), '-C', path.join(root, 'dist', 'win-unpacked'), '.'], { stdio: 'inherit' });

  const tag = 'build-' + id.slice(0, 8);
  const date = new Date().toISOString().slice(0, 10);
  execFileSync(GH, ['release', 'create', tag,
    path.join(root, 'dist', 'NatureLauncherSetup.exe'), path.join(root, 'dist', 'NatureLauncher-win-x64.zip'),
    '--target', 'main', '--latest', '--title', `Nature Launcher ${date} (${id.slice(0, 8)})`,
    '--notes', `${notes}\n\nDownload **NatureLauncherSetup.exe** to install or update. Build ID: \`${id}\``], { cwd: root, stdio: 'inherit' });
} catch (e) {
  sh('git checkout -- version.txt'); // nothing was published, keep the old ID
  throw e;
}

sh('git add version.txt');
execFileSync('git', ['commit', '-q', '-m', `Release ${id.slice(0, 8)}\n\n${notes}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], { cwd: root, stdio: 'inherit' });
sh('git push');
console.log(`Released ${id}`);
