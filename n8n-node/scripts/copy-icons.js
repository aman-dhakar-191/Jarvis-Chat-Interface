// Icons are not TypeScript, so tsc ignores them; n8n needs them beside the
// compiled node file.
const fs = require('node:fs');
const path = require('node:path');

function copySvgs(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copySvgs(src, dest);
    } else if (entry.name.endsWith('.svg') || entry.name.endsWith('.png')) {
      fs.copyFileSync(src, dest);
      console.log('icon ->', dest);
    }
  }
}
copySvgs(path.join(__dirname, '..', 'nodes'), path.join(__dirname, '..', 'dist', 'nodes'));
