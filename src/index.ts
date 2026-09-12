import { Hono } from 'hono';
import {
  extract as extractRecipe,
  parseRecipeUrl
} from '../.agents/skills/recipe-import/scripts/sources/marley-spoon.cjs';

type RecipeSummary = {
  id: string;
  source: string;
  source_url: string;
  title: string;
  subtitle: string;
  description: string;
  image_url: string;
  tags_json: string;
};

type RecipeMacros = {
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
};

type RecipeIngredient = {
  text: string;
  name?: string;
  quantity?: number | null;
  unit?: string | null;
  size?: string | null;
  kind: string;
  allergens: string[];
};

type RecipeRow = RecipeSummary & {
  cook_time_from: number | null;
  cook_time_to: number | null;
  cook_time_unit: string;
  difficulty: string;
  macros_json: string;
  allergens_json: string;
  ingredients_json: string;
  steps_json: string;
};

type CookRecord = {
  id: number;
  cooked_at: string;
};

type ImportCandidate = {
  source: {
    site: string;
    url: string;
    id: string;
    retrievedAt: string;
  };
  recipe: {
    title: string;
    subtitle: string;
    description: string;
    duration: { from: number; to: number; unit: string } | null;
    difficulty: string;
    tags: string[];
    macros: { perServing: RecipeMacros };
    allergens: string[];
    ingredients: RecipeIngredient[];
    steps: Array<{ title: string; text: string }>;
    utensils: string[];
    images: Array<{ url: string; kind: string }>;
  };
};

type Flash = {
  kind: 'success' | 'error';
  message: string;
  url?: string;
};

const app = new Hono<{ Bindings: Env }>();

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] || character);

const recipePath = (recipe: RecipeSummary) => '/recipes/' + encodeURIComponent(recipe.id);

const recipeCard = (recipe: RecipeSummary) => [
  '<article class="card recipe-card">',
  recipe.image_url
    ? '<div class="meal-art"><img class="recipe-image" src="' + escapeHtml(recipe.image_url) + '" alt="" loading="lazy" decoding="async"></div>'
    : '<div class="meal-art butter" aria-hidden="true"><span>something good</span></div>',
  '<div class="recipe-body">',
  '<div class="row"><h2><a href="' + recipePath(recipe) + '">' + escapeHtml(recipe.title) + '</a></h2></div>',
  recipe.subtitle ? '<p class="recipe-subtitle">' + escapeHtml(recipe.subtitle) + '</p>' : '',
  '<p>' + escapeHtml(recipe.description) + '</p>',
  '<a class="button quiet" href="' + recipePath(recipe) + '">View recipe →</a>',
  '<div class="tags">' + parseJson<string[]>(recipe.tags_json, []).map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('') + '</div>',
  '</div>',
  '</article>'
].join('');

const parseJson = <T>(value: string, fallback: T) => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const formatIngredient = (ingredient: RecipeIngredient) => {
  if (!ingredient.name || ingredient.quantity == null || !ingredient.unit) return ingredient.text;
  const quantity = String(ingredient.quantity);
  const size = ingredient.size ? ({ XS: 'extra-small', S: 'small', M: 'medium', L: 'large', XL: 'extra-large', XXL: 'extra-extra-large' } as Record<string, string>)[ingredient.size] || ingredient.size : '';
  const unit = ingredient.unit === 'whole'
    ? ''
    : ingredient.unit === 'packet'
      ? (ingredient.quantity === 1 ? 'packet' : 'packets')
      : ingredient.unit === 'portion'
        ? (ingredient.quantity === 1 ? 'portion' : 'portions')
        : ingredient.unit;
  return [quantity, size, unit, ingredient.name].filter(Boolean).join(' ');
};

const formatCookedAt = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Melbourne' }).format(date);
};

const recipeDetailPage = (recipe: RecipeRow, cooks: CookRecord[]) => {
  const ingredients = parseJson<RecipeIngredient[]>(recipe.ingredients_json, []);
  const steps = parseJson<Array<{ title: string; text: string }>>(recipe.steps_json, []);
  const macros = parseJson<{ perServing: RecipeMacros }>(recipe.macros_json, { perServing: { kcal: null, protein: null, carbs: null, fat: null } });
  const storedAllergens = parseJson<string[]>(recipe.allergens_json, []);
  const tags = parseJson<string[]>(recipe.tags_json, []);
  const allergens = storedAllergens.length
    ? storedAllergens
    : [...new Set(ingredients.flatMap((ingredient) => ingredient.allergens))];
  const macroLine = (label: string, key: keyof RecipeMacros, unit: string) => {
    const value = macros.perServing[key];
    return value == null ? '' : '<div><span>' + label + '</span><strong>' + value + (unit ? ' ' + unit : '') + '</strong></div>';
  };
  const macroMarkup = [
    macroLine('kcal', 'kcal', ''),
    macroLine('protein', 'protein', 'g'),
    macroLine('carbs', 'carbs', 'g'),
    macroLine('fat', 'fat', 'g')
  ].filter(Boolean).join('') || '<div><span>—</span><strong>Not listed</strong></div>';
  const cookTime = recipe.cook_time_from == null
    ? 'Not listed'
    : recipe.cook_time_to == null
      ? recipe.cook_time_from + ' ' + recipe.cook_time_unit
      : recipe.cook_time_from + '–' + recipe.cook_time_to + ' ' + recipe.cook_time_unit;
  const difficulty = recipe.difficulty
    ? recipe.difficulty.toLowerCase().replace(/^./, (character) => character.toUpperCase())
    : 'Not listed';

  return [
    '<!doctype html>',
    '<html lang="en-AU">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="theme-color" content="#365f43"><meta name="description" content="' + escapeHtml(recipe.title) + '"><link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<title>' + escapeHtml(recipe.title) + ' — meals</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css">',
    '</head>',
    '<body>',
    '<a class="skip-link" href="#main">Skip to content</a>',
    '<div class="app-shell">',
    '<aside class="sidebar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">m.</span><span>meals<small>A little less chaos</small></span></a>',
    '<nav aria-label="Main navigation" class="nav-links"><a class="active" href="/"><span class="nav-icon" aria-hidden="true">▤</span> Recipes</a></nav>',
    '<div class="sidebar-note"><p>Good food.<br><span class="scribble">Less figuring it out.</span></p><small class="muted">Our household · Private by nature.</small></div></aside>',
    '<main id="main">',
    '<header class="topbar"><nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li>Our household</li><li><a href="/">Recipes</a></li><li>' + escapeHtml(recipe.title) + '</li></ol></nav><span class="avatar" aria-label="Our household">H</span></header>',
    '<section aria-labelledby="recipe-heading">',
    '<div class="section-heading"><div><p class="eyebrow">Recipe · ' + escapeHtml(recipe.source.replace('-', ' ')) + '</p><h1 id="recipe-heading">' + escapeHtml(recipe.title) + '</h1>' + (recipe.subtitle ? '<p class="recipe-subtitle">' + escapeHtml(recipe.subtitle) + '</p>' : '') + '<p class="muted spaced">' + escapeHtml(recipe.description) + '</p>' + (tags.length ? '<div class="tags">' + tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('') + '</div>' : '') + '</div><a class="button secondary" href="/">← All recipes</a></div>',
    '<div class="recipe-detail-grid">',
    '<div class="stack recipe-detail-main">',
    '<article class="card recipe-hero-card">',
    recipe.image_url
      ? '<img class="recipe-detail-image" src="' + escapeHtml(recipe.image_url) + '" alt="' + escapeHtml(recipe.title) + '" decoding="async">'
      : '<div class="meal-art butter" aria-hidden="true"><span>something good</span></div>',
    '</article>',
    '<article class="card recipe-steps-card"><div class="section-heading"><h2>Recipe</h2><span class="badge success">' + steps.length + ' steps</span></div>',
    steps.length
      ? '<ol class="instructions">' + steps.map((step) => '<li>' + (step.title ? '<strong>' + escapeHtml(step.title) + '</strong>' : '') + (step.text ? '<p>' + escapeHtml(step.text) + '</p>' : '') + '</li>').join('') + '</ol>'
      : '<p class="muted">Cooking steps haven’t been added to this recipe yet.</p>',
    '</article>',
    '</div>',
    '<div class="recipe-detail-card">',
    '<div class="card recipe-detail-panel">',
    '<h2>Details</h2>',
    '<div class="recipe-facts" aria-label="Recipe details">',
    '<p><span class="recipe-summary-label">Cook time</span><strong>' + escapeHtml(cookTime) + '</strong></p>',
    '<p><span class="recipe-summary-label">Difficulty</span><strong>' + escapeHtml(difficulty) + '</strong></p>',
    '<p><span class="recipe-summary-label">Allergens</span><strong>' + escapeHtml(allergens.length ? allergens.join(', ') : 'None listed') + '</strong></p>',
    '</div>',
    '</div>',
    '<div class="card recipe-detail-panel recipe-summary-macros">',
    '<h2>Macros</h2>',
    '<div class="recipe-macro-list">' + macroMarkup + '</div>',
    '</div>',
    '<div class="card recipe-detail-panel recipe-ingredients-section">',
    '<h2>Ingredients</h2>',
    ingredients.length
      ? '<ul class="recipe-ingredients">' + ingredients.map((ingredient, index) => '<li><label class="choice"><input type="checkbox" id="ingredient-' + (index + 1) + '"><span>' + escapeHtml(formatIngredient(ingredient)) + (ingredient.kind === 'assumed' ? '<small class="help">Pantry item</small>' : '') + (ingredient.allergens.length ? '<small class="help">Contains ' + escapeHtml(ingredient.allergens.join(', ')) + '</small>' : '') + '</span></label></li>').join('') + '</ul>'
      : '<p class="muted">Ingredients haven’t been added to this recipe yet.</p>',
    '</div>',
    '<section class="card recipe-detail-panel cook-history" aria-labelledby="cook-history-heading"><div class="section-heading"><h2 id="cook-history-heading">Recent Cooks</h2></div>',
    cooks.length
      ? '<ol class="cook-history-list">' + cooks.map((cook) => '<li class="cook-history-row"><time datetime="' + escapeHtml(cook.cooked_at) + '">' + escapeHtml(formatCookedAt(cook.cooked_at)) + '</time><form class="cook-history-remove" action="' + recipePath(recipe) + '/cooks/' + cook.id + '/delete" method="post"><button class="button quiet" type="submit" aria-label="Remove cook from ' + escapeHtml(formatCookedAt(cook.cooked_at)) + '">Remove</button></form></li>').join('') + '</ol>'
      : '<p class="muted">No cooks recorded yet.</p>',
    '</section>',
    '<form class="cook-action" action="' + recipePath(recipe) + '/cook" method="post"><button class="button" type="submit">I just cooked this!</button></form>',
    '</div>',
    '</div>',
    '</section>',
    '<footer>meals · local development</footer>',
    '</main></div></body></html>'
  ].join('');
};

const importForm = (flash?: Flash) => [
  '<form class="card stack import-panel" action="/" method="post">',
  '<div class="section-heading"><div><p class="eyebrow">Quick import</p><h2>Bring in a recipe</h2><p class="muted">Paste a recipe URL and we’ll add it to the box for review.</p></div></div>',
  '<div class="import-row"><div class="field"><label for="import-url">Recipe URL</label><input id="import-url" name="url" type="url" inputmode="url" autocomplete="url" placeholder="https://marleyspoon.com.au/menu/…" value="' + escapeHtml(flash?.url || '') + '" required></div><button class="button" type="submit">Import recipe ↗</button></div>',
  flash
    ? '<div class="notice ' + (flash.kind === 'error' ? 'warning' : '') + ' import-status" role="status" aria-live="polite">' + escapeHtml(flash.message) + '</div>'
    : '',
  '</form>'
].join('');

const page = (recipes: RecipeRow[], flash?: Flash) => [
  '<!doctype html>',
  '<html lang="en-AU">',
  '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="theme-color" content="#365f43"><meta name="description" content="A private household recipe box."><link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<title>Recipes — meals</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css">',
  '</head>',
  '<body>',
  '<a class="skip-link" href="#main">Skip to content</a>',
  '<div class="app-shell">',
  '<aside class="sidebar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">m.</span><span>meals<small>A little less chaos</small></span></a>',
  '<nav aria-label="Main navigation" class="nav-links"><a class="active" href="/"><span class="nav-icon" aria-hidden="true">▤</span> Recipes</a></nav>',
  '<div class="sidebar-note"><p>Good food.<br><span class="scribble">Less figuring it out.</span></p><small class="muted">Our household · Private by nature.</small></div></aside>',
  '<main id="main">',
  '<header class="topbar"><nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li>Our household</li><li>Recipes</li></ol></nav><span class="avatar" aria-label="Our household">H</span></header>',
  importForm(flash),
  '<section aria-labelledby="recipes-heading"><p class="eyebrow">The recipe box</p>',
  '<div class="section-heading"><div><h1 id="recipes-heading">Good things on repeat.</h1><p class="muted">Recipes ready for the table.</p></div>',
  '<span class="badge success">' + recipes.length + ' available</span></div>',
  recipes.length
    ? '<div class="recipe-grid" id="recipe-results">' + recipes.map(recipeCard).join('') + '</div>'
    : '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">⌕</span><h2>No recipes yet</h2><p>Import a recipe URL to get the first one in the box.</p></div>',
  '</section>',
  '<footer>meals · local development</footer>',
  '</main></div></body></html>'
].join('');

const listRecipes = async (db: D1Database) => {
  const { results } = await db.prepare(
    'SELECT id, source, source_url, title, subtitle, description, image_url, tags_json FROM recipes WHERE status = ? ORDER BY title COLLATE NOCASE'
  ).bind('ready').all<RecipeSummary>();
  return results;
};

const getRecipe = async (db: D1Database, id: string) => {
  const recipe = await db.prepare(
    'SELECT id, source, source_url, title, subtitle, description, image_url, cook_time_from, cook_time_to, cook_time_unit, difficulty, macros_json, allergens_json, tags_json, ingredients_json, steps_json FROM recipes WHERE id = ? AND status = ?'
  ).bind(id, 'ready').first<RecipeRow>();
  return recipe;
};

const listCooks = async (db: D1Database, recipeId: string) => {
  const { results } = await db.prepare(
    'SELECT id, cooked_at FROM recipe_cooks WHERE recipe_id = ? ORDER BY cooked_at DESC, id DESC LIMIT 5'
  ).bind(recipeId).all<CookRecord>();
  return results;
};

const importStatus = (candidate: ImportCandidate) =>
  candidate.recipe.title && candidate.recipe.ingredients.length && candidate.recipe.steps.length
    ? 'ready'
    : 'needs_review';

const copyImage = async (media: R2Bucket, sourceUrl: string, sourceSite: string, sourceId: string) => {
  const imageUrl = new URL(sourceUrl);
  if (imageUrl.protocol !== 'https:') throw new Error('The recipe image URL is not HTTPS.');
  const response = await fetch(imageUrl.toString(), {
    headers: { 'user-agent': 'meals/0.1 recipe image import' }
  });
  if (!response.ok || !response.body) throw new Error('The recipe image could not be fetched.');
  const contentType = (response.headers.get('content-type') || '').split(';')[0];
  if (!contentType.startsWith('image/')) throw new Error('The recipe image response was not an image.');

  const key = 'recipes/' + sourceSite + '/' + sourceId;
  await media.put(key, response.body, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable'
    },
    customMetadata: { sourceUrl: imageUrl.toString() }
  });
  return { key, url: '/media/' + key };
};

const saveRecipe = async (
  db: D1Database,
  candidate: ImportCandidate,
  imageUrl: string,
  sourceImageUrl: string
) => {
  const status = importStatus(candidate);
  const result = await db.prepare([
    'INSERT INTO recipes (id, source, source_id, source_url, title, subtitle, description, cook_time_from, cook_time_to, cook_time_unit, difficulty, macros_json, allergens_json, tags_json, image_url, source_image_url, ingredients_json, steps_json, status, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    'ON CONFLICT(id) DO UPDATE SET source_url = excluded.source_url, title = excluded.title, subtitle = excluded.subtitle, description = excluded.description, cook_time_from = excluded.cook_time_from, cook_time_to = excluded.cook_time_to, cook_time_unit = excluded.cook_time_unit, difficulty = excluded.difficulty, macros_json = excluded.macros_json, allergens_json = excluded.allergens_json, tags_json = excluded.tags_json, image_url = excluded.image_url, source_image_url = excluded.source_image_url, ingredients_json = excluded.ingredients_json, steps_json = excluded.steps_json, status = excluded.status, updated_at = CURRENT_TIMESTAMP'
  ].join(' ')).bind(
    candidate.source.site + ':' + candidate.source.id,
    candidate.source.site,
    candidate.source.id,
    candidate.source.url,
    candidate.recipe.title,
    candidate.recipe.subtitle,
    candidate.recipe.description,
    candidate.recipe.duration?.from ?? null,
    candidate.recipe.duration?.to ?? null,
    candidate.recipe.duration?.unit || 'minutes',
    candidate.recipe.difficulty,
    JSON.stringify(candidate.recipe.macros),
    JSON.stringify(candidate.recipe.allergens),
    JSON.stringify(candidate.recipe.tags),
    imageUrl,
    sourceImageUrl,
    JSON.stringify(candidate.recipe.ingredients),
    JSON.stringify(candidate.recipe.steps),
    status
  ).run();
  if (!result.success) throw new Error('The recipe could not be saved to D1.');
  return status;
};

app.get('/health', (c) => c.json({ ok: true }));

app.get('/media/*', async (c) => {
  const key = c.req.path.slice('/media/'.length);
  if (!/^recipes\/[a-z0-9-]+\/\d+$/.test(key)) return c.notFound();
  const object = await c.env.MEDIA.get(key);
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
});

app.get('/recipes/:recipeId', async (c) => {
  const recipeId = c.req.param('recipeId');
  if (!/^[a-z0-9-]+:\d+$/.test(recipeId)) return c.notFound();
  const recipe = await getRecipe(c.env.DB, recipeId);
  return recipe ? c.html(recipeDetailPage(recipe, await listCooks(c.env.DB, recipe.id))) : c.notFound();
});

app.post('/recipes/:recipeId/cook', async (c) => {
  const recipeId = c.req.param('recipeId');
  if (!/^[a-z0-9-]+:\d+$/.test(recipeId) || !(await getRecipe(c.env.DB, recipeId))) return c.notFound();
  const result = await c.env.DB.prepare(
    'INSERT INTO recipe_cooks (recipe_id, cooked_at) VALUES (?, ?)'
  ).bind(recipeId, new Date().toISOString()).run();
  if (!result.success) return c.text('The cook could not be recorded.', 500);
  return c.redirect('/recipes/' + encodeURIComponent(recipeId), 303);
});

app.post('/recipes/:recipeId/cooks/:cookId/delete', async (c) => {
  const recipeId = c.req.param('recipeId');
  const cookId = c.req.param('cookId');
  if (!/^[a-z0-9-]+:\d+$/.test(recipeId) || !/^\d+$/.test(cookId) || !(await getRecipe(c.env.DB, recipeId))) return c.notFound();
  const result = await c.env.DB.prepare(
    'DELETE FROM recipe_cooks WHERE id = ? AND recipe_id = ?'
  ).bind(cookId, recipeId).run();
  if (!result.success) return c.text('The cook could not be removed.', 500);
  return c.redirect('/recipes/' + encodeURIComponent(recipeId), 303);
});

app.get('/', async (c) => {
  const flash = c.req.query('imported')
    ? {
        kind: 'success' as const,
        message: c.req.query('status') === 'needs_review'
          ? 'Recipe imported and saved for review.'
          : 'Recipe imported and added to your box.'
      }
    : undefined;
  return c.html(page(await listRecipes(c.env.DB), flash));
});

app.post('/', async (c) => {
  const body = await c.req.parseBody();
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) {
    return c.html(page(await listRecipes(c.env.DB), {
      kind: 'error',
      message: 'Paste a recipe URL first.',
      url: rawUrl
    }), 400);
  }

  let parsed;
  try {
    parsed = parseRecipeUrl(rawUrl);
  } catch (error) {
    return c.html(page(await listRecipes(c.env.DB), {
      kind: 'error',
      message: error instanceof Error ? error.message : 'That recipe URL is not supported.',
      url: rawUrl
    }), 400);
  }

  let candidate: ImportCandidate;
  try {
    candidate = await extractRecipe(parsed.url) as ImportCandidate;
  } catch (error) {
    return c.html(page(await listRecipes(c.env.DB), {
      kind: 'error',
      message: error instanceof Error ? error.message : 'The recipe could not be imported.',
      url: rawUrl
    }), 502);
  }

  const sourceImageUrl = candidate.recipe.images[0]?.url || '';
  let imageKey = '';
  try {
    const image = sourceImageUrl
      ? await copyImage(c.env.MEDIA, sourceImageUrl, candidate.source.site, candidate.source.id)
      : { key: '', url: '' };
    imageKey = image.key;
    const status = await saveRecipe(c.env.DB, candidate, image.url, sourceImageUrl);
    return c.redirect('/?imported=1&status=' + status, 303);
  } catch (error) {
    if (imageKey) await c.env.MEDIA.delete(imageKey);
    return c.html(page(await listRecipes(c.env.DB), {
      kind: 'error',
      message: error instanceof Error ? error.message : 'The recipe could not be saved.',
      url: rawUrl
    }), 502);
  }
});

app.onError((error, c) => {
  console.error('request failed', error);
  return c.text('Something went wrong.', 500);
});

export default app;
