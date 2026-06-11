const fs = require('fs');
const path = require('path');

function resolveProjectRoot(startDir) {
  if (startDir == null) return null;
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, '.voltron'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

module.exports = { resolveProjectRoot };
