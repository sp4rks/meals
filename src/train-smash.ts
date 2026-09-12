export type SmashRecipe = {
  title: string;
  description: string;
  servings: number;
  minutes: number;
  ingredients: string[];
  steps: string[];
  notes: string;
};

const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const texts = (value: unknown, maxItems: number, maxLength: number) => Array.isArray(value) && value.length > 0 && value.length <= maxItems && value.every((item) => text(item, maxLength));

export function validateSmashRecipe(value: unknown): SmashRecipe {
  const r = value as SmashRecipe;
  if (!r || !text(r.title, 160) || !text(r.description, 1200) || !Number.isInteger(r.servings) || r.servings < 1 || r.servings > 12 || !Number.isInteger(r.minutes) || r.minutes < 1 || r.minutes > 480 || !texts(r.ingredients, 40, 300) || !texts(r.steps, 20, 1500) || !text(r.notes, 1500)) {
    throw new Error('The agent did not return a complete recipe. Please try again.');
  }
  return { title: r.title.trim(), description: r.description.trim(), servings: r.servings, minutes: r.minutes, ingredients: r.ingredients.map((s) => s.trim()), steps: r.steps.map((s) => s.trim()), notes: r.notes.trim() };
}

export function validateSmashInput(value: unknown) {
  const input = value as { ingredients: string; servings: number; preferences: string };
  if (!input || !text(input.ingredients, 4000) || !Number.isInteger(input.servings) || input.servings < 1 || input.servings > 12 || typeof input.preferences !== 'string' || input.preferences.length > 1000) {
    throw new Error('Enter your ingredients (up to 4,000 characters), 1–12 servings, and any dietary needs (up to 1,000 characters).');
  }
  return { ingredients: input.ingredients.trim(), servings: input.servings, preferences: input.preferences.trim() };
}
