'use strict';

function createPresenceTracker(ttlMs = 65000) {
  const sessions = new Map();

  function prune(now) {
    for (const [id, session] of sessions) {
      if (now - session.lastSeenAt > ttlMs) sessions.delete(id);
    }
  }

  function heartbeat(deviceId, sessionId, username, now = Date.now()) {
    prune(now);
    sessions.set(sessionId, { deviceId, username, lastSeenAt: now });
    return new Set(Array.from(sessions.values(), session => session.deviceId)).size;
  }

  function leave(sessionId, now = Date.now()) {
    sessions.delete(sessionId);
    prune(now);
    return new Set(Array.from(sessions.values(), session => session.deviceId)).size;
  }

  function count(now = Date.now()) {
    prune(now);
    return new Set(Array.from(sessions.values(), session => session.deviceId)).size;
  }

  return { heartbeat, leave, count };
}

module.exports = { createPresenceTracker };
