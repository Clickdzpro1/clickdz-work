import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPublicHttpUrl,
  normalizeMaxTokens,
  validateEngineFields,
} from './guards.mjs';

test('normalizeMaxTokens defaults and clamps', () => {
  assert.equal(normalizeMaxTokens(undefined), 4000);
  assert.equal(normalizeMaxTokens('not-a-number'), 4000);
  assert.equal(normalizeMaxTokens(-10), 1);
  assert.equal(normalizeMaxTokens(2500.9), 2500);
  assert.equal(normalizeMaxTokens(999999), 16000);
});

test('assertPublicHttpUrl allows public HTTP(S) URLs', () => {
  assert.equal(
    assertPublicHttpUrl('https://cdn.example.com/file.png', 'file_url'),
    'https://cdn.example.com/file.png'
  );
  assert.equal(
    assertPublicHttpUrl('http://example.com/audio.mp3', 'file_url'),
    'http://example.com/audio.mp3'
  );
});

test('assertPublicHttpUrl rejects local and private-network targets', () => {
  for (const url of [
    'file:///etc/passwd',
    'http://localhost/admin',
    'http://127.0.0.1/admin',
    'http://127.1/admin',
    'http://0x7f000001/admin',
    'http://2130706433/admin',
    'http://[::ffff:127.0.0.1]/admin',
    'http://[::ffff:0:7f00:1]/admin',
    'http://10.1.2.3/file',
    'http://172.16.1.2/file',
    'http://192.168.0.2/file',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/admin',
    'https://service.internal/file',
    'https://user:password@example.com/file',
  ]) {
    assert.throws(() => assertPublicHttpUrl(url, 'file_url'), /file_url/);
  }
});

test('validateEngineFields enforces the URL field used by each OCR feature', () => {
  assert.equal(
    validateEngineFields('ocr_extract_text', {
      image_url: 'https://cdn.example.com/image.png',
    }).image_url,
    'https://cdn.example.com/image.png'
  );
  assert.equal(
    validateEngineFields('ocr_audio', {
      file_url: 'https://cdn.example.com/audio.mp3',
    }).file_url,
    'https://cdn.example.com/audio.mp3'
  );
  assert.throws(
    () =>
      validateEngineFields('ocr_describe', { file_url: 'http://127.0.0.1/a' }),
    /public host/
  );
});
