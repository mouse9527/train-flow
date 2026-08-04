const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDocs } = require('../../scripts/check-docs');

test('owner documentation matches the delivered offline and cloud contracts', () => {
  const result = checkDocs();
  assert.deepEqual(result, {
    markdownFiles: 4,
    localLinks: 'pass',
    collections: 6,
    environmentVariables: 5,
    routes: 8
  });
});
