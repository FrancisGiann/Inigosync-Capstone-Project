import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const template = await readFile(
  new URL('../docs/email_templates/password_changed_notification.html', import.meta.url),
  'utf8',
);

test('password changed notification gives clear recovery and support steps', () => {
  assert.match(template, /Your password was changed/);
  assert.match(template, /If you made this change, no further action is needed/);
  assert.match(template, /Didn't change your password\?/);
  assert.match(template, /Forgot password\?/);
  const destinations = [...template.matchAll(/\bhref="([^"]+)"/g)].map(([, href]) => href);
  assert.deepEqual(destinations, [
    'https://inigossportcenter.com/',
    'mailto:itsrosem8@gmail.com',
    'https://inigossportcenter.com/',
  ]);
  assert.match(template, /<a href="https:\/\/inigossportcenter\.com\/"[^>]*>\s*Open I&ntilde;igoSync\s*<\/a>/);
});

test('password changed notification contains no template data or secret material', () => {
  assert.doesNotMatch(template, /{{\s*\./);
  assert.doesNotMatch(template, /ConfirmationURL|TokenHash|\.Token|password reset code/i);
});

test('template keeps a responsive table-based brand shell with inline styles', () => {
  assert.match(template, /<table role="presentation"/);
  assert.match(template, /background-color:#14110d/);
  assert.match(template, /background-color:#FF6115/);
  assert.match(template, /@media only screen and \(max-width: 620px\)/);
});
