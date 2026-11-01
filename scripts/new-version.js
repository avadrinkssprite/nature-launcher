// Writes a new random ID to version.txt. Pushing it makes installed launchers offer the update.
const id = require('crypto').randomBytes(16).toString('hex');
require('fs').writeFileSync(require('path').join(__dirname, '..', 'version.txt'), id + '\n');
console.log(id);
