const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createAudioService } = require('../../miniprogram/services/audio-service');

const ROOT = path.resolve(__dirname, '../..');

test('default audio service uses a packaged non-empty local AAC notification asset', async () => {
  const context = {
    src: null,
    play() {},
    destroy() {}
  };
  const service = createAudioService({
    wxApi: {
      createInnerAudioContext() { return context; }
    }
  });

  const result = await service.play();
  assert.deepEqual(result, { supported: true });
  assert.equal(context.src, '/assets/workout-notification.m4a');

  const project = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
  const assetPath = path.join(ROOT, project.miniprogramRoot, context.src.slice(1));
  const bytes = fs.readFileSync(assetPath);
  assert.ok(bytes.length >= 512, 'notification asset must contain packaged audio data');
  assert.equal(bytes.subarray(4, 8).toString('ascii'), 'ftyp');

  service.destroy();
});
