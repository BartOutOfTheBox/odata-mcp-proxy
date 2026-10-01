import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { BinaryContent, decodeResponseBody, formatBinaryResult } from './response-body.js';

const URL = "/api/v1/IntegrationDesigntimeArtifacts(Id='x',Version='active')/$value";

/** Minimal zip local-file header followed by compressed (non-UTF-8) data. */
function zipBytes(): Buffer {
  const header = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x08, 0x08, 0x00]);
  const data = deflateRawSync(Buffer.from('<bpmn2:definitions>'.repeat(50)));
  return Buffer.concat([header, data, Buffer.from([0x80, 0xff, 0xfe, 0x00])]);
}

test('zip bytes round-trip unchanged as application/zip', () => {
  const bytes = zipBytes();
  const result = decodeResponseBody(bytes, 'application/octet-stream', URL);

  assert.ok(result instanceof BinaryContent);
  assert.equal(result.mimeType, 'application/zip');
  assert.ok(result.data.equals(bytes));

  const formatted = formatBinaryResult(result, 10 * 1024 * 1024);
  const resource = formatted.content[1];
  assert.equal(resource.type, 'resource');
  assert.ok(resource.type === 'resource' && 'blob' in resource.resource);
  const blob = (resource.resource as { blob: string }).blob;
  assert.ok(Buffer.from(blob, 'base64').equals(bytes));
  assert.equal(resource.resource.mimeType, 'application/zip');
  assert.equal(formatted.isError, undefined);
});

test('ISO-8859-1 body with explicit charset decodes correctly', () => {
  const bytes = Buffer.from('Grüße aus Köln', 'latin1');
  const result = decodeResponseBody(bytes, 'text/plain; charset=ISO-8859-1', URL);
  assert.equal(result, 'Grüße aus Köln');
});

test('JSON responses are unchanged', () => {
  const body = { d: { results: [{ Id: 'Pkg', Name: 'München' }] } };
  const bytes = Buffer.from(JSON.stringify(body), 'utf-8');
  assert.deepEqual(decodeResponseBody(bytes, 'application/json; charset=utf-8', URL), body);
  assert.deepEqual(decodeResponseBody(bytes, 'application/json', URL), body);
});

test('octet-stream body with valid UTF-8 text is returned as text', () => {
  const script = 'import com.sap.gateway.ip.core.customdev.util.Message\n\ndef Message processData(Message message) {\n  // éè ✓\n  return message\n}\n';
  const result = decodeResponseBody(Buffer.from(script, 'utf-8'), 'application/octet-stream', URL);
  assert.equal(result, script);
});

test('non-UTF-8 body without charset is treated as binary', () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xe2, 0xe3, 0xcf, 0xd3]);
  const result = decodeResponseBody(bytes, 'application/pdf', URL);
  assert.ok(result instanceof BinaryContent);
  assert.equal(result.mimeType, 'application/pdf');
});

test('body with NUL bytes is treated as binary', () => {
  const result = decodeResponseBody(Buffer.from([0x41, 0x00, 0x42]), undefined, URL);
  assert.ok(result instanceof BinaryContent);
  assert.equal(result.mimeType, 'application/octet-stream');
});

test('binary above the size limit returns an error result', () => {
  const content = new BinaryContent(zipBytes(), 'application/zip', URL);
  const formatted = formatBinaryResult(content, 16);
  assert.equal(formatted.isError, true);
  assert.equal(formatted.content.length, 1);
});
