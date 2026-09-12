import assert from 'node:assert/strict';
import { validateSmashInput, validateSmashRecipe } from '../src/train-smash.ts';

const recipe = { title: '<Rice & eggs>', description: 'Dinner', servings: 2, minutes: 15, ingredients: ['2 eggs', '200 g cooked rice'], steps: ['Cook the eggs, then add the rice and heat thoroughly.'], notes: 'Use safely stored rice.' };
assert.deepEqual(validateSmashRecipe(recipe), recipe);
for (const invalid of [null, {}, { ...recipe, ingredients: [] }, { ...recipe, steps: [null] }, { ...recipe, minutes: -1 }, { ...recipe, servings: 100 }]) assert.throws(() => validateSmashRecipe(invalid));
assert.throws(() => validateSmashInput({ ingredients: ' ', servings: 2, preferences: '' }));
assert.throws(() => validateSmashInput({ ingredients: 'eggs', servings: 1.5, preferences: '' }));
assert.throws(() => validateSmashInput({ ingredients: 'a'.repeat(4001), servings: 2, preferences: '' }));
assert.equal(validateSmashInput({ ingredients: ' eggs ', servings: 2, preferences: '' }).ingredients, 'eggs');
console.log('Train Smash validation passed.');

// Use only a fresh, isolated local Worker database; --live spends one Codex generation.
if (process.argv.includes('--live')) {
  const base = process.env.MEALS_TEST_URL || 'http://127.0.0.1:8790';
  let cookie = '';
  const request = (path, data, headers = {}) => fetch(base + path, { method: data ? 'POST' : 'GET', redirect: 'manual', headers: { Cookie: cookie, Origin: base, ...headers }, body: data ? new URLSearchParams(data) : undefined });
  assert.equal((await request('/train-smash')).status, 303);
  assert.match(await (await request('/login')).text(), /Create.*parent|Set up|household|Log in/i);
  await request('/setup', { name: 'Smash test', password: 'isolated-test-password' });
  const login = await request('/login', { name: 'Smash test', password: 'isolated-test-password' });
  assert.equal(login.status, 303);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(await (await request('/train-smash')).text(), /What have you got/);
  assert.equal((await request('/train-smash', { ingredients: 'eggs', servings: '2' }, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await request('/train-smash', { ingredients: '', servings: '2' })).status, 400);
  const generated = await request('/train-smash', { ingredients: '4 eggs, 200 g dry pasta, 100 g cheddar cheese, salt, black pepper, olive oil', servings: '2', preferences: 'Vegetarian' });
  if (generated.status !== 303) throw new Error('Live generation failed: ' + (await generated.text()).match(/role="alert">([^<]+)/)?.[1]);
  const draftPath = generated.headers.get('location');
  const id = draftPath.split('/').pop();
  const detail = await (await request(draftPath)).text();
  assert.match(detail, /We tried it and liked it/);
  assert.equal((await request('/recipes/train-smash:' + id)).status, 404);
  assert.equal((await request(draftPath + '/save', {})).status, 400);
  const saved = await request(draftPath + '/save', { tried: 'yes' });
  assert.equal(saved.status, 303);
  const recipePath = saved.headers.get('location');
  assert.match(await (await request(recipePath)).text(), /Serves 2/);
  await request(recipePath + '/edit', { title: 'A keeper — edited', subtitle: 'Serves 2', description: 'Edited after cooking', image_url: '' });
  assert.equal((await request(draftPath + '/save', { tried: 'yes' })).headers.get('location'), recipePath);
  assert.match(await (await request(recipePath)).text(), /A keeper — edited/);
  assert.match(await (await request(draftPath)).text(), /In your rotation/);
  console.log('Live generation, draft isolation, confirmation, persistence, and repeat-save checks passed. Draft ID: ' + id);
}
