'use strict';

// Implementação mínima do formato de mensagem DNS (RFC 1035), apenas o
// necessário para: ler a pergunta de uma consulta, ler as respostas A de um
// servidor e montar respostas de bloqueio.

const TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 64: 'SVCB', 65: 'HTTPS' };
const HEADER_LEN = 12;
const MAX_POINTER_JUMPS = 16;

class DnsParseError extends Error {}

/** Lê um nome (com suporte a ponteiros de compressão). Retorna { name, next }. */
function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new DnsParseError('nome truncado');
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new DnsParseError('ponteiro truncado');
      if (++jumps > MAX_POINTER_JUMPS) throw new DnsParseError('ponteiros em loop');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (len > 63 || pos + 1 + len > buf.length) throw new DnsParseError('rótulo inválido');
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), next: next < 0 ? pos : next };
}

/** Lê o cabeçalho e a primeira pergunta de uma consulta. */
function parseQuery(buf) {
  if (buf.length < HEADER_LEN) throw new DnsParseError('mensagem curta');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdcount = buf.readUInt16BE(4);
  if (flags & 0x8000) throw new DnsParseError('não é uma consulta');
  if (qdcount < 1) throw new DnsParseError('sem pergunta');
  const { name, next } = readName(buf, HEADER_LEN);
  if (next + 4 > buf.length) throw new DnsParseError('pergunta truncada');
  const qtypeNum = buf.readUInt16BE(next);
  return {
    id,
    flags,
    name,
    qtypeNum,
    qtype: TYPES[qtypeNum] || String(qtypeNum),
    questionEnd: next + 4,
  };
}

/** Resposta para um domínio bloqueado: 0.0.0.0 / :: para A/AAAA, vazia nos demais tipos. */
function buildBlockedResponse(queryBuf, q) {
  const question = queryBuf.subarray(HEADER_LEN, q.questionEnd);
  const rdlen = q.qtypeNum === 1 ? 4 : q.qtypeNum === 28 ? 16 : 0;
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(0x8000 | (q.flags & 0x0100) | 0x0080, 2); // QR, RD copiado, RA
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(rdlen ? 1 : 0, 6);
  if (!rdlen) return Buffer.concat([header, question]);
  const answer = Buffer.alloc(12 + rdlen);
  answer.writeUInt16BE(0xc00c, 0); // ponteiro para o nome da pergunta
  answer.writeUInt16BE(q.qtypeNum, 2);
  answer.writeUInt16BE(1, 4); // classe IN
  answer.writeUInt32BE(60, 6); // TTL curto para que desbloquear tenha efeito rápido
  answer.writeUInt16BE(rdlen, 10);
  return Buffer.concat([header, question, answer]);
}

/** Resposta com IP customizado (usada para forçar SafeSearch no Google, YouTube e Bing). */
function buildIpResponse(queryBuf, q, ipv4Str, ipv6Buf) {
  const question = queryBuf.subarray(HEADER_LEN, q.questionEnd);
  let rdata = null;
  if (q.qtypeNum === 1 && ipv4Str) {
    const parts = ipv4Str.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
      rdata = Buffer.from(parts);
    }
  } else if (q.qtypeNum === 28 && ipv6Buf) {
    rdata = ipv6Buf;
  }
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(0x8000 | (q.flags & 0x0100) | 0x0080, 2); // QR, RD copiado, RA
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(rdata ? 1 : 0, 6);
  if (!rdata) return Buffer.concat([header, question]);
  const answer = Buffer.alloc(12 + rdata.length);
  answer.writeUInt16BE(0xc00c, 0); // ponteiro para o nome da pergunta
  answer.writeUInt16BE(q.qtypeNum, 2);
  answer.writeUInt16BE(1, 4); // classe IN
  answer.writeUInt32BE(60, 6); // TTL curto
  answer.writeUInt16BE(rdata.length, 10);
  rdata.copy(answer, 12);
  return Buffer.concat([header, question, answer]);
}

/** Resposta NXDOMAIN (usada para canários DoH e desativar Private Relay). */
function buildNxdomainResponse(queryBuf, q) {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(0x8000 | (q.flags & 0x0100) | 0x0080 | 3, 2); // rcode 3
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  return Buffer.concat([header, queryBuf.subarray(HEADER_LEN, q.questionEnd)]);
}

/** Resposta SERVFAIL, usada quando nenhum servidor upstream responde. */
function buildServfail(queryBuf, q) {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(0x8000 | (q.flags & 0x0100) | 0x0080 | 2, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, queryBuf.subarray(HEADER_LEN, q.questionEnd)]);
}

/** Monta uma consulta simples (usada para sondar o filtro familiar). */
function buildQuery(name, qtypeNum, id) {
  const parts = name.split('.').filter(Boolean);
  const qname = Buffer.concat([
    ...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'latin1')])),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtypeNum, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, qname, tail]);
}

/** Lê os registros de resposta. Retorna { id, rcode, answers: [{ type, data }] }. */
function parseResponse(buf) {
  if (buf.length < HEADER_LEN) throw new DnsParseError('mensagem curta');
  const id = buf.readUInt16BE(0);
  const rcode = buf.readUInt16BE(2) & 0x0f;
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  let pos = HEADER_LEN;
  for (let i = 0; i < qdcount; i++) pos = readName(buf, pos).next + 4;
  const answers = [];
  for (let i = 0; i < ancount; i++) {
    pos = readName(buf, pos).next;
    if (pos + 10 > buf.length) throw new DnsParseError('resposta truncada');
    const type = buf.readUInt16BE(pos);
    const rdlen = buf.readUInt16BE(pos + 8);
    const start = pos + 10;
    if (start + rdlen > buf.length) throw new DnsParseError('dados truncados');
    answers.push({ type, data: buf.subarray(start, start + rdlen) });
    pos = start + rdlen;
  }
  return { id, rcode, answers };
}

module.exports = { parseQuery, parseResponse, buildQuery, buildBlockedResponse, buildIpResponse, buildNxdomainResponse, buildServfail, DnsParseError };
