import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../includes/Dashboard.js', import.meta.url), 'utf8');
const helperSource = source.match(/    async function getFunctionErrorMessage\(error, fallback\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(helperSource, 'customer checkout error helper is present');
const getFunctionErrorMessage = new Function(`${helperSource}; return getFunctionErrorMessage;`)();

test('customer Edge Function errors show the response message and preserve the response body', async () => {
  const response = new Response(JSON.stringify({ message: 'Checkout is unavailable.' }), { status: 503 });
  const error = { message: 'Edge Function returned a non-2xx status code', context: response };

  assert.equal(await getFunctionErrorMessage(error, 'Please retry.'), 'Checkout is unavailable.');
  assert.deepEqual(await response.json(), { message: 'Checkout is unavailable.' }, 'reading the error uses a response clone');
  assert.match(source, /getFunctionErrorMessage\(error, 'Secure checkout could not start/);
  assert.match(source, /getFunctionErrorMessage\(error, 'Could not reopen online checkout/);
});

test('customer Edge Function error falls back safely when the response body is not JSON', async () => {
  const error = {
    message: 'Edge Function returned a non-2xx status code',
    context: new Response('upstream unavailable', { status: 503 }),
  };

  assert.equal(await getFunctionErrorMessage(error, 'Please retry.'), 'Edge Function returned a non-2xx status code');
  assert.equal(await getFunctionErrorMessage({ context: null }, 'Please retry.'), 'Please retry.');
});
