'use strict';

const { randomUUID } = require('node:crypto');
const logger = require('./logger');

class Connection {
  constructor(ws, { userId, anonymous }) {
    this.id = `conn_${randomUUID()}`;
    this.ws = ws;
    this.userId = userId;
    this.anonymous = anonymous;
    this.sessionId = null;
    this.isAlive = true;
    this.inflight = new Set();
    this.connectedAt = Date.now();
  }

  send(payload) {
    if (this.ws.readyState !== this.ws.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }
}

class ConnectionRegistry {
  constructor() {
    this.connections = new Map();
  }

  add(connection) {
    this.connections.set(connection.id, connection);
    return connection;
  }

  remove(connectionId) {
    this.connections.delete(connectionId);
  }

  get(connectionId) {
    return this.connections.get(connectionId) || null;
  }

  get size() {
    return this.connections.size;
  }

  /**
   * Fan a gateway event out to every connection matching the filter.
   * `connectionId` wins over `sessionId`, which wins over `userId`.
   */
  deliver(filter, payload) {
    let targets = [];
    if (filter.connectionId) {
      const one = this.get(filter.connectionId);
      targets = one ? [one] : [];
    } else if (filter.sessionId) {
      targets = [...this.connections.values()].filter((c) => c.sessionId === filter.sessionId);
    } else if (filter.userId) {
      targets = [...this.connections.values()].filter((c) => c.userId === filter.userId);
    }

    let delivered = 0;
    for (const target of targets) {
      if (target.send(payload)) delivered += 1;
    }
    return delivered;
  }

  closeAll(code = 1001, reason = 'server shutting down') {
    for (const connection of this.connections.values()) {
      try {
        connection.ws.close(code, reason);
      } catch (err) {
        logger.warn('failed to close connection', { connectionId: connection.id, error: err.message });
      }
    }
    this.connections.clear();
  }
}

module.exports = { Connection, ConnectionRegistry };
