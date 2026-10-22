'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresenceTracker } = require('../analytics-presence');

test('multiple tabs from one browser count as one active device', () => {
  const presence = createPresenceTracker(65000);
  assert.equal(presence.heartbeat('browser-device-id-00000001', 'tab-session-id-00000001', 'admin', 1000), 1);
  assert.equal(presence.heartbeat('browser-device-id-00000001', 'tab-session-id-00000002', 'admin', 2000), 1);
  assert.equal(presence.heartbeat('browser-device-id-00000002', 'tab-session-id-00000003', 'admin', 2000), 2);
});

test('inactive devices expire after the heartbeat TTL', () => {
  const presence = createPresenceTracker(65000);
  presence.heartbeat('browser-device-id-00000001', 'tab-session-id-00000001', 'admin', 1000);
  presence.heartbeat('browser-device-id-00000002', 'tab-session-id-00000002', 'admin', 2000);
  assert.equal(presence.count(67001), 0);
});

test('leaving one tab preserves another tab on the same device', () => {
  const presence = createPresenceTracker();
  presence.heartbeat('browser-device-id-00000001', 'tab-session-id-00000001', 'admin', 1000);
  presence.heartbeat('browser-device-id-00000001', 'tab-session-id-00000002', 'admin', 1000);
  presence.heartbeat('browser-device-id-00000002', 'tab-session-id-00000003', 'admin', 1000);
  assert.equal(presence.leave('tab-session-id-00000001', 2000), 2);
  assert.equal(presence.count(2000), 2);
  assert.equal(presence.leave('tab-session-id-00000002', 3000), 1);
});
