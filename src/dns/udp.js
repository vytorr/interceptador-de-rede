'use strict';

const dgram = require('node:dgram');

let sharedSocket = null;
const pending = new Map();

function getSharedSocket() {
  if (sharedSocket) return sharedSocket;
  const sock = dgram.createSocket('udp4');
  sock.on('error', (err) => {
    sharedSocket = null;
    try { sock.close(); } catch {}
  });
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 2) return;
    const id = msg.readUInt16BE(0);
    const item = pending.get(id);
    if (item && item.server === rinfo.address) {
      pending.delete(id);
      clearTimeout(item.timer);
      item.resolve(msg);
    }
  });
  sharedSocket = sock;
  return sock;
}

/**
 * Envia uma mensagem DNS para `server:53` e espera a resposta com o mesmo ID.
 */
function udpExchange(server, message, id, timeoutMs = 2500, port = 53) {
  return new Promise((resolve, reject) => {
    if (port !== 53) {
      // Porta customizada (usada em testes)
      const sock = dgram.createSocket('udp4');
      let done = false;
      const timer = setTimeout(() => finish(new Error(`sem resposta de ${server}`)), timeoutMs);
      function finish(err, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sock.close(); } catch {}
        if (err) reject(err);
        else resolve(value);
      }
      sock.on('error', (err) => finish(err));
      sock.on('message', (msg, rinfo) => {
        if (rinfo.address === server && msg.length >= 2 && msg.readUInt16BE(0) === id) finish(null, msg);
      });
      sock.send(message, port, server, (err) => err && finish(err));
      return;
    }

    try {
      const sock = getSharedSocket();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`sem resposta de ${server}`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer, server });
      sock.send(message, port, server, (err) => {
        if (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { udpExchange };
