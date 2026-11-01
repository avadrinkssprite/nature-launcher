// Compiles installer/Setup.cs into dist/NatureLauncherSetup.exe with the C# compiler built into Windows.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const ico = path.join(root, 'build', 'icon.ico');
const out = path.join(root, 'dist', 'NatureLauncherSetup.exe');

// .ico with the 256px PNG embedded as-is (supported since Windows Vista)
const png = fs.readFileSync(path.join(root, 'build', 'icon.png'));
const head = Buffer.alloc(22);
head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);               // type icon, 1 image
head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);             // planes, bpp (width/height 0 = 256)
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);    // size, offset
fs.writeFileSync(ico, Buffer.concat([head, png]));

fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(csc, [
  '/nologo', '/target:winexe', '/optimize+', `/out:${out}`, `/win32icon:${ico}`,
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Core.dll', '/r:Microsoft.CSharp.dll',
  '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
  path.join(root, 'installer', 'Setup.cs'),
], { stdio: 'inherit' });
console.log('Built', out);
