import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A response body that could not be represented as text (zip exports,
 * PDFs, images, ...). Kept as raw bytes so nothing is lost to decoding.
 */
export class BinaryContent {
  constructor(
    public readonly data: Buffer,
    public readonly mimeType: string,
    /** Request URL (path prefix + path) the content was downloaded from. */
    public readonly url: string,
  ) {}
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Split a Content-Type header into its lowercase media type and optional charset. */
function parseContentType(contentType: string | undefined): { mediaType: string; charset?: string } {
  const [mediaType, ...params] = (contentType ?? '').split(';').map((s) => s.trim());
  const charsetParam = params.find((p) => p.toLowerCase().startsWith('charset='));
  const charset = charsetParam?.slice('charset='.length).replace(/^"|"$/g, '').trim();
  return { mediaType: mediaType.toLowerCase(), charset: charset || undefined };
}

/**
 * Mirror axios' default response handling: a body that parses as JSON is
 * returned parsed, anything else is returned as the plain string.
 */
function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Decode with the given charset, or return undefined if the label is unknown. */
function decodeWithCharset(bytes: Buffer, charset: string): string | undefined {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Strict UTF-8 decode: undefined if the bytes are not valid UTF-8 or contain NUL. */
function decodeStrictUtf8(bytes: Buffer): string | undefined {
  if (bytes.includes(0x00)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Convert a raw HTTP response body into the value returned to the tool caller.
 *
 * - JSON (`application/json`) and UTF-8 text bodies are returned exactly as
 *   before (parsed JSON, or the plain string).
 * - Bodies with an explicit charset are decoded with that charset.
 * - Everything else (CPI declares `application/octet-stream` for all `$value`
 *   media resources, scripts included) is strictly UTF-8 decoded; if that
 *   fails, or the body is a zip, it is returned as {@link BinaryContent}.
 */
export function decodeResponseBody(bytes: Buffer, contentType: string | undefined, url: string): unknown {
  const { mediaType, charset } = parseContentType(contentType);
  const isZip = bytes.subarray(0, 4).equals(ZIP_MAGIC);

  if (!isZip) {
    if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
      return parseJsonOrText(new TextDecoder(charset ?? 'utf-8').decode(bytes));
    }

    if (charset) {
      const text = decodeWithCharset(bytes, charset);
      if (text !== undefined) return parseJsonOrText(text);
    }

    const text = decodeStrictUtf8(bytes);
    if (text !== undefined) return parseJsonOrText(text);
  }

  let mimeType = mediaType || 'application/octet-stream';
  if (isZip && (mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream')) {
    mimeType = 'application/zip';
  }
  return new BinaryContent(bytes, mimeType, url);
}

/**
 * Format binary content as an MCP embedded resource (base64 blob), preceded by
 * a short text summary. Bodies above `maxBytes` are rejected with an error
 * result instead of producing a huge or truncated response.
 */
export function formatBinaryResult(content: BinaryContent, maxBytes: number): CallToolResult {
  const size = content.data.length;

  if (size > maxBytes) {
    return {
      content: [{
        type: 'text',
        text: `Error: binary response of ${size} bytes (${content.mimeType}) exceeds the limit of ` +
          `${maxBytes} bytes. Raise MAX_BINARY_RESPONSE_SIZE to allow larger downloads.`,
      }],
      isError: true,
    };
  }

  const sha256 = createHash('sha256').update(content.data).digest('hex');

  return {
    content: [
      {
        type: 'text',
        text: `Binary content: ${content.mimeType}, ${size} bytes, sha256 ${sha256}`,
      },
      {
        type: 'resource',
        resource: {
          uri: `odata:${encodeURI(content.url)}`,
          mimeType: content.mimeType,
          blob: content.data.toString('base64'),
        },
      },
    ],
  };
}
