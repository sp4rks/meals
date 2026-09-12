import { validateSmashInput, validateSmashRecipe, type SmashRecipe } from './train-smash';
import { MAX_BROWSER_MESSAGE_BYTES, MAX_INTERNAL_MESSAGE_BYTES, isUuid, parseBrowserCommand, parseOriginMessage, parseSnapshot, publicMessage, validateRevisionHistory, validateStoredSmashInput, type BrowserCommand, type OriginCommand, type OriginSnapshot, type StoredSmashInput } from './train-smash-protocol';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
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
  source_image_url: string;
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

type IngredientRow = {
  id: number;
  name: string;
  category: string | null;
  default_unit: string | null;
  woolworths_url: string;
  purchase_quantity: number | null;
  purchase_unit: string | null;
  storage_location: 'pantry' | 'refrigerator' | 'freezer' | null;
  storage_notes: string;
  enrichment_status: 'pending' | 'complete' | 'needs_review' | 'failed';
  enrichment_notes: string;
  enriched_at: string | null;
  review_feedback: string;
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

type UserRole = 'kid' | 'parent';

type AuthUser = {
  id: number;
  name: string;
  role: UserRole;
};

type AppEnv = {
  Bindings: Env & { TRAIN_SMASH_URL?: string; TRAIN_SMASH_TOKEN?: string; CF_ACCESS_CLIENT_ID?: string; CF_ACCESS_CLIENT_SECRET?: string };
  Variables: { user: AuthUser | null };
};

const app = new Hono<AppEnv>();

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] || character);

const recipePath = (recipe: RecipeSummary) => '/recipes/' + encodeURIComponent(recipe.id);
const recipeImageSearchUrl = (title: string) => 'https://www.google.com/search?' + new URLSearchParams({ q: title }).toString();
const validRecipeId = (value: string) => /^[a-z0-9-]+:[a-z0-9._-]+$/i.test(value);

const normalizeIngredientName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const formString = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const bytesEqual = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
};

const hashPassword = async (password: string) => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100_000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return 'pbkdf2$' + iterations + '$' + bytesToBase64(salt) + '$' + bytesToBase64(new Uint8Array(bits));
};

const verifyPassword = async (password: string, stored: string) => {
  const [algorithm, rawIterations, rawSalt, rawHash] = stored.split('$');
  const iterations = Number(rawIterations);
  if (algorithm !== 'pbkdf2' || !Number.isInteger(iterations) || iterations < 1 || !rawSalt || !rawHash) return false;
  try {
    const salt = base64ToBytes(rawSalt);
    const expected = base64ToBytes(rawHash);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, expected.length * 8);
    return bytesEqual(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
};

const hashToken = async (token: string) => bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));

const newToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const validUserName = (value: string) => value.length >= 1 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
const validPassword = (value: string) => value.length >= 8 && value.length <= 200;
const userRole = (value: unknown): UserRole | null => value === 'kid' || value === 'parent' ? value : null;

const sessionCookie = (requestUrl: string, token: string, maxAge = 60 * 60 * 24 * 30) => {
  const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : '';
  return 'session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure;
};

const requestSessionToken = (request: Request) => {
  const cookie = request.headers.get('Cookie') || '';
  return cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('session='))?.slice('session='.length) || '';
};

const userCount = async (db: D1Database) => (await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>())?.count || 0;

const currentUser = async (request: Request, db: D1Database) => {
  const token = requestSessionToken(request);
  if (!token) return null;
  return db.prepare([
    'SELECT users.id, users.name, users.role FROM sessions JOIN users ON users.id = sessions.user_id',
    'WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP'
  ].join(' ')).bind(await hashToken(token)).first<AuthUser>();
};

const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) return c.redirect('/login?next=' + encodeURIComponent(new URL(c.req.url).pathname), 303);
  await next();
};

const requireParent: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) return c.redirect('/login?next=' + encodeURIComponent(new URL(c.req.url).pathname), 303);
  if (user.role !== 'parent') return c.text('Parents only.', 403);
  await next();
};

app.use('*', async (c, next) => {
  c.set('user', await currentUser(c.req.raw, c.env.DB));
  await next();
});

const sidebar = (user: AuthUser, active: 'recipes' | 'ingredients' | 'train-smash' = 'recipes') => [
  '<aside class="sidebar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">m.</span><span>meals<small>A little less chaos</small></span></a>',
  '<nav aria-label="Main navigation" class="nav-links"><a class="' + (active === 'recipes' ? 'active' : '') + '" href="/"><span class="nav-icon" aria-hidden="true">📃</span> Recipes</a><a class="' + (active === 'ingredients' ? 'active' : '') + '" href="/ingredients"><span class="nav-icon" aria-hidden="true">🥕</span> Ingredients</a><a class="' + (active === 'train-smash' ? 'active' : '') + '" href="/train-smash"><span class="nav-icon" aria-hidden="true">🚂</span> Train Smash</a></nav>',
  '<div class="sidebar-note"><p>Good food.<br><span class="scribble">Less figuring it out.</span></p></div>',
  '<details class="sidebar-account"><summary class="sidebar-user"><span class="avatar" aria-hidden="true">' + escapeHtml(user.name.slice(0, 1).toUpperCase()) + '</span><span class="sidebar-user-copy"><strong>' + escapeHtml(user.name) + '</strong><small>' + escapeHtml(user.role === 'parent' ? 'Parent · Settings' : 'Kid · Settings') + '</small></span><span aria-hidden="true">⚙</span></summary><div class="sidebar-menu"><a class="button quiet sidebar-settings" href="/settings">Settings</a><form action="/logout" method="post"><button class="button quiet sidebar-signout" type="submit">Sign out</button></form></div></details></aside>'
].join('');

const loginPage = (setup: boolean, error = '', next = '/') => [
  '<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="theme-color" content="#365f43"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>' + (setup ? 'Set up meals' : 'Log in') + ' — meals</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css"></head>',
  '<body><main class="auth-page"><div class="auth-card card"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">m.</span><span>meals<small>A little less chaos</small></span></a><p class="eyebrow">' + (setup ? 'First things first' : 'Welcome back') + '</p><h1>' + (setup ? 'Set up your household.' : 'Log in to meals.') + '</h1><p class="muted">' + (setup ? 'Create the first parent account to get started.' : 'Your shared recipe box is just inside.') + '</p>',
  error ? '<div class="notice warning" role="alert">' + escapeHtml(error) + '</div>' : '',
  '<form class="stack spaced" action="' + (setup ? '/setup' : '/login') + '" method="post">' + (setup ? '' : '<input type="hidden" name="next" value="' + escapeHtml(next) + '">') + '<div class="field"><label for="login-name">Name</label><input id="login-name" name="name" autocomplete="username" required maxlength="80"></div><div class="field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required minlength="8"></div><button class="button" type="submit">' + (setup ? 'Create parent account' : 'Log in') + '</button></form>',
  '</div></main></body></html>'
].join('');

const settingsPage = (user: AuthUser, error = '', success = '', userError = '') => [
  '<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="theme-color" content="#365f43"><meta name="description" content="Account settings."><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Settings — meals</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css"></head>',
  '<body><a class="skip-link" href="#main">Skip to content</a><div class="app-shell">',
  sidebar(user),
  '<main id="main"><header class="topbar"><nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li>Our household</li><li>Settings</li></ol></nav><span class="avatar" aria-label="' + escapeHtml(user.name) + '">' + escapeHtml(user.name.slice(0, 1).toUpperCase()) + '</span></header>',
  '<section aria-labelledby="settings-heading"><p class="eyebrow">Your account</p><div class="section-heading"><div><h1 id="settings-heading">Make it yours.</h1><p class="muted">Update your name or password.</p></div></div>',
  error ? '<div class="notice warning" role="alert">' + escapeHtml(error) + '</div>' : '',
  success ? '<div class="notice" role="status">' + escapeHtml(success) + '</div>' : '',
  '<form class="card stack settings-form" action="/settings" method="post"><div class="field"><label for="settings-name">Name</label><input id="settings-name" name="name" maxlength="80" value="' + escapeHtml(user.name) + '" required autocomplete="username"></div><fieldset class="stack"><legend>Change password</legend><p class="help">Leave these blank if you only want to change your name.</p><div class="field"><label for="current-password">Current password</label><input id="current-password" name="current_password" type="password" autocomplete="current-password"></div><div class="field"><label for="new-password">New password</label><input id="new-password" name="new_password" type="password" minlength="8" autocomplete="new-password"></div><div class="field"><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirm_password" type="password" minlength="8" autocomplete="new-password"></div></fieldset><div class="actions"><a class="button secondary" href="/">Cancel</a><button class="button" type="submit">Save changes</button></div></form></section>',
  user.role === 'parent' ? '<section class="settings-form spaced" aria-labelledby="new-user-heading"><p class="eyebrow">Household access</p><div class="section-heading"><div><h2 id="new-user-heading">Add someone to meals.</h2><p class="muted">Create another adult or kid account.</p></div></div>' + (userError ? '<div class="notice warning" role="alert">' + escapeHtml(userError) + '</div>' : '') + '<form class="card stack" action="/users" method="post"><div class="field"><label for="new-user-name">Name</label><input id="new-user-name" name="name" maxlength="80" required autocomplete="username"></div><div class="field"><label for="new-user-role">Role</label><select id="new-user-role" name="role" required><option value="kid">Kid</option><option value="parent">Adult</option></select></div><div class="field"><label for="new-user-password">Password</label><input id="new-user-password" name="password" type="password" minlength="8" maxlength="200" required autocomplete="new-password"></div><button class="button" type="submit">Create user</button></form></section>' : '',
  '<footer>meals.chaos.haus · © ' + new Date().getFullYear() + '</footer></main></div></body></html>'
].join('');

const reviewStorage = (value: unknown) => value === 'pantry' || value === 'refrigerator' || value === 'freezer' ? value : null;

const purchaseUnits = ['g', 'kg', 'mL', 'L', 'each', 'bunch', 'packet', 'tin', 'jar', 'bottle'] as const;

const reviewPurchaseUnit = (value: unknown) => purchaseUnits.includes(value as typeof purchaseUnits[number]) ? value as typeof purchaseUnits[number] : null;

const woolworthsUrl = (value: unknown) => {
  const raw = formString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'www.woolworths.com.au' || !/^\/shop\/productdetails\/\d+(?:\/[^/]*)?$/.test(url.pathname)) return null;
    return 'https://www.woolworths.com.au' + url.pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
};

const purchaseQuantity = (value: unknown) => {
  const raw = formString(value);
  if (!raw) return null;
  const quantity = Number(raw);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
};

const reviewStatus = (value: unknown): IngredientRow['enrichment_status'] | null => value === 'pending' || value === 'complete' || value === 'needs_review' || value === 'failed' ? value : null;

const formatEnrichmentStatus = (value: IngredientRow['enrichment_status']) => ({
  pending: ['Pending', 'warning'],
  complete: ['Complete', 'success'],
  needs_review: ['Needs review', 'warning'],
  failed: ['Failed', 'error']
} as const)[value] || ['Unknown', 'warning'];

const ingredientTriggerData = (ingredient: IngredientRow) =>
  ' data-ingredient-review data-id="' + ingredient.id + '" data-status="' + ingredient.enrichment_status + '" data-name="' + escapeHtml(ingredient.name) + '" data-category="' + escapeHtml(ingredient.category || '') + '" data-unit="' + escapeHtml(ingredient.default_unit || '') + '" data-woolworths-url="' + escapeHtml(ingredient.woolworths_url) + '" data-purchase-quantity="' + (ingredient.purchase_quantity == null ? '' : ingredient.purchase_quantity) + '" data-purchase-unit="' + escapeHtml(ingredient.purchase_unit || '') + '" data-storage-location="' + escapeHtml(ingredient.storage_location || '') + '" data-storage-notes="' + escapeHtml(ingredient.storage_notes) + '" data-review-feedback="' + escapeHtml(ingredient.review_feedback) + '" data-question="' + escapeHtml(ingredient.enrichment_notes) + '"';

const formatPurchase = (ingredient: IngredientRow) => ingredient.purchase_quantity == null || !ingredient.purchase_unit
  ? '—'
  : ingredient.purchase_quantity + ' ' + ingredient.purchase_unit;

const ingredientTable = (ingredients: IngredientRow[], editable: boolean) => ingredients.length
  ? '<div class="card"><div class="table-wrap"><table><caption class="sr-only">Ingredient catalogue</caption><thead><tr><th scope="col">Name</th><th scope="col">Category</th><th scope="col">Unit</th><th scope="col">Purchase</th><th scope="col">Woolworths</th><th scope="col">Storage</th><th scope="col">Enrichment</th>' + (editable ? '<th scope="col">Actions</th>' : '') + '</tr></thead><tbody>' + ingredients.map((ingredient) => {
      const [status, badge] = formatEnrichmentStatus(ingredient.enrichment_status);
      const enrichment = editable && ingredient.enrichment_status === 'needs_review'
        ? '<button class="ingredient-review-trigger help" type="button"' + ingredientTriggerData(ingredient) + '>' + escapeHtml(ingredient.enrichment_notes || 'Review ingredient') + '</button>'
        : '<span class="badge ' + badge + '">' + status + '</span>';
      const product = ingredient.woolworths_url
        ? '<a href="' + escapeHtml(ingredient.woolworths_url) + '">Open product</a>'
        : '—';
      const edit = editable ? '<td class="ingredient-table-actions" data-label="Actions"><button class="button quiet" type="button"' + ingredientTriggerData(ingredient) + ' aria-label="Edit ' + escapeHtml(ingredient.name) + '">Edit</button></td>' : '';
      return '<tr><td data-label="Name"><strong>' + escapeHtml(ingredient.name) + '</strong></td><td data-label="Category">' + escapeHtml(ingredient.category || '—') + '</td><td data-label="Unit">' + escapeHtml(ingredient.default_unit || '—') + '</td><td data-label="Purchase">' + escapeHtml(formatPurchase(ingredient)) + '</td><td data-label="Woolworths">' + product + '</td><td data-label="Storage">' + escapeHtml(ingredient.storage_location || '—') + '</td><td data-label="Enrichment">' + enrichment + '</td>' + edit + '</tr>';
    }).join('') + '</tbody></table></div></div>'
  : '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">⌁</span><h2>No ingredients yet</h2><p>Ingredients will appear here when recipes are imported.</p></div>';

const recipeCard = (recipe: RecipeSummary, editable = true) => [
  '<article class="card recipe-card">',
  '<div class="recipe-card-hero">',
  recipe.image_url
    ? '<a class="recipe-card-image-link" href="' + recipePath(recipe) + '" aria-label="Open ' + escapeHtml(recipe.title) + '"><div class="meal-art"><img class="recipe-image" src="' + escapeHtml(recipe.image_url) + '" alt="" loading="lazy" decoding="async"></div></a>'
    : '<div class="meal-art butter recipe-image-placeholder"><a class="recipe-card-image-link" href="' + escapeHtml(recipeImageSearchUrl(recipe.title)) + '" target="_blank" rel="noopener noreferrer" aria-label="Search for images of ' + escapeHtml(recipe.title) + '"><span>something good</span></a>' + (editable ? '<a class="button secondary recipe-image-add" href="' + recipePath(recipe) + '" data-image-search-url="' + escapeHtml(recipeImageSearchUrl(recipe.title)) + '" aria-label="Add an image to ' + escapeHtml(recipe.title) + '">Add Image</a>' : '') + '</div>',
  '</div>',
  '<div class="recipe-body">',
  '<div class="row"><h2><a href="' + recipePath(recipe) + '">' + escapeHtml(recipe.title) + '</a></h2></div>',
  recipe.subtitle ? '<p class="recipe-subtitle">' + escapeHtml(recipe.subtitle) + '</p>' : '',
  '<p class="recipe-description">' + escapeHtml(recipe.description) + '</p>',
  '<a class="button quiet" href="' + recipePath(recipe) + '">View recipe →</a>',
  '<div class="tags">' + parseJson<string[]>(recipe.tags_json, []).map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('') + '</div>',
  '</div>',
  '</article>'
].join('');

const recipeEditDialog = (recipe: RecipeRow, open = false) => '<dialog class="recipe-edit-dialog" id="recipe-edit-dialog"' + (open ? ' open' : '') + '><form class="card stack" action="' + recipePath(recipe) + '/edit" method="post"><div class="section-heading"><h2>Edit recipe</h2><button class="button quiet icon" type="button" data-close-recipe-edit>×</button></div><div class="field"><label for="recipe-title">Name</label><input id="recipe-title" name="title" required value="' + escapeHtml(recipe.title) + '"></div><div class="field"><label for="recipe-subtitle">Subtitle</label><input id="recipe-subtitle" name="subtitle" value="' + escapeHtml(recipe.subtitle) + '"></div><div class="field"><label for="recipe-description">Description</label><textarea id="recipe-description" name="description" rows="3">' + escapeHtml(recipe.description) + '</textarea></div><div class="field image-edit"><label>Image URL</label><div class="recipe-edit-image"><a class="recipe-edit-image-link" href="' + escapeHtml(recipeImageSearchUrl(recipe.title)) + '" target="_blank" rel="noopener noreferrer" aria-label="Search for images of ' + escapeHtml(recipe.title) + '">' + (recipe.image_url ? '<img src="' + escapeHtml(recipe.image_url) + '" alt="' + escapeHtml(recipe.title) + '">' : '<span>No image</span>') + '</a><button class="button secondary" type="button" data-replace-image>' + (recipe.image_url ? 'Replace image' : 'Add Image') + '</button></div><input id="recipe-image-url" name="image_url" type="url" value="' + escapeHtml(recipe.source_image_url || '') + '" placeholder="https://…"><p class="help">Use an HTTPS image URL.</p></div><div class="actions"><button class="button secondary" type="button" data-close-recipe-edit>Cancel</button><button class="button" type="submit">Save changes</button><button class="button danger" type="submit" formaction="' + recipePath(recipe) + '/delete" formmethod="post" formnovalidate data-delete-recipe>Delete recipe</button></div></form></dialog>';

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

const recipeDetailPage = (recipe: RecipeRow, cooks: CookRecord[], user: AuthUser, error = '') => {
  const canEdit = user.role === 'parent';
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
    sidebar(user),
    '<main id="main">',
    '<header class="topbar"><nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li>Our household</li><li><a href="/">Recipes</a></li><li>' + escapeHtml(recipe.title) + '</li></ol></nav><span class="avatar" aria-label="Our household">H</span></header>',
    '<section aria-labelledby="recipe-heading">',
    error ? '<div class="notice warning" role="alert">' + escapeHtml(error) + '</div>' : '',
    '<div class="section-heading"><div><p class="eyebrow">Recipe · ' + escapeHtml(recipe.source.replace('-', ' ')) + '</p><h1 id="recipe-heading">' + escapeHtml(recipe.title) + '</h1>' + (recipe.subtitle ? '<p class="recipe-subtitle">' + escapeHtml(recipe.subtitle) + '</p>' : '') + '<p class="muted spaced">' + escapeHtml(recipe.description) + '</p>' + (tags.length ? '<div class="tags">' + tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('') + '</div>' : '') + '</div><div class="actions recipe-page-actions">' + (canEdit ? '<button class="button secondary" type="button" data-open-recipe-edit>Edit</button>' : '') + '<a class="button secondary" href="/">← All recipes</a></div></div>',
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
      ? '<ol class="cook-history-list">' + cooks.map((cook) => '<li class="cook-history-row"><time datetime="' + escapeHtml(cook.cooked_at) + '">' + escapeHtml(formatCookedAt(cook.cooked_at)) + '</time>' + (canEdit ? '<form class="cook-history-remove" action="' + recipePath(recipe) + '/cooks/' + cook.id + '/delete" method="post"><button class="button quiet" type="submit" aria-label="Remove cook from ' + escapeHtml(formatCookedAt(cook.cooked_at)) + '">Remove</button></form>' : '') + '</li>').join('') + '</ol>'
      : '<p class="muted">No cooks recorded yet.</p>',
    '</section>',
    canEdit ? '<form class="cook-action" action="' + recipePath(recipe) + '/cook" method="post"><button class="button" type="submit">I just cooked this!</button></form>' : '',
    '</div>',
    '</div>',
    '</section>',
    canEdit ? recipeEditDialog(recipe, Boolean(error)) : '',
    '<script>const recipeEditDialogElement = document.getElementById("recipe-edit-dialog"); document.querySelector("[data-open-recipe-edit]")?.addEventListener("click", () => recipeEditDialogElement?.showModal()); document.querySelectorAll("[data-close-recipe-edit]").forEach((button) => button.addEventListener("click", () => recipeEditDialogElement?.close())); const imageUrl = document.getElementById("recipe-image-url"); document.querySelector("[data-replace-image]")?.addEventListener("click", () => { const value = window.prompt("HTTPS image URL", imageUrl?.value || ""); if (value !== null && imageUrl) imageUrl.value = value.trim(); }); recipeEditDialogElement?.querySelector("form")?.addEventListener("submit", (event) => { if (event.submitter instanceof HTMLButtonElement && event.submitter.hasAttribute("data-delete-recipe") && !window.confirm("Delete this recipe? This cannot be undone.")) event.preventDefault(); });</script>',
    '<footer>meals.chaos.haus · © ' + new Date().getFullYear() + '</footer>',
    '</main></div></body></html>'
  ].join('');
};

const importDialog = (flash?: Flash) => [
  '<dialog class="import-dialog" id="import-dialog" aria-labelledby="import-heading"' + (flash?.kind === 'error' ? ' open' : '') + '>',
  '<form class="card stack" action="/" method="post">',
  '<div class="section-heading"><div><p class="eyebrow">Import</p><h2 id="import-heading">Bring in a recipe</h2><p class="muted">Paste a recipe URL and we’ll add it to the box for review.</p></div><button class="button quiet icon" type="button" data-close-import aria-label="Close import dialog">×</button></div>',
  '<div class="field"><label for="import-url">Recipe URL</label><input id="import-url" name="url" type="url" inputmode="url" autocomplete="url" placeholder="https://marleyspoon.com.au/menu/…" value="' + escapeHtml(flash?.url || '') + '" required></div>',
  '<div class="actions"><button class="button secondary" type="button" data-close-import>Cancel</button><button class="button" type="submit">Import recipe ↗</button></div>',
  flash?.kind === 'error'
    ? '<div class="notice warning import-status" role="status" aria-live="polite">' + escapeHtml(flash.message) + '</div>'
    : '',
  '</form>',
  '</dialog>'
].join('');

const page = (recipes: RecipeRow[], user: AuthUser, flash?: Flash) => [
  '<!doctype html>',
  '<html lang="en-AU">',
  '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="theme-color" content="#365f43"><meta name="description" content="A private household recipe box."><link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<title>Recipes — meals</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css">',
  '</head>',
  '<body>',
  '<a class="skip-link" href="#main">Skip to content</a>',
  '<div class="app-shell">',
  sidebar(user),
  '<main id="main">',
  '<header class="topbar"><nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li>Our household</li><li>Recipes</li></ol></nav><label class="mode-toggle toggle"><span>Adult</span><input type="checkbox" role="switch" data-kid-mode aria-controls="recipe-results" aria-label="Kid mode"><span>Kid</span></label></header>',
  flash?.kind === 'success'
    ? '<div class="toast import-status" role="status" aria-live="polite">' + escapeHtml(flash.message) + '</div>'
    : '',
  '<section aria-labelledby="recipes-heading"><p class="eyebrow">The recipe box</p>',
  '<div class="section-heading"><div><h1 id="recipes-heading">Good things on repeat.</h1><p class="muted">Recipes ready for the table.</p></div>',
  user.role === 'parent' ? '<div class="actions"><button class="button" type="button" data-open-import aria-haspopup="dialog">Import</button></div>' : '', '</div>',
  recipes.length
    ? '<div class="recipe-grid" id="recipe-results">' + recipes.map((recipe) => recipeCard(recipe, user.role === 'parent')).join('') + '</div>'
    : '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">⌕</span><h2>No recipes yet</h2><p>Import a recipe URL to get the first one in the box.</p></div>',
  '</section>',
  user.role === 'parent' ? importDialog(flash) : '',
  '<script>',
  'const importDialog = document.getElementById("import-dialog");',
  'document.querySelector("[data-open-import]")?.addEventListener("click", () => importDialog?.showModal());',
  'document.querySelectorAll("[data-close-import]").forEach((button) => button.addEventListener("click", () => importDialog?.close()));',
  'const importForm = document.querySelector(".import-dialog form");',
  'const importSubmit = importForm?.querySelector("button[type=submit]");',
  'importForm?.addEventListener("submit", () => { importForm.setAttribute("aria-busy", "true"); if (importSubmit instanceof HTMLButtonElement) { importSubmit.disabled = true; importSubmit.classList.add("is-loading"); importSubmit.textContent = "Importing…"; } });',
  'window.addEventListener("pageshow", () => { importForm?.removeAttribute("aria-busy"); if (importSubmit instanceof HTMLButtonElement) { importSubmit.disabled = false; importSubmit.classList.remove("is-loading"); importSubmit.textContent = "Import recipe ↗"; } });',
  'const importToast = document.querySelector(".toast.import-status");',
  'if (importToast) window.setTimeout(() => importToast.remove(), 4000);',
  'document.querySelectorAll("[data-image-add]").forEach((link) => link.addEventListener("click", () => { if (link instanceof HTMLAnchorElement && link.dataset.imageSearchUrl) window.open(link.dataset.imageSearchUrl, "_blank", "noopener,noreferrer"); }));',
  'const randomizeUnderline = (element) => { const randomRadius = () => `${8 + Math.random() * 72}%`; const randomDirection = () => Math.random() < .5 ? -1 : 1; element.style.setProperty("--scribble-left-radius", randomRadius()); element.style.setProperty("--scribble-right-radius", randomRadius()); element.style.setProperty("--scribble-left-direction", randomDirection()); element.style.setProperty("--scribble-right-direction", randomDirection()); };',
  'document.querySelectorAll("h1, .scribble").forEach(randomizeUnderline);',
  'const recipeCards = [...document.querySelectorAll(".recipe-card")];',
  'const randomTilt = (range) => Math.random() * range * 2 - range;',
  'const setCardTilt = (card, degrees) => { card.style.setProperty("--recipe-base-tilt", `${degrees}deg`); card.style.setProperty("--recipe-tilt", `${degrees}deg`); };',
  'let kidMode = false;',
  'recipeCards.forEach((card) => { card.addEventListener("mouseenter", () => { if (!kidMode) return; const base = Number.parseFloat(card.style.getPropertyValue("--recipe-base-tilt")) || 0; card.style.setProperty("--recipe-tilt", `${base + randomTilt(7)}deg`); }); card.addEventListener("mouseleave", () => card.style.setProperty("--recipe-tilt", card.style.getPropertyValue("--recipe-base-tilt") || "0deg")); });',
  'const kidSwitch = document.querySelector("[data-kid-mode]");',
  'kidSwitch?.addEventListener("change", () => { kidMode = kidSwitch.checked; const positions = new Map(recipeCards.map((card) => [card, card.getBoundingClientRect()])); const order = kidMode ? [...recipeCards].sort(() => Math.random() - .5) : recipeCards; if (kidMode && order.length > 1 && order.every((card, index) => card === recipeCards[index])) order.push(order.shift()); order.forEach((card) => card.parentElement?.append(card)); recipeCards.forEach((card) => { const before = positions.get(card); const after = card.getBoundingClientRect(); card.classList.remove("is-mixing", "is-straightening"); card.style.setProperty("--mix-start-x", `${before.left - after.left}px`); card.style.setProperty("--mix-start-y", `${before.top - after.top}px`); if (kidMode) { for (let step = 1; step <= 4; step++) { const suffix = step === 1 ? "" : `-${step}`; card.style.setProperty(`--mix-x${suffix}`, `${randomTilt(180)}px`); card.style.setProperty(`--mix-y${suffix}`, `${randomTilt(140)}px`); card.style.setProperty(`--mix-turn${suffix}`, `${randomTilt(540)}deg`); } setCardTilt(card, randomTilt(15)); card.classList.add("is-mixing"); } else { card.style.setProperty("--recipe-start-tilt", card.style.getPropertyValue("--recipe-tilt") || "0deg"); setCardTilt(card, 0); card.classList.add("is-straightening"); } card.addEventListener("animationend", () => card.classList.remove("is-mixing", "is-straightening"), { once: true }); }); });',
  '</script>',
  '<footer>meals.chaos.haus · © ' + new Date().getFullYear() + '</footer>',
  '</main></div></body></html>'
].join('');

const listRecipes = async (db: D1Database) => {
  const { results } = await db.prepare(
    'SELECT id, source, source_url, title, subtitle, description, image_url, tags_json FROM recipes WHERE status = ? ORDER BY title COLLATE NOCASE'
  ).bind('ready').all<RecipeSummary>();
  return results;
};

const ingredientReviewDialog = () => [
  '<dialog class="ingredient-review-dialog" id="ingredient-review-dialog" aria-labelledby="ingredient-review-heading" aria-describedby="ingredient-review-question">',
  '<form class="card stack" method="post">',
  '<div class="section-heading"><div><p class="eyebrow" data-ingredient-review-eyebrow>Needs review</p><h2 id="ingredient-review-heading">Review ingredient</h2><p class="muted" id="ingredient-review-question"></p></div><button class="button quiet icon" type="button" data-close-ingredient-review aria-label="Close ingredient review">×</button></div>',
  '<div class="form-grid">',
  '<div class="field full"><label for="ingredient-review-name">Name</label><input id="ingredient-review-name" name="name" required></div>',
  '<div class="field"><label for="ingredient-review-category">Category</label><select id="ingredient-review-category" name="category"><option value="">Unknown</option><option>fruit</option><option>vegetable</option><option>meat</option><option>poultry</option><option>fish</option><option>seafood</option><option>dairy</option><option>egg</option><option>grain</option><option>herb</option><option>spice</option><option>staple</option><option>condiment</option><option>prepared</option></select></div>',
  '<div class="field"><label for="ingredient-review-unit">Unit</label><select id="ingredient-review-unit" name="default_unit"><option value="">Unknown</option><option>g</option><option>kg</option><option>mL</option><option>L</option><option>whole</option><option>bunch</option><option>packet</option><option>cube</option></select></div>',
  '<div class="field full"><label for="ingredient-review-woolworths-url">Woolworths product URL</label><input id="ingredient-review-woolworths-url" name="woolworths_url" type="url" placeholder="https://www.woolworths.com.au/shop/productdetails/…"></div>',
  '<div class="field"><label for="ingredient-review-purchase-quantity">Purchase amount</label><input id="ingredient-review-purchase-quantity" name="purchase_quantity" type="number" min="0" step="any" placeholder="1"></div>',
  '<div class="field"><label for="ingredient-review-purchase-unit">Purchase unit</label><select id="ingredient-review-purchase-unit" name="purchase_unit"><option value="">Unknown</option><option>g</option><option>kg</option><option>mL</option><option>L</option><option>each</option><option>bunch</option><option>packet</option><option>tin</option><option>jar</option><option>bottle</option></select></div>',
  '<div class="field"><label for="ingredient-review-storage-location">Storage</label><select id="ingredient-review-storage-location" name="storage_location"><option value="">Unknown</option><option value="pantry">Pantry</option><option value="refrigerator">Refrigerator</option><option value="freezer">Freezer</option></select></div>',
  '<div class="field"><label for="ingredient-review-status">Status</label><select id="ingredient-review-status" name="status" required><option value="pending">Pending</option><option value="complete">Complete</option><option value="needs_review">Needs review</option><option value="failed">Failed</option></select></div>',
  '<div class="field full"><label for="ingredient-review-storage-notes">Storage notes</label><textarea id="ingredient-review-storage-notes" name="storage_notes" rows="2" placeholder="Optional details, such as refrigerate after opening"></textarea></div>',
  '<div class="field full"><label for="ingredient-review-feedback">Feedback</label><textarea id="ingredient-review-feedback" name="review_feedback" rows="3" placeholder="What should the catalogue or AI know?"></textarea></div>',
  '</div>',
  '<div class="actions"><button class="button secondary" type="button" data-close-ingredient-review>Cancel</button><button class="button" type="submit" data-ingredient-review-submit>Save</button><button class="button danger" type="submit" formnovalidate data-delete-ingredient>Delete</button></div>',
  '</form>',
  '</dialog>',
  '<script>',
  'const ingredientReviewDialog = document.getElementById("ingredient-review-dialog");',
  'const ingredientReviewForm = ingredientReviewDialog?.querySelector("form");',
  'ingredientReviewForm?.addEventListener("submit", (event) => { if (!(event.submitter instanceof HTMLButtonElement) || !event.submitter.hasAttribute("data-delete-ingredient")) return; event.preventDefault(); if (!window.confirm("Delete " + (event.submitter.dataset.name || "this ingredient") + "?")) return; if (ingredientReviewForm instanceof HTMLFormElement) { ingredientReviewForm.action = "/ingredients/" + event.submitter.dataset.id + "/delete"; ingredientReviewForm.submit(); } });',
  'const setIngredientReviewValue = (selector, value) => { const field = ingredientReviewDialog?.querySelector(selector); if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) field.value = value || ""; };',
  'document.querySelectorAll("[data-ingredient-review]").forEach((button) => button.addEventListener("click", () => { if (!(button instanceof HTMLElement)) return; const reviewing = button.dataset.status === "needs_review"; const eyebrow = ingredientReviewDialog?.querySelector("[data-ingredient-review-eyebrow]"); const heading = ingredientReviewDialog?.querySelector("#ingredient-review-heading"); const deleteButton = ingredientReviewDialog?.querySelector("[data-delete-ingredient]"); if (eyebrow) eyebrow.textContent = reviewing ? "Needs review" : "Edit ingredient"; if (heading) heading.textContent = reviewing ? "Review ingredient" : "Edit ingredient"; if (deleteButton instanceof HTMLButtonElement) { deleteButton.dataset.id = button.dataset.id || ""; deleteButton.dataset.name = button.dataset.name || "this ingredient"; } if (ingredientReviewForm instanceof HTMLFormElement) ingredientReviewForm.action = "/ingredients/" + button.dataset.id + "/review"; const question = ingredientReviewDialog?.querySelector("#ingredient-review-question"); if (question) question.textContent = reviewing ? (button.dataset.question || "Add the missing ingredient details.") : "Update the shared ingredient details."; setIngredientReviewValue("#ingredient-review-name", button.dataset.name); setIngredientReviewValue("#ingredient-review-category", button.dataset.category); setIngredientReviewValue("#ingredient-review-unit", button.dataset.unit); setIngredientReviewValue("#ingredient-review-woolworths-url", button.dataset.woolworthsUrl); setIngredientReviewValue("#ingredient-review-purchase-quantity", button.dataset.purchaseQuantity); setIngredientReviewValue("#ingredient-review-purchase-unit", button.dataset.purchaseUnit); setIngredientReviewValue("#ingredient-review-storage-location", button.dataset.storageLocation); setIngredientReviewValue("#ingredient-review-status", button.dataset.status); setIngredientReviewValue("#ingredient-review-storage-notes", button.dataset.storageNotes); setIngredientReviewValue("#ingredient-review-feedback", button.dataset.reviewFeedback); ingredientReviewDialog?.showModal(); }));',
  'document.querySelectorAll("[data-close-ingredient-review]").forEach((button) => button.addEventListener("click", () => ingredientReviewDialog?.close()));',
  '</script>'
].join('');

const ingredientsPage = (ingredients: IngredientRow[], user: AuthUser, flash?: Flash) => [
  '<!doctype html>',
  '<html lang="en-AU">',
  '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="theme-color" content="#365f43"><meta name="description" content="The shared ingredient catalogue for a private household recipe box."><link rel="icon" href="/favicon.svg" type="image/svg+xml">',
  '<title>Ingredients — meals</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css">',
  '</head>',
  '<body>',
  '<a class="skip-link" href="#main">Skip to content</a>',
  '<div class="app-shell">',
  sidebar(user, 'ingredients'),
  '<main id="main">',
  '<header class="topbar"><nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li>Our household</li><li>Ingredients</li></ol></nav></header>',
  flash ? '<div class="toast ' + (flash.kind === 'error' ? 'error' : '') + '" role="status" aria-live="polite">' + escapeHtml(flash.message) + '</div>' : '',
  '<section aria-labelledby="ingredients-heading"><p class="eyebrow">Ingredient catalogue</p>',
  '<div class="section-heading"><div><h1 id="ingredients-heading">The things we cook with.</h1><p class="muted">Shared ingredients across the recipe box.</p></div></div>',
  ingredientTable(ingredients, user.role === 'parent'),
  '</section>',
  user.role === 'parent' ? ingredientReviewDialog() : '',
  '<footer>meals.chaos.haus · © ' + new Date().getFullYear() + '</footer>',
  '</main></div></body></html>'
].join('');

const listIngredients = async (db: D1Database) => {
  const { results } = await db.prepare(
    'SELECT id, name, category, default_unit, woolworths_url, purchase_quantity, purchase_unit, storage_location, storage_notes, enrichment_status, enrichment_notes, enriched_at, review_feedback FROM ingredients ORDER BY name COLLATE NOCASE'
  ).all<IngredientRow>();
  return results;
};

const getRecipe = async (db: D1Database, id: string) => {
  const recipe = await db.prepare(
    'SELECT id, source, source_url, title, subtitle, description, image_url, source_image_url, cook_time_from, cook_time_to, cook_time_unit, difficulty, macros_json, allergens_json, tags_json, ingredients_json, steps_json FROM recipes WHERE id = ? AND status = ?'
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
  sourceImageUrl: string,
  keepExisting = false
) => {
  const status = importStatus(candidate);
  const result = await db.prepare([
    'INSERT INTO recipes (id, source, source_id, source_url, title, subtitle, description, cook_time_from, cook_time_to, cook_time_unit, difficulty, macros_json, allergens_json, tags_json, image_url, source_image_url, ingredients_json, steps_json, status, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    keepExisting ? 'ON CONFLICT(id) DO NOTHING' : 'ON CONFLICT(id) DO UPDATE SET source_url = excluded.source_url, title = excluded.title, subtitle = excluded.subtitle, description = excluded.description, cook_time_from = excluded.cook_time_from, cook_time_to = excluded.cook_time_to, cook_time_unit = excluded.cook_time_unit, difficulty = excluded.difficulty, macros_json = excluded.macros_json, allergens_json = excluded.allergens_json, tags_json = excluded.tags_json, image_url = excluded.image_url, source_image_url = excluded.source_image_url, ingredients_json = excluded.ingredients_json, steps_json = excluded.steps_json, status = excluded.status, updated_at = CURRENT_TIMESTAMP'
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

const safeNext = (value: string) => value.startsWith('/') && !value.startsWith('//') ? value : '/';

app.get('/login', async (c) => {
  if (c.get('user')) return c.redirect('/', 303);
  return c.html(loginPage((await userCount(c.env.DB)) === 0, '', safeNext(c.req.query('next') || '/')));
});

app.post('/login', async (c) => {
  if (c.get('user')) return c.redirect('/', 303);
  const body = await c.req.parseBody();
  const name = formString(body.name);
  const password = typeof body.password === 'string' ? body.password : '';
  const account = await c.env.DB.prepare(
    'SELECT id, name, role, password_hash FROM users WHERE name = ? COLLATE NOCASE'
  ).bind(name).first<AuthUser & { password_hash: string }>();
  if (!account || !(await verifyPassword(password, account.password_hash))) {
    return c.html(loginPage(false, 'That name and password do not match.', safeNext(formString(body.next) || '/')), 401);
  }
  const token = newToken();
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
  ).bind(await hashToken(token), account.id).run();
  c.header('Set-Cookie', sessionCookie(c.req.url, token));
  return c.redirect(safeNext(formString(body.next) || '/'), 303);
});

app.post('/setup', async (c) => {
  if (await userCount(c.env.DB)) return c.redirect('/login', 303);
  const body = await c.req.parseBody();
  const name = formString(body.name);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!validUserName(name)) return c.html(loginPage(true, 'Choose a name between 1 and 80 characters.'), 400);
  if (!validPassword(password)) return c.html(loginPage(true, 'Use a password between 8 and 200 characters.'), 400);
  const result = await c.env.DB.prepare(
    'INSERT INTO users (name, role, password_hash) VALUES (?, ?, ?)'
  ).bind(name, 'parent', await hashPassword(password)).run();
  if (!result.success) return c.html(loginPage(true, 'The parent account could not be created.'), 500);
  return c.redirect('/login', 303);
});

app.post('/logout', requireAuth, async (c) => {
  const token = requestSessionToken(c.req.raw);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
  c.header('Set-Cookie', sessionCookie(c.req.url, '', 0));
  return c.redirect('/login', 303);
});

app.get('/settings', requireAuth, async (c) => {
  return c.html(settingsPage(c.get('user')!, '', c.req.query('saved') ? 'Settings saved.' : c.req.query('user') === 'created' ? 'User created.' : ''));
});

app.post('/users', requireParent, async (c) => {
  const currentUser = c.get('user')!;
  const body = await c.req.parseBody();
  const name = formString(body.name);
  const password = typeof body.password === 'string' ? body.password : '';
  const role = userRole(body.role);
  if (!validUserName(name)) return c.html(settingsPage(currentUser, '', '', 'Choose a name between 1 and 80 characters.'), 400);
  if (!role) return c.html(settingsPage(currentUser, '', '', 'Choose Adult or Kid as the role.'), 400);
  if (!validPassword(password)) return c.html(settingsPage(currentUser, '', '', 'Use a password between 8 and 200 characters.'), 400);
  const duplicate = await c.env.DB.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').bind(name).first<{ id: number }>();
  if (duplicate) return c.html(settingsPage(currentUser, '', '', 'That name is already in use.'), 400);
  const result = await c.env.DB.prepare(
    'INSERT INTO users (name, role, password_hash) VALUES (?, ?, ?)'
  ).bind(name, role, await hashPassword(password)).run();
  if (!result.success) return c.html(settingsPage(currentUser, '', '', 'The new user could not be created.'), 500);
  return c.redirect('/settings?user=created', 303);
});

app.post('/settings', requireAuth, async (c) => {
  const user = c.get('user')!;
  const body = await c.req.parseBody();
  const name = formString(body.name);
  const currentPassword = typeof body.current_password === 'string' ? body.current_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
  const confirmPassword = typeof body.confirm_password === 'string' ? body.confirm_password : '';
  if (!validUserName(name)) return c.html(settingsPage(user, 'Choose a name between 1 and 80 characters.'), 400);
  const duplicate = await c.env.DB.prepare(
    'SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id != ?'
  ).bind(name, user.id).first<{ id: number }>();
  if (duplicate) return c.html(settingsPage(user, 'That name is already in use.'), 400);

  let passwordHash = '';
  if (currentPassword || newPassword || confirmPassword) {
    if (!validPassword(newPassword) || newPassword !== confirmPassword) {
      return c.html(settingsPage(user, 'New passwords must match and be between 8 and 200 characters.'), 400);
    }
    const account = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
    if (!account || !(await verifyPassword(currentPassword, account.password_hash))) {
      return c.html(settingsPage(user, 'Your current password is not correct.'), 400);
    }
    passwordHash = await hashPassword(newPassword);
  }

  const result = await c.env.DB.prepare(
    passwordHash ? 'UPDATE users SET name = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?' : 'UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(...(passwordHash ? [name, passwordHash, user.id] : [name, user.id])).run();
  if (!result.success) return c.text('Your settings could not be saved.', 500);
  return c.redirect('/settings?saved=1', 303);
});

type SmashDraft = { id: string; input_json: string; recipe_json: string; created_at: string; parent_id: string | null };
type SmashRunView = { id: string; status: string };
const smashPath = (id: string) => '/train-smash/' + encodeURIComponent(id);
const runPath = (id: string) => '/train-smash/runs/' + encodeURIComponent(id);
const statusLabel = (status: string) => ({ accepted: 'Accepted — getting things ready…', running: 'Making something of it…', validating: 'Checking the recipe…', saving: 'Saving the recipe…', completed: 'Ready.', cancelled: 'Cancelled.', failed: 'The recipe agent could not finish.' }[status] || 'Working…');
const smashPage = (user: AuthUser, drafts: SmashDraft[], draft?: SmashDraft, error = '', input: StoredSmashInput = { ingredients: '', servings: 2, preferences: '' }, saved = false, run?: SmashRunView) => {
  const recipe = draft ? validateSmashRecipe(JSON.parse(draft.recipe_json)) : null;
  if (!run && draft) run = { id: draft.id, status: 'completed' };
  const runPanel = run ? '<section class="card smash-progress" data-smash-run="' + escapeHtml(run.id) + '" data-smash-run-status="' + escapeHtml(run.status) + '" aria-labelledby="smash-progress-heading"><div class="row"><div><p class="eyebrow">Train Smash</p><h2 id="smash-progress-heading" data-smash-progress-label>' + escapeHtml(statusLabel(run.status)) + '</h2></div><span class="smash-elapsed" data-smash-elapsed>00 sec</span></div><p class="help" role="status" aria-live="polite" data-smash-progress-detail>Reconnects safely if you leave this page.</p><pre class="smash-terminal" data-smash-progress-log role="log" aria-label="Agent progress">' + (run.status === 'completed' ? '&gt; Recipe ready.' : '') + '</pre><div class="actions"><button class="button danger" type="button" data-smash-cancel ' + (['accepted', 'running', 'validating'].includes(run.status) ? '' : 'hidden') + '>Cancel</button><a class="button secondary" href="' + runPath(run.id) + '" data-smash-reconnect hidden>Reconnect</a></div></section>' : '';
  const inputForm = !run || ['failed', 'cancelled'].includes(run.status) ? '<form class="card stack" action="/train-smash" method="post" data-smash-form><input type="hidden" name="requestId" value="' + crypto.randomUUID() + '"><div class="field"><label for="smash-ingredients">What have you got?</label><textarea id="smash-ingredients" name="ingredients" rows="5" maxlength="4000" required aria-describedby="smash-help" placeholder="2 eggs, half a zucchini, leftover rice, a handful of cheese…">' + escapeHtml(input.ingredients) + '</textarea><p class="help" id="smash-help">Include rough amounts and any basics you have, like oil, salt, or spices.</p></div><div class="field"><label for="smash-servings">How many are eating?</label><input id="smash-servings" name="servings" type="number" min="1" max="12" value="' + input.servings + '" required></div><div class="field"><label for="smash-preferences">Dietary needs or anything to avoid <span class="muted">(optional)</span></label><textarea id="smash-preferences" name="preferences" rows="2" maxlength="1000" placeholder="No nuts, vegetarian, keep it mild…">' + escapeHtml(input.preferences) + '</textarea></div><div class="actions"><button class="button" type="submit">Make something of it</button><p class="help" role="status" data-smash-status>We’ll suggest one recipe. Keep it only if you love it.</p></div></form>' : '';
  const parentNote = draft?.parent_id ? '<p class="help">Revised from <a href="' + smashPath(draft.parent_id) + '">the original suggestion</a>.</p>' : '';
  const revisionForm = recipe && draft ? '<form class="card stack" action="' + smashPath(draft.id) + '/revise" method="post" data-revision-form><h3>Try a revision</h3><p class="help">Keep the original recipe and ask for one bounded change. Dietary needs stay in force.</p><input type="hidden" name="requestId" value="' + crypto.randomUUID() + '"><div class="field"><label for="revision-instruction">What should change?</label><textarea id="revision-instruction" name="instruction" rows="3" maxlength="1000" required placeholder="Make it dairy-free"></textarea></div><button class="button secondary" type="submit">Revise this recipe</button></form>' : '';
  return [
    '<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Train Smash — meals</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css"><script src="/train-smash.js" defer></script></head><body><a class="skip-link" href="#main">Skip to content</a><div class="app-shell">',
    sidebar(user, 'train-smash'),
    '<main id="main" data-smash-user-id="' + user.id + '"><header class="topbar"><span class="breadcrumbs">Our household / Train Smash</span></header><section class="stack" aria-labelledby="smash-heading"><div><p class="eyebrow">A little mish mash. Something good.</p><h1 id="smash-heading">🚂 Train Smash</h1><p class="muted spaced">Odds, ends, and whatever’s in the fridge. Let’s make dinner out of it.</p></div>',
    error ? '<p class="notice warning" role="alert">' + escapeHtml(error) + '</p>' : '',
    runPanel,
    inputForm,
    recipe && draft ? '<div class="recipe-detail-grid"><article class="card recipe-steps-card stack" aria-labelledby="suggestion-heading"><div><p class="eyebrow">AI-created · ' + (saved ? 'In your rotation' : 'Not yet in your rotation') + '</p><h2 id="suggestion-heading">' + escapeHtml(recipe.title) + '</h2><p class="spaced">' + escapeHtml(recipe.description) + '</p><p class="help">Serves ' + recipe.servings + ' · About ' + recipe.minutes + ' minutes</p>' + parentNote + '</div><div class="section-heading"><h2>Recipe</h2><span class="badge success">' + recipe.steps.length + ' steps</span></div><ol class="instructions">' + recipe.steps.map((step) => '<li><p>' + escapeHtml(step) + '</p></li>').join('') + '</ol><p class="notice">' + escapeHtml(recipe.notes) + '</p><p class="help">AI-created recipe. Check it makes sense for your ingredients and dietary needs before cooking.</p>' + (saved ? '<a class="button secondary" href="/recipes/train-smash:' + draft.id + '">In your rotation → View recipe</a>' : user.role === 'parent' ? '<form class="stack" action="' + smashPath(draft.id) + '/save" method="post"><label class="choice"><input type="checkbox" name="tried" value="yes" required><span>We tried it and liked it.</span></label><button class="button" type="submit">Add to rotation</button></form>' : '<p class="help">Liked it? Ask a parent to add it to the rotation.</p>') + '</article><div class="recipe-detail-card"><div class="card recipe-detail-panel recipe-ingredients-section"><h2 id="suggestion-ingredients-heading">Ingredients</h2><ul class="recipe-ingredients">' + recipe.ingredients.map((ingredient, index) => '<li><label class="choice"><input type="checkbox" id="smash-ingredient-' + (index + 1) + '"><span>' + escapeHtml(ingredient) + '</span></label></li>').join('') + '</ul></div></div></div>' + revisionForm : '',
    '<section class="card stack" aria-labelledby="recent-smashes"><h2 id="recent-smashes">Your recent smashes</h2><p class="help">Come back after dinner to save a keeper.</p>' + (drafts.length ? '<ul>' + drafts.map((item) => '<li><a href="' + smashPath(item.id) + '">' + escapeHtml(validateSmashRecipe(JSON.parse(item.recipe_json)).title) + '</a></li>').join('') + '</ul>' : '<p class="muted">Your first idea starts with what you’ve got.</p>') + '</section></section></main></div></body></html>'
  ].join('');
};
const listSmashes = async (db: D1Database, userId: number) => (await db.prepare('SELECT id, input_json, recipe_json, created_at, parent_id FROM train_smashes WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10').bind(userId).all<SmashDraft>()).results;
const getSmash = async (db: D1Database, id: string, user: AuthUser) => db.prepare('SELECT id, input_json, recipe_json, created_at, parent_id FROM train_smashes WHERE id = ? AND (user_id = ? OR ? = \'parent\')').bind(id, user.id, user.role).first<SmashDraft>();

const agentBase = (env: AppEnv['Bindings']) => {
  if (!env.TRAIN_SMASH_URL || !env.TRAIN_SMASH_TOKEN) throw Object.assign(new Error('Agent unavailable'), { code: 'agent_unavailable' });
  const base = new URL(env.TRAIN_SMASH_URL);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) throw Object.assign(new Error('Agent URL must be HTTPS.'), { code: 'agent_unavailable' });
  if (!base.pathname.endsWith('/generate')) throw Object.assign(new Error('Agent URL must end in /generate.'), { code: 'agent_unavailable' });
  if (!!env.CF_ACCESS_CLIENT_ID !== !!env.CF_ACCESS_CLIENT_SECRET) throw Object.assign(new Error('Access credentials are incomplete.'), { code: 'agent_unavailable' });
  return base;
};
const agentEndpoint = (env: AppEnv['Bindings'], suffix: string) => {
  const base = agentBase(env);
  const prefix = base.pathname.slice(0, -'/generate'.length);
  base.pathname = prefix + suffix;
  base.search = '';
  base.hash = '';
  return base;
};
const agentHeaders = (env: AppEnv['Bindings'], userId: number) => {
  const headers = new Headers({ Authorization: 'Bearer ' + env.TRAIN_SMASH_TOKEN, 'X-Meals-User-Id': String(userId), 'Content-Type': 'application/json' });
  if (env.CF_ACCESS_CLIENT_ID) headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID);
  if (env.CF_ACCESS_CLIENT_SECRET) headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET);
  return headers;
};
const agentJson = async (response: Response) => {
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_INTERNAL_MESSAGE_BYTES) throw new Error('Agent response too large.');
  return JSON.parse(new TextDecoder().decode(body));
};
const fixedAgentCode = (value: unknown) => ['busy', 'forbidden', 'request_conflict', 'not_found', 'cancelled', 'timeout', 'interrupted', 'agent_unavailable', 'invalid_recipe', 'save_failed'].includes(value) ? value as Parameters<typeof publicMessage>[0] : 'agent_unavailable';
const callAgent = async (env: AppEnv['Bindings'], userId: number, command: OriginCommand) => {
  const response = await fetch(agentEndpoint(env, '/generate'), { method: 'POST', headers: agentHeaders(env, userId), body: JSON.stringify(command), redirect: 'manual', signal: AbortSignal.timeout(160000) });
  const payload = await agentJson(response);
  if (!response.ok) throw Object.assign(new Error('Agent request failed.'), { code: fixedAgentCode(payload.error), snapshot: payload.snapshot });
  return parseSnapshot(payload);
};
const buildRevisionCommand = async (db: D1Database, user: AuthUser, command: Extract<BrowserCommand, { type: 'revise' }>): Promise<OriginCommand> => {
  const draft = await getSmash(db, command.draftId, user);
  if (!draft) throw Object.assign(new Error('Draft not found.'), { code: 'not_found' });
  const input = validateStoredSmashInput(JSON.parse(draft.input_json));
  const previousRecipe = validateSmashRecipe(JSON.parse(draft.recipe_json));
  const revisions = validateRevisionHistory(input.revisions || []);
  if (revisions.length >= 10) throw Object.assign(new Error('Revision limit reached.'), { code: 'request_conflict' });
  const nextRevisions = [...revisions, command.instruction];
  return { v: 1, type: 'revise', requestId: command.requestId, parentId: draft.id, previousRecipe, revisions: nextRevisions, input: { ingredients: input.ingredients, servings: input.servings, preferences: input.preferences, revisions: nextRevisions } };
};
const persistSmashCompletion = async (db: D1Database, user: AuthUser, snapshot: OriginSnapshot) => {
  if (snapshot.status !== 'completed' || !snapshot.recipe) throw new Error('Not a completed recipe.');
  const input = validateStoredSmashInput(snapshot.input);
  const recipe = validateSmashRecipe(snapshot.recipe);
  if (recipe.servings !== input.servings) throw new Error('Recipe servings did not match.');
  if (snapshot.parentId && !await getSmash(db, snapshot.parentId, user)) throw Object.assign(new Error('Parent draft not found.'), { code: 'forbidden' });
  const result = await db.prepare([
    'INSERT INTO train_smashes (id, user_id, input_json, recipe_json, parent_id) VALUES (?, ?, ?, ?, ?)',
    'ON CONFLICT(id) DO NOTHING'
  ].join(' ')).bind(snapshot.runId, user.id, JSON.stringify(input), JSON.stringify(recipe), snapshot.parentId || null).run();
  if (!result.success) throw Object.assign(new Error('D1 save failed.'), { code: 'save_failed' });
  const saved = await db.prepare('SELECT id, user_id FROM train_smashes WHERE id = ?').bind(snapshot.runId).first<{ id: string; user_id: number }>();
  if (!saved || saved.user_id !== user.id) throw Object.assign(new Error('Draft owner mismatch.'), { code: 'forbidden' });
  return saved.id;
};

app.use('/train-smash*', requireAuth, async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'POST' && c.req.header('Origin') !== new URL(c.req.url).origin) return c.text('Please submit this form from meals.', 403);
  await next();
});
app.get('/train-smash', async (c) => c.html(smashPage(c.get('user')!, await listSmashes(c.env.DB, c.get('user')!.id))));
app.post('/train-smash', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.parseBody();
  const rawInput = { ingredients: formString(body.ingredients), servings: Number(body.servings), preferences: formString(body.preferences) };
  let input;
  try { input = validateSmashInput(rawInput); }
  catch (error) { return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), undefined, (error as Error).message, { ...rawInput, servings: Number.isFinite(rawInput.servings) ? rawInput.servings : 2 }), 400); }
  const requestId = formString(body.requestId);
  if (!isUuid(requestId)) return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), undefined, 'Please try the generation again.', input), 400);
  try {
    const snapshot = await callAgent(c.env, user.id, { v: 1, type: 'generate', requestId, input });
    await persistSmashCompletion(c.env.DB, user, snapshot);
    return c.redirect(smashPath(snapshot.runId), 303);
  } catch (error) {
    const code = fixedAgentCode(error?.code || (error?.snapshot && error.snapshot.errorCode));
    const run = error?.snapshot && isUuid(error.snapshot.runId) ? { id: error.snapshot.runId, status: error.snapshot.status || 'failed' } : undefined;
    return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), undefined, publicMessage(code), input, false, run), code === 'busy' ? 429 : 503);
  }
});
app.get('/train-smash/socket', async (c) => {
  const user = c.get('user')!;
  if (c.req.header('Origin') !== new URL(c.req.url).origin || c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.text('WebSocket upgrade required.', 403);
  const pair = new WebSocketPair();
  const browser = pair[0];
  const server = pair[1];
  server.accept({ allowHalfOpen: true });
  const bridge = async () => {
    let origin: WebSocket | null = null;
    let originOpen = false;
    const pending: string[] = [];
    let closed = false;
    const send = (value: unknown) => { if (!closed && server.readyState === 1) server.send(JSON.stringify(value)); };
    const close = () => { if (closed) return; closed = true; origin?.close(1000, 'Bridge closed'); server.close(1000, 'Bridge closed'); };
    const forward = (value: OriginCommand) => { if (closed) return; const payload = JSON.stringify(value); if (originOpen) origin!.send(payload); else pending.push(payload); };
    server.addEventListener('close', close);
    server.addEventListener('message', (event) => {
      void (async () => {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > MAX_BROWSER_MESSAGE_BYTES) { server.close(1009, 'Message too large'); return; }
        const freshUser = await currentUser(c.req.raw, c.env.DB);
        if (!freshUser || freshUser.id !== user.id) { send({ v: 1, type: 'error', code: 'forbidden', message: publicMessage('forbidden') }); close(); return; }
        const command = parseBrowserCommand(JSON.parse(event.data));
        if (command.type === 'generate') forward(command);
        else if (command.type === 'revise') forward(await buildRevisionCommand(c.env.DB, user, command));
        else forward(command);
      })().catch((error) => send({ v: 1, type: 'error', code: fixedAgentCode(error?.code), message: publicMessage(fixedAgentCode(error?.code)), requestId: error?.requestId }));
    });
    try {
      const response = await fetch(new Request(agentEndpoint(c.env, '/events'), { headers: { ...Object.fromEntries(agentHeaders(c.env, user.id)), Upgrade: 'websocket' }, redirect: 'manual' }));
      if (response.status !== 101 || !response.webSocket) throw new Error('Agent socket unavailable.');
      if (closed) { response.webSocket.close(1000, 'Bridge closed'); return; }
      origin = response.webSocket;
      origin.accept({ allowHalfOpen: true });
      const flush = () => { originOpen = true; while (pending.length) origin!.send(pending.shift()!); };
      origin.addEventListener('open', flush);
      if (origin.readyState === 1) flush();
      origin.addEventListener('message', (event) => {
        void (async () => {
          const message = parseOriginMessage(typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(new TextDecoder().decode(event.data)));
          if (message.type === 'error') { send(message); return; }
          const snapshot = message;
          if (snapshot.status !== 'completed') { send(snapshot); return; }
          send({ ...snapshot, status: 'saving' });
          try {
            const draftId = await persistSmashCompletion(c.env.DB, user, snapshot);
            send({ ...snapshot, status: 'completed', draftId, draftUrl: smashPath(draftId) });
          } catch {
            send({ ...snapshot, status: 'failed', errorCode: 'save_failed', message: publicMessage('save_failed') });
          }
        })().catch(() => send({ v: 1, type: 'error', code: 'invalid_recipe', message: publicMessage('invalid_recipe') }));
      });
      origin.addEventListener('close', close);
      origin.addEventListener('error', close);
    } catch { send({ v: 1, type: 'error', code: 'agent_unavailable', message: publicMessage('agent_unavailable') }); close(); return; }
  };
  c.executionCtx.waitUntil(bridge());
  return new Response(null, { status: 101, webSocket: browser });
});
app.get('/train-smash/runs/:runId', async (c) => {
  const user = c.get('user')!;
  const runId = c.req.param('runId');
  if (!isUuid(runId)) return c.notFound();
  try {
    const response = await fetch(agentEndpoint(c.env, '/runs/' + encodeURIComponent(runId)), { headers: agentHeaders(c.env, user.id), redirect: 'manual' });
    if (response.status === 404) return c.notFound();
    if (!response.ok) throw new Error('Agent unavailable.');
    const snapshot = parseSnapshot(await agentJson(response));
    if (snapshot.status === 'completed') {
      const draftId = await persistSmashCompletion(c.env.DB, user, snapshot);
      return c.redirect(smashPath(draftId), 303);
    }
    return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), undefined, snapshot.errorCode ? publicMessage(snapshot.errorCode) : '', snapshot.input, false, { id: snapshot.runId, status: snapshot.status }), 200);
  } catch (error) {
    const code = fixedAgentCode(error?.code);
    return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), undefined, publicMessage(code), { ingredients: '', servings: 2, preferences: '' }, false, { id: runId, status: 'failed' }), 503);
  }
});
app.post('/train-smash/:id/revise', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.parseBody();
  const draft = await getSmash(c.env.DB, c.req.param('id'), user);
  if (!draft) return c.notFound();
  const input = validateStoredSmashInput(JSON.parse(draft.input_json));
  const instruction = formString(body.instruction);
  const requestId = formString(body.requestId);
  if (!isUuid(requestId) || !instruction || instruction.length > 1000) return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), draft, 'Add one revision instruction (up to 1,000 characters).', input), 400);
  try {
    const snapshot = await callAgent(c.env, user.id, await buildRevisionCommand(c.env.DB, user, { v: 1, type: 'revise', requestId, draftId: draft.id, instruction }));
    await persistSmashCompletion(c.env.DB, user, snapshot);
    return c.redirect(smashPath(snapshot.runId), 303);
  } catch (error) {
    const code = fixedAgentCode(error?.code || (error?.snapshot && error.snapshot.errorCode));
    const run = error?.snapshot && isUuid(error.snapshot.runId) ? { id: error.snapshot.runId, status: error.snapshot.status || 'failed' } : undefined;
    return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), draft, publicMessage(code), input, false, run), code === 'busy' ? 429 : 503);
  }
});
app.get('/train-smash/:id', async (c) => {
  const user = c.get('user')!;
  const draft = await getSmash(c.env.DB, c.req.param('id'), user);
  if (!draft) return c.notFound();
  return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), draft, '', validateStoredSmashInput(JSON.parse(draft.input_json)), !!(await getRecipe(c.env.DB, 'train-smash:' + draft.id))));
});
app.post('/train-smash/:id/save', requireParent, async (c) => {
  const user = c.get('user')!;
  const draft = await getSmash(c.env.DB, c.req.param('id'), user);
  if (!draft) return c.notFound();
  const input = validateStoredSmashInput(JSON.parse(draft.input_json));
  if ((await c.req.parseBody()).tried !== 'yes') return c.html(smashPage(user, await listSmashes(c.env.DB, user.id), draft, 'Try it first, then tick the box if you liked it.', input), 400);
  const recipe = validateSmashRecipe(JSON.parse(draft.recipe_json));
  await saveRecipe(c.env.DB, {
    source: { site: 'train-smash', id: draft.id, url: smashPath(draft.id), retrievedAt: draft.created_at },
    recipe: { title: recipe.title, subtitle: 'Serves ' + recipe.servings + ' · AI-created', description: recipe.description + '\n\n' + recipe.notes,
      duration: { from: recipe.minutes, to: recipe.minutes, unit: 'minutes' }, difficulty: '', tags: ['Train Smash'],
      macros: { perServing: { kcal: null, protein: null, carbs: null, fat: null } }, allergens: [],
      ingredients: recipe.ingredients.map((text) => ({ text, kind: 'provided', allergens: [] })),
      steps: recipe.steps.map((text) => ({ title: '', text })), utensils: [], images: [] }
  }, '', '', true);
  return c.redirect('/recipes/train-smash:' + draft.id, 303);
});

app.get('/health', (c) => c.json({ ok: true }));

app.get('/media/*', requireAuth, async (c) => {
  const key = c.req.path.slice('/media/'.length);
  if (!/^recipes\/[a-z0-9-]+\/[a-z0-9._-]+$/i.test(key)) return c.notFound();
  const object = await c.env.MEDIA.get(key);
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
});

app.get('/ingredients', requireAuth, async (c) => c.html(ingredientsPage(
  await listIngredients(c.env.DB),
  c.get('user')!,
  c.req.query('reviewed')
    ? { kind: 'success', message: 'Ingredient updated.' }
    : c.req.query('updated')
      ? { kind: 'success', message: 'Ingredient updated.' }
      : c.req.query('deleted') ? { kind: 'success', message: 'Ingredient deleted.' } : undefined
)));

app.post('/ingredients/:ingredientId/review', requireParent, async (c) => {
  const ingredientId = c.req.param('ingredientId');
  if (!/^\d+$/.test(ingredientId)) return c.notFound();
  const ingredient = await c.env.DB.prepare(
    'SELECT id, enrichment_status FROM ingredients WHERE id = ?'
  ).bind(ingredientId).first<{ id: number; enrichment_status: IngredientRow['enrichment_status'] }>();
  if (!ingredient) return c.notFound();

  const body = await c.req.parseBody();
  const name = formString(body.name);
  const normalizedName = normalizeIngredientName(name);
  const status = reviewStatus(body.status);
  if (!normalizedName) {
    return c.html(ingredientsPage(await listIngredients(c.env.DB), c.get('user')!, {
      kind: 'error',
      message: 'Ingredient name is required.'
    }), 400);
  }
  if (!status) {
    return c.html(ingredientsPage(await listIngredients(c.env.DB), c.get('user')!, {
      kind: 'error',
      message: 'Choose a valid ingredient status.'
    }), 400);
  }

  const rawWoolworthsUrl = formString(body.woolworths_url);
  const productUrl = woolworthsUrl(body.woolworths_url);
  const rawPurchaseQuantity = formString(body.purchase_quantity);
  const quantity = purchaseQuantity(body.purchase_quantity);
  const rawPurchaseUnit = formString(body.purchase_unit);
  const unit = reviewPurchaseUnit(body.purchase_unit);
  if ((rawWoolworthsUrl && !productUrl) || (rawPurchaseQuantity && quantity == null) || (rawPurchaseUnit && !unit) || (!!rawPurchaseQuantity !== !!rawPurchaseUnit)) {
    return c.html(ingredientsPage(await listIngredients(c.env.DB), c.get('user')!, {
      kind: 'error',
      message: 'Use a Woolworths product URL and a valid purchase amount with unit.'
    }), 400);
  }

  const duplicate = await c.env.DB.prepare(
    'SELECT id FROM ingredients WHERE normalized_name = ? AND id != ?'
  ).bind(normalizedName, ingredientId).first<{ id: number }>();
  if (duplicate) {
    return c.html(ingredientsPage(await listIngredients(c.env.DB), c.get('user')!, {
      kind: 'error',
      message: 'An ingredient with that name already exists.'
    }), 400);
  }

  const result = await c.env.DB.prepare([
    "UPDATE ingredients SET name = ?, normalized_name = ?, category = ?, default_unit = ?, woolworths_url = ?, purchase_quantity = ?, purchase_unit = ?, storage_location = ?, storage_notes = ?, review_feedback = ?, enrichment_status = ?, enrichment_notes = CASE WHEN ? = 'needs_review' THEN enrichment_notes ELSE '' END, enriched_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP ELSE enriched_at END, updated_at = CURRENT_TIMESTAMP",
    'WHERE id = ?'
  ].join(' ')).bind(
    name,
    normalizedName,
    formString(body.category) || null,
    formString(body.default_unit) || null,
    productUrl || '',
    quantity,
    unit,
    reviewStorage(body.storage_location),
    formString(body.storage_notes),
    formString(body.review_feedback),
    status,
    status,
    status,
    ingredientId
  ).run();
  if (!result.success) return c.text('The ingredient could not be updated.', 500);
  return c.redirect('/ingredients?' + (ingredient.enrichment_status === 'needs_review' ? 'reviewed=1' : 'updated=1'), 303);
});

app.post('/ingredients/:ingredientId/delete', requireParent, async (c) => {
  const ingredientId = c.req.param('ingredientId');
  if (!/^\d+$/.test(ingredientId)) return c.notFound();
  const ingredient = await c.env.DB.prepare(
    'SELECT id FROM ingredients WHERE id = ?'
  ).bind(ingredientId).first<{ id: number }>();
  if (!ingredient) return c.notFound();
  const result = await c.env.DB.prepare(
    'DELETE FROM ingredients WHERE id = ?'
  ).bind(ingredientId).run();
  if (!result.success) return c.text('The ingredient could not be deleted.', 500);
  return c.redirect('/ingredients?deleted=1', 303);
});

app.get('/recipes/:recipeId', requireAuth, async (c) => {
  const recipeId = c.req.param('recipeId');
  if (!validRecipeId(recipeId)) return c.notFound();
  const recipe = await getRecipe(c.env.DB, recipeId);
  return recipe ? c.html(recipeDetailPage(recipe, await listCooks(c.env.DB, recipe.id), c.get('user')!)) : c.notFound();
});

app.post('/recipes/:recipeId/cook', requireParent, async (c) => {
  const recipeId = c.req.param('recipeId');
  if (!validRecipeId(recipeId) || !(await getRecipe(c.env.DB, recipeId))) return c.notFound();
  const result = await c.env.DB.prepare(
    'INSERT INTO recipe_cooks (recipe_id, cooked_at) VALUES (?, ?)'
  ).bind(recipeId, new Date().toISOString()).run();
  if (!result.success) return c.text('The cook could not be recorded.', 500);
  return c.redirect('/recipes/' + encodeURIComponent(recipeId), 303);
});

app.post('/recipes/:recipeId/cooks/:cookId/delete', requireParent, async (c) => {
  const recipeId = c.req.param('recipeId');
  const cookId = c.req.param('cookId');
  if (!validRecipeId(recipeId) || !/^\d+$/.test(cookId) || !(await getRecipe(c.env.DB, recipeId))) return c.notFound();
  const result = await c.env.DB.prepare(
    'DELETE FROM recipe_cooks WHERE id = ? AND recipe_id = ?'
  ).bind(cookId, recipeId).run();
  if (!result.success) return c.text('The cook could not be removed.', 500);
  return c.redirect('/recipes/' + encodeURIComponent(recipeId), 303);
});

app.post('/recipes/:recipeId/delete', requireParent, async (c) => {
  const recipeId = c.req.param('recipeId');
  if (!validRecipeId(recipeId)) return c.notFound();
  if (!(await getRecipe(c.env.DB, recipeId))) return c.notFound();
  const result = await c.env.DB.prepare(
    'DELETE FROM recipes WHERE id = ?'
  ).bind(recipeId).run();
  if (!result.success) return c.text('The recipe could not be deleted.', 500);
  await c.env.MEDIA.delete('recipes/' + recipeId.replace(':', '/'));
  return c.redirect('/?deleted=1', 303);
});

app.post('/recipes/:recipeId/edit', requireParent, async (c) => {
  const recipeId = c.req.param('recipeId');
  if (!validRecipeId(recipeId)) return c.notFound();
  const recipe = await getRecipe(c.env.DB, recipeId);
  if (!recipe) return c.notFound();
  const body = await c.req.parseBody();
  const title = formString(body.title);
  const imageUrl = formString(body.image_url);
  if (!title) return c.html(recipeDetailPage(recipe, await listCooks(c.env.DB, recipe.id), c.get('user')!, 'Recipe name is required.'), 400);
  if (imageUrl) {
    try { if (new URL(imageUrl).protocol !== 'https:') throw new Error(); } catch { return c.html(recipeDetailPage(recipe, await listCooks(c.env.DB, recipe.id), c.get('user')!, 'Image URL must use HTTPS.'), 400); }
  }
  let image = { url: recipe.image_url, key: '' };
  try {
    if (imageUrl && imageUrl !== recipe.source_image_url) image = await copyImage(c.env.MEDIA, imageUrl, recipe.source, recipe.id.split(':')[1]);
    const result = await c.env.DB.prepare('UPDATE recipes SET title = ?, subtitle = ?, description = ?, image_url = ?, source_image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(title, formString(body.subtitle), formString(body.description), image.url, imageUrl || recipe.source_image_url, recipeId).run();
    if (!result.success) throw new Error('The recipe could not be updated.');
  } catch (error) { return c.html(recipeDetailPage(recipe, await listCooks(c.env.DB, recipe.id), c.get('user')!, error instanceof Error ? error.message : 'The recipe could not be updated.'), 500); }
  return c.redirect(recipePath(recipe) + '?updated=1', 303);
});

app.get('/', requireAuth, async (c) => {
  const flash = c.req.query('imported')
    ? {
        kind: 'success' as const,
        message: c.req.query('status') === 'needs_review'
          ? 'Recipe imported and saved for review.'
          : 'Recipe imported and added to your box.'
      }
    : c.req.query('deleted')
      ? { kind: 'success' as const, message: 'Recipe deleted from your box.' }
    : undefined;
  return c.html(page(await listRecipes(c.env.DB), c.get('user')!, flash));
});

app.post('/', requireParent, async (c) => {
  const user = c.get('user')!;
  const body = await c.req.parseBody();
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) {
    return c.html(page(await listRecipes(c.env.DB), user, {
      kind: 'error',
      message: 'Paste a recipe URL first.',
      url: rawUrl
    }), 400);
  }

  let parsed;
  try {
    parsed = parseRecipeUrl(rawUrl);
  } catch (error) {
    return c.html(page(await listRecipes(c.env.DB), user, {
      kind: 'error',
      message: error instanceof Error ? error.message : 'That recipe URL is not supported.',
      url: rawUrl
    }), 400);
  }

  let candidate: ImportCandidate;
  try {
    candidate = await extractRecipe(parsed.url) as ImportCandidate;
  } catch (error) {
    return c.html(page(await listRecipes(c.env.DB), user, {
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
    return c.html(page(await listRecipes(c.env.DB), user, {
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
