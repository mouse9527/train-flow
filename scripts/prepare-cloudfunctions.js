const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FUNCTION_NAMES = Object.freeze([
  'accountPurge',
  'authBootstrap',
  'syncPull',
  'syncPush'
]);
const SHARED_FILES = Object.freeze(['cloudbase-runtime.js', 'index.js']);

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (path.resolve(source) !== path.resolve(destination)) {
    fs.copyFileSync(source, destination);
  }
}

function materializeCloudFunctions({
  projectRoot = path.resolve(__dirname, '..'),
  targetRoot = path.join(projectRoot, 'cloudfunctions')
} = {}) {
  const cloudRoot = path.join(projectRoot, 'cloudfunctions');
  const sharedRoot = path.join(cloudRoot, 'shared');
  const fileDigests = {};
  for (const fileName of SHARED_FILES) {
    fileDigests[fileName] = digest(fs.readFileSync(path.join(sharedRoot, fileName)));
  }
  for (const functionName of FUNCTION_NAMES) {
    const sourceRoot = path.join(cloudRoot, functionName);
    const packageRoot = path.join(targetRoot, functionName);
    copyFile(path.join(sourceRoot, 'index.js'), path.join(packageRoot, 'index.js'));
    copyFile(path.join(sourceRoot, 'package.json'), path.join(packageRoot, 'package.json'));
    for (const fileName of SHARED_FILES) {
      copyFile(
        path.join(sharedRoot, fileName),
        path.join(packageRoot, '_shared', fileName)
      );
    }
  }
  return {
    functions: [...FUNCTION_NAMES],
    sharedDigest: digest(Buffer.from(JSON.stringify(fileDigests))),
    fileDigests
  };
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(materializeCloudFunctions(), null, 2)}\n`);
}

module.exports = { materializeCloudFunctions };
