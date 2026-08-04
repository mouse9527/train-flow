const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'README.md',
  'CHANGELOG.md',
  'docs/privacy-and-data.md',
  'docs/cloud-setup.md',
  'cloudfunctions/README.md',
  'tests/e2e/acceptance-matrix.md',
  '.env.example',
  '.gitignore',
  'project.config.json',
  'cloudbase/database.rules.json'
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function requireText(text, needles, label) {
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${label} must mention ${needle}`);
  }
}

function checkLocalLinks(relativePath) {
  const markdown = read(relativePath);
  const base = path.dirname(path.join(root, relativePath));
  const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const rawTarget of links) {
    if (/^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split('#')[0]);
    const resolved = path.resolve(base, target);
    assert.ok(resolved === root || resolved.startsWith(`${root}${path.sep}`), `${relativePath} link escapes repository: ${rawTarget}`);
    assert.ok(fs.existsSync(resolved), `${relativePath} has broken link: ${rawTarget}`);
  }
}

function checkDocs() {
  requiredFiles.forEach((file) => assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`));
  ['README.md', 'docs/privacy-and-data.md', 'docs/cloud-setup.md', 'cloudfunctions/README.md'].forEach(checkLocalLinks);

  const readme = read('README.md');
  requireText(readme, [
    'touristappid',
    'project.private.config.json',
    '不需要 CloudBase',
    '手机预览与体验版',
    '语音提示只保留设置项',
    '进行中的训练 Session 只在当前设备恢复',
    '真实 CloudBase 环境部署'
  ], 'README');

  const privacy = read('docs/privacy-and-data.md');
  requireText(privacy, [
    '本机清除与云端删除不是同一操作',
    '导出的私人 JSON',
    'OpenID',
    '训练 Session'
  ], 'privacy guide');

  const cloud = read('docs/cloud-setup.md');
  const envExample = read('.env.example');
  const requiredEnv = [
    'TRAINFLOW_ALLOWED_OPENID_SHA256',
    'TRAINFLOW_OWNER_HMAC_KEY',
    'TRAINFLOW_CURSOR_HMAC_KEY',
    'TRAINFLOW_PURGE_HMAC_KEY',
    'TRAINFLOW_PURGE_TTL_SECONDS'
  ];
  requiredEnv.forEach((name) => {
    assert.ok(cloud.includes(name), `cloud guide missing ${name}`);
    assert.match(envExample, new RegExp(`^${name}=$`, 'm'), `.env.example must keep ${name} empty`);
  });

  const rules = JSON.parse(read('cloudbase/database.rules.json'));
  const documentedCollections = Object.keys(rules.collections);
  documentedCollections.forEach((name) => {
    assert.ok(cloud.includes(`\`${name}\``), `cloud guide missing collection ${name}`);
    assert.deepEqual(rules.collections[name], { read: false, write: false });
  });

  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts['cloud:prepare'], 'node scripts/prepare-cloudfunctions.js');
  assert.equal(packageJson.scripts['docs:check'], 'node scripts/check-docs.js');
  assert.deepEqual(packageJson.dependencies, undefined);

  const projectConfig = JSON.parse(read('project.config.json'));
  assert.equal(projectConfig.appid, 'touristappid');
  assert.equal(projectConfig.miniprogramRoot, 'miniprogram/');
  assert.equal(projectConfig.cloudfunctionRoot, 'cloudfunctions/');

  const appJson = JSON.parse(read('miniprogram/app.json'));
  for (const page of appJson.pages) {
    assert.ok(fs.existsSync(path.join(root, 'miniprogram', `${page}.js`)), `missing page script ${page}`);
  }

  const acceptance = read('tests/e2e/acceptance-matrix.md');
  requireText(acceptance, ['真机振动/常亮', '真实云 smoke', '离线优先 V1'], 'acceptance matrix');

  return {
    markdownFiles: 4,
    localLinks: 'pass',
    collections: documentedCollections.length,
    environmentVariables: requiredEnv.length,
    routes: appJson.pages.length
  };
}

if (require.main === module) {
  process.stdout.write(`DOCS_CHECK_PASS ${JSON.stringify(checkDocs())}\n`);
}

module.exports = { checkDocs, checkLocalLinks };
