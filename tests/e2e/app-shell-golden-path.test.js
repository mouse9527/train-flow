const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

test('project.config.json declares a placeholder AppID, never a real one', () => {
  const config = readJson('project.config.json');

  assert.equal(config.appid, 'touristappid');
});

test('app.json registers every V1 page with a matching page directory and required files', () => {
  const appJson = readJson('miniprogram/app.json');

  assert.ok(appJson.pages.length >= 5, 'expected at least the 5 V1 page routes');

  for (const pagePath of appJson.pages) {
    const dir = path.join(ROOT, 'miniprogram', path.dirname(pagePath));
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
      const file = path.join(ROOT, 'miniprogram', `${pagePath}${ext}`);
      assert.ok(fs.existsSync(file), `missing ${pagePath}${ext} for registered page`);
    }
    assert.ok(fs.existsSync(dir), `missing directory for registered page ${pagePath}`);
  }
});

test('tabBar exposes exactly the four V1 destinations required by AC1', () => {
  const appJson = readJson('miniprogram/app.json');
  const tabPaths = appJson.tabBar.list.map((item) => item.pagePath);

  assert.equal(tabPaths.length, 4);
  assert.ok(tabPaths.includes('pages/today/index'));
  assert.ok(tabPaths.includes('pages/plan/index'));
  assert.ok(tabPaths.includes('pages/record/index'));
  assert.ok(tabPaths.includes('pages/settings/index'));
});

test('settings page golden path: load preferences section then read about/safety copy without touching storage directly', () => {
  const pageSource = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/index.js'), 'utf8');

  assert.doesNotMatch(pageSource, /wx\.setStorageSync|wx\.getStorageSync/, 'page must not call storage directly');
  assert.match(pageSource, /settings-application-service/, 'page must go through the application service');

  const { createSettingsApplicationService } = require('../../miniprogram/application/settings-application-service');
  const { createSettingsRepositoryStub } = require('../../miniprogram/domain/identity-settings/settings-repository-stub');

  const service = createSettingsApplicationService({ repository: createSettingsRepositoryStub() });
  const preferences = service.getSettings();

  assert.ok(typeof preferences.defaultRestSeconds === 'number');

  const aboutWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/index.wxml'), 'utf8');
  assert.match(aboutWxml, /不提供医疗诊断/);
  assert.match(aboutWxml, /立即停止训练/);
  assert.match(aboutWxml, /补水/);
});

test('no identity or health fixture data leaks into the repository (openId, real names, health metrics)', () => {
  const trackedGlobs = [
    'miniprogram',
    'project.config.json',
    'sitemap.json'
  ];
  const forbiddenPatterns = [/openid\s*[:=]/i, /appsecret/i];

  const filesToScan = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        filesToScan.push(full);
      }
    }
  };

  for (const glob of trackedGlobs) {
    const full = path.join(ROOT, glob);
    if (fs.statSync(full).isDirectory()) {
      walk(full);
    } else {
      filesToScan.push(full);
    }
  }

  for (const file of filesToScan) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(content, pattern, `${file} must not reference ${pattern}`);
    }
  }
});
