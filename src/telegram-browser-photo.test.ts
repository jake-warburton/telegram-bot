import { describe, expect, it } from 'vitest';

import {
  buildTelegramBrowserSendPhotoPageHtml,
  inferTelegramPhotoMimeType,
} from './telegram-browser-photo.js';

describe('inferTelegramPhotoMimeType', () => {
  it('returns the expected mime type for known image extensions', () => {
    expect(inferTelegramPhotoMimeType('/tmp/screenshot.png')).toBe('image/png');
    expect(inferTelegramPhotoMimeType('/tmp/screenshot.jpg')).toBe('image/jpeg');
  });

  it('falls back to octet-stream for unknown file types', () => {
    expect(inferTelegramPhotoMimeType('/tmp/screenshot.bin')).toBe('application/octet-stream');
  });
});

describe('buildTelegramBrowserSendPhotoPageHtml', () => {
  it('builds a form-submit page that targets the Telegram Bot API', () => {
    const html = buildTelegramBrowserSendPhotoPageHtml({
      botToken: '123:abc',
      chatId: '8724653380',
      caption: 'Session: 1\nCaptured screenshot.',
      filename: 'screen.png',
      mimeType: 'image/png',
      photoBase64: 'QUJD',
    });

    expect(html).toContain('https://api.telegram.org/bot123:abc/sendPhoto');
    expect(html).toContain('name="chat_id" value="8724653380"');
    expect(html).toContain('name="caption" value="Session: 1');
    expect(html).toContain("status.textContent = 'Submitting photo to Telegram...';");
    expect(html).toContain('form.submit()');
    expect(html).toContain("new File([bytes], payload.filename, { type: payload.mimeType })");
  });

  it('escapes html-sensitive caption content', () => {
    const html = buildTelegramBrowserSendPhotoPageHtml({
      botToken: '123:abc',
      chatId: '1',
      caption: '<script>alert("x")</script>',
      filename: 'screen.png',
      mimeType: 'image/png',
      photoBase64: 'QUJD',
    });

    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<input type="hidden" name="caption" value="<script>');
  });
});
