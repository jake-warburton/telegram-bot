import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TELEGRAM_PHOTO_MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface TelegramBrowserSendPhotoPageOptions {
  botToken: string;
  chatId: string | number;
  caption: string;
  filename: string;
  mimeType: string;
  photoBase64: string;
}

interface TelegramBrowserSendPhotoCliOptions {
  chatId: string;
  photoPath: string;
  caption: string;
  outPath: string;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function serializeInlineScriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function inferTelegramPhotoMimeType(filePath: string): string {
  return TELEGRAM_PHOTO_MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function buildTelegramBrowserSendPhotoPageHtml(
  options: TelegramBrowserSendPhotoPageOptions,
): string {
  const payload = serializeInlineScriptValue({
    base64: options.photoBase64,
    mimeType: options.mimeType,
    filename: options.filename,
  });
  const action = `https://api.telegram.org/bot${options.botToken}/sendPhoto`;

  return `<!doctype html>
<html>
<body style="font:16px -apple-system,BlinkMacSystemFont,sans-serif;padding:24px;background:#111;color:#eee;">
<div id="status">Preparing upload...</div>
<form
  id="send-photo-form"
  action="${escapeHtmlAttribute(action)}"
  method="POST"
  enctype="multipart/form-data"
>
  <input type="hidden" name="chat_id" value="${escapeHtmlAttribute(String(options.chatId))}">
  <input type="hidden" name="caption" value="${escapeHtmlAttribute(options.caption)}">
  <input id="photo-input" type="file" name="photo">
</form>
<script>
const payload = ${payload};
const status = document.getElementById('status');
const form = document.getElementById('send-photo-form');
const input = document.getElementById('photo-input');
const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
const file = new File([bytes], payload.filename, { type: payload.mimeType });
const transfer = new DataTransfer();
transfer.items.add(file);
input.files = transfer.files;
status.textContent = 'Submitting photo to Telegram...';
setTimeout(() => form.submit(), 300);
</script>
</body>
</html>`;
}

function readCaptionArg(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${args[index]}.`);
  }
  return value;
}

function parseCliArgs(args: string[]): TelegramBrowserSendPhotoCliOptions {
  let chatId = '';
  let photoPath = '';
  let caption = '';
  let outPath = '/tmp/telegram-send-photo.html';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--chat-id':
        chatId = readCaptionArg(args, index);
        index += 1;
        break;
      case '--photo':
        photoPath = readCaptionArg(args, index);
        index += 1;
        break;
      case '--caption':
        caption = readCaptionArg(args, index);
        index += 1;
        break;
      case '--caption-file':
        caption = readFileSync(readCaptionArg(args, index), 'utf8').trimEnd();
        index += 1;
        break;
      case '--out':
        outPath = readCaptionArg(args, index);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!chatId) {
    throw new Error('Missing required --chat-id.');
  }

  if (!photoPath) {
    throw new Error('Missing required --photo.');
  }

  return {
    chatId,
    photoPath,
    caption,
    outPath,
  };
}

function usage(): string {
  return [
    'Usage:',
    '  npm run telegram:browser-photo -- --chat-id <chat-id> --photo <path> [--caption <text> | --caption-file <path>] [--out <path>]',
    '',
    'Example:',
    '  npm run telegram:browser-photo -- --chat-id 8724653380 --photo /tmp/screenshot.png --caption-file /tmp/caption.txt',
    '',
    'Open the generated file URL in Chrome to submit the photo using the browser network stack.',
  ].join('\n');
}

export function buildTelegramBrowserSendPhotoPage(
  botToken: string,
  chatId: string,
  photoPath: string,
  caption: string,
): string {
  const resolvedPhotoPath = resolve(photoPath);
  const photoBase64 = readFileSync(resolvedPhotoPath).toString('base64');

  return buildTelegramBrowserSendPhotoPageHtml({
    botToken,
    chatId,
    caption,
    filename: basename(resolvedPhotoPath),
    mimeType: inferTelegramPhotoMimeType(resolvedPhotoPath),
    photoBase64,
  });
}

function main(): void {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is required.');
    }

    const resolvedPhotoPath = resolve(options.photoPath);
    if (!existsSync(resolvedPhotoPath)) {
      throw new Error(`Photo file not found: ${resolvedPhotoPath}`);
    }

    const resolvedOutPath = resolve(options.outPath);
    mkdirSync(dirname(resolvedOutPath), { recursive: true });
    writeFileSync(
      resolvedOutPath,
      buildTelegramBrowserSendPhotoPage(botToken, options.chatId, resolvedPhotoPath, options.caption),
    );

    console.log(`Wrote ${resolvedOutPath}`);
    console.log(`Open ${pathToFileURL(resolvedOutPath).href} in Chrome to send the photo.`);
  } catch (error: any) {
    console.error(error?.message ?? String(error));
    console.error('');
    console.error(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
