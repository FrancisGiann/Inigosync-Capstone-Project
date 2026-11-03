import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [ownerPage, staffPage, customerPage, onboardingPage, customerScript, ownerScript, staffScript] = await Promise.all([
  read('Pages/owner_dashboard.html'),
  read('Pages/staff_dashboard.html'),
  read('Pages/user_dashboard.html'),
  read('Pages/staff_onboarding.html'),
  read('includes/Dashboard.js'),
  read('includes/owner_dashboard.js'),
  read('includes/staff_dashboard.js'),
]);

function promptOptions(html, label) {
  return [...html.matchAll(/<option\b[^>]*>[\s\S]*?<\/option>/g)]
    .map(([option]) => option)
    .filter((option) => option.endsWith(`>${label}</option>`));
}

function assertPromptIsNotSelectable(html, label) {
  const options = promptOptions(html, label);
  assert.ok(options.length, `expected a ${label} prompt`);
  options.forEach((option) => {
    assert.match(option, /\bvalue=""/);
    assert.match(option, /\bdisabled\b/);
    assert.match(option, /\bhidden\b/);
  });
}

test('static select prompts remain visible initially without being selectable', () => {
  assertPromptIsNotSelectable(onboardingPage, 'Select…');
  assertPromptIsNotSelectable(customerPage, 'Select…');
  assertPromptIsNotSelectable(customerPage, 'Select if you wish');
  assertPromptIsNotSelectable(staffPage, 'Select…');
  assert.match(staffPage, /<option value="" disabled hidden>All sports<\/option>/);
  assert.match(staffPage, /<option value="" disabled hidden>All types<\/option>/);
  assert.match(staffPage, /<option value="" selected disabled hidden>Choose a sport first<\/option>/);
  assert.match(staffScript, /<option value="" disabled hidden>All sports<\/option>/);
  assert.match(staffScript, /<option value="" selected disabled hidden>\$\{choices\.length \? 'Choose an available unit' : 'No verified units available'\}<\/option>/);
  assertPromptIsNotSelectable(ownerPage, 'Select civil status');
  assert.match(ownerPage, /<option value="" selected disabled hidden>Select civil status<\/option>/);
});

test('notification actions keep the blank prompt separate from the real None action', () => {
  for (const html of [customerPage, staffPage]) {
    assertPromptIsNotSelectable(html, 'Select…');
    assert.match(html, /<option value="none">None<\/option>/);
  }
});

test('generated booking and business-hours prompts are disabled and hidden', () => {
  assert.doesNotMatch(customerScript, /<option value="">(?:Choose a court|Choose a sport first)<\/option>/);
  assert.match(customerScript, /<option value="" selected disabled hidden>Choose a sport first<\/option>/);
  const populatedCourtPrompts = [...customerScript.matchAll(/bookSelect\.innerHTML = '<option value="" selected disabled hidden>Choose a court<\/option>'/g)];
  assert.equal(populatedCourtPrompts.length, 4, 'each dynamically populated court select begins on the blank prompt');
  assert.match(customerScript, /<option value="" disabled hidden>Choose a court<\/option>/, 'the unit select prompt stays disabled and hidden while a real unit is selected');
  assert.match(ownerScript, /new Option\('Select time', '', true, true\)[\s\S]*option.disabled = true;[\s\S]*option.hidden = true;/);
});
