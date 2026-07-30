const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FORBIDDEN_FIXTURE_PATTERNS = [
  {
    label: 'identity credential assignment',
    pattern: /["']?(?:openid|unionid|session_key|sessionKey)["']?\s*[:=]\s*["'`][^"'`\r\n]+/i
  },
  {
    label: 'AppSecret assignment',
    pattern: /["']?appsecret["']?\s*[:=]\s*["'`][^"'`\r\n]+/i
  },
  {
    label: 'real-name fixture',
    pattern: /["']?(?:realName|fullName|legalName|patientName|userName)["']?\s*[:=]\s*["'`][^"'`\r\n]{2,}/i
  },
  { label: 'mainland mobile number', pattern: /\b1[3-9]\d{9}\b/ },
  { label: 'mainland identity number', pattern: /\b\d{17}[\dXx]\b/ },
  { label: 'email address', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  {
    label: 'health fixture field',
    pattern: /["']?(?:heartRate|restingHeartRate|weightKg|bodyWeight|medicalHistory|diseaseHistory|diagnosisHistory|bloodPressure|systolicPressure|diastolicPressure)["']?\s*[:=]\s*(?:"|'|`|\{|\[|\d|true|false)/i
  },
  {
    label: 'Chinese identity or health fixture field',
    pattern: /["'](?:真实姓名|姓名|手机号|身份证号|邮箱|心率|体重|病史)["']\s*:\s*(?:["'][^"'\r\n]+["']|\d+)/
  }
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function findSensitiveFixtures(content) {
  return FORBIDDEN_FIXTURE_PATTERNS.filter(({ pattern }) => pattern.test(content));
}

function createSettingsPageHarness() {
  const pageModulePath = require.resolve('../../miniprogram/pages/settings/index');
  const repositoryModulePath = require.resolve(
    '../../miniprogram/domain/identity-settings/settings-repository-stub'
  );
  delete require.cache[pageModulePath];
  delete require.cache[repositoryModulePath];

  let pageDefinition = null;
  const originalPage = global.Page;
  global.Page = (definition) => {
    pageDefinition = definition;
  };

  try {
    require(pageModulePath);
  } finally {
    if (originalPage === undefined) {
      delete global.Page;
    } else {
      global.Page = originalPage;
    }
  }

  assert.ok(pageDefinition, 'settings page must register through Page()');
  const setDataCalls = [];
  const page = {
    ...pageDefinition,
    data: { ...pageDefinition.data },
    setData(patch) {
      setDataCalls.push(patch);
      this.data = { ...this.data, ...patch };
    }
  };

  return { page, setDataCalls };
}

test('project.config.json declares a placeholder AppID, never a real one', () => {
  const config = readJson('project.config.json');

  assert.equal(config.appid, 'touristappid');
});

test('app sitemap resolves inside miniprogramRoot and local DevTools config stays ignored', () => {
  const projectConfig = readJson('project.config.json');
  const appJson = readJson('miniprogram/app.json');
  const sitemapPath = path.join(ROOT, projectConfig.miniprogramRoot, appJson.sitemapLocation);

  assert.ok(fs.existsSync(sitemapPath), `missing sitemap at ${sitemapPath}`);

  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^project\.private\.config\.json$/m);
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

test('settings page exposes editable time pickers for start and recommended end times', () => {
  const pageWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/index.wxml'), 'utf8');
  const pickerTags = pageWxml.match(/<picker[\s\S]*?>/g) || [];

  for (const field of ['defaultStartLocalTime', 'recommendedEndLocalTime']) {
    assert.ok(
      pickerTags.some(
        (tag) =>
          tag.includes('mode="time"') &&
          tag.includes(`data-field="${field}"`) &&
          tag.includes('bindchange="onTimeChange"')
      ),
      `missing editable time picker for ${field}`
    );
  }

  const { page, setDataCalls } = createSettingsPageHarness();
  page.onLoad({ section: 'preferences' });
  const initial = page.data.settings;

  page.onTimeChange({
    currentTarget: { dataset: { field: 'defaultStartLocalTime' } },
    detail: { value: '07:20' }
  });
  const afterTimeChange = page.data.settings;

  page.onToggleField({
    currentTarget: { dataset: { field: 'soundEnabled' } }
  });

  assert.equal(page.data.section, 'preferences');
  assert.equal(afterTimeChange.defaultStartLocalTime, '07:20');
  assert.equal(afterTimeChange.revision, initial.revision + 1);
  assert.equal(page.data.settings.soundEnabled, !afterTimeChange.soundEnabled);
  assert.equal(page.data.settings.revision, initial.revision + 2);
  assert.deepEqual(
    setDataCalls.map(({ settings }) => settings && settings.revision).filter(Boolean),
    [initial.revision, initial.revision + 1, initial.revision + 2],
    'onLoad and both mutation handlers must publish each new revision through setData'
  );
});

test('fixture leak guard catches common identity and health samples without flagging safety copy', () => {
  const leakedFixtures = [
    '{"openId":"oFixtureOnly"}',
    "const appSecret = 'fixture-secret';",
    "const profile = { realName: '张三' };",
    '{"fullName":"李四"}',
    "const mobile = '13800138000';",
    "const idCard = '11010519491231002X';",
    "const email = 'trainer@example.com';",
    "const health = { heartRate: 88, weightKg: 72, medicalHistory: '高血压' };",
    '{"bloodPressure":"120/80"}'
  ];

  for (const fixture of leakedFixtures) {
    assert.ok(findSensitiveFixtures(fixture).length > 0, `expected fixture leak to be detected: ${fixture}`);
  }

  const safetyCopy =
    'TrainFlow 不保存 OpenID、AppSecret、真实姓名、手机号、心率、体重或病史；' +
    '本产品不提供医疗诊断，如胸闷或头晕请停止训练并补水。';
  assert.deepEqual(findSensitiveFixtures(safetyCopy), []);
});

test('no identity or health fixture data leaks into the repository (openId, real names, health metrics)', () => {
  const trackedGlobs = [
    'miniprogram',
    'project.config.json'
  ];
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
    assert.deepEqual(
      findSensitiveFixtures(content),
      [],
      `${file} contains forbidden identity or health fixture data`
    );
  }
});
