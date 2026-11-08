import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';

// Regression: the header "Shelf" button reads GET /api/shelf. It must answer with no web build present
// (startLab points webDist at a missing folder).
test('GET /api/shelf returns SHELF_URL (trailing slash trimmed) without a web build; POST is not 200', async () => {
  const prev = process.env.SHELF_URL;
  process.env.SHELF_URL = 'https://shelf.example:8443/';
  const lab = await startLab();
  try {
    const res = await lab.call('GET', '/api/shelf');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { shelfUrl: 'https://shelf.example:8443' });
    const post = await lab.call('POST', '/api/shelf', {});
    assert.notEqual(post.status, 200);
  } finally {
    if (prev === undefined) delete process.env.SHELF_URL; else process.env.SHELF_URL = prev;
    await lab.close();
  }
});
