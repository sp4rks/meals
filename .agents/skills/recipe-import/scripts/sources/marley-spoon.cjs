const GRAPHQL_URL = "https://api.marleyspoon.com/graphql";
const USER_AGENT = "recipe-import/0.1 (+deterministic recipe extraction)";
const RECIPE_QUERY = [
  "query RecipeImport($recipeId: String!) {",
  "  recipe(id: $recipeId) {",
  "    id",
  "    title",
  "    subtitle",
  "    description",
  "    difficulty",
  "    duration { from to unit }",
  "    allergens { name }",
  "    nutritionalInformation { key perPortion }",
  "    shippedIngredients { name nameWithQuantity allergens { name } }",
  "    assumedIngredients { name }",
  "    utensils { name }",
  "    steps { title description }",
  "  }",
  "}"
].join("\n");

class ImportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clean(value) {
  return typeof value === "string"
    ? value.replace(/__([^_]+)__/g, "$1").replace(/\s+/g, " ").trim()
    : "";
}

function perPortion(items, key) {
  return items.find((item) => item.key === key)?.perPortion ?? null;
}

function attr(tag, name) {
  const match = tag.match(new RegExp("\\b" + name + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
  return match ? match[2] : "";
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const number = code.toLowerCase().startsWith("x")
        ? parseInt(code.slice(1), 16)
        : parseInt(code, 10);
      return Number.isNaN(number) ? _ : String.fromCodePoint(number);
    });
}

function metadata(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (attr(tag, "property").toLowerCase() === key || attr(tag, "name").toLowerCase() === key) {
      return decodeHtml(attr(tag, "content"));
    }
  }
  return "";
}

function canonicalUrl(html, fallback) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  const tag = tags.find((item) => attr(item, "rel").toLowerCase().split(/\s+/).includes("canonical"));
  const value = tag ? attr(tag, "href") : "";
  try {
    const url = new URL(value || fallback);
    if (url.protocol !== "https:" || !isMarleyHost(url.hostname)) return fallback;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

function isMarleyHost(hostname) {
  return hostname === "marleyspoon.com.au" || hostname === "www.marleyspoon.com.au";
}

function parseRecipeUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new ImportError("FAILED", "URL is invalid");
  }
  if (url.protocol !== "https:" || !isMarleyHost(url.hostname)) {
    throw new ImportError("UNSUPPORTED", "URL must be an HTTPS Marley Spoon Australia URL");
  }
  const match = url.pathname.match(/^\/(?:menu|archive)\/(\d+)(?:-|\/|$)/);
  if (!match) {
    throw new ImportError("UNSUPPORTED", "Paste a Marley Spoon recipe detail URL from /menu/ or /archive/");
  }
  url.search = "";
  url.hash = "";
  return { url, recipeId: match[1] };
}

async function request(url, options, label) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        "user-agent": USER_AGENT,
        ...options?.headers
      },
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    throw new ImportError("BLOCKED", label + " request failed: " + error.message);
  }
  if (!response.ok) {
    throw new ImportError("BLOCKED", label + " returned HTTP " + response.status);
  }
  return response;
}

function bootstrapToken(html) {
  const token = html.match(/\bapi_token\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!token) {
    throw new ImportError("FAILED", "Marley Spoon bootstrap token is missing; the page shape may have changed");
  }
  return token;
}

async function extract(url) {
  const pageResponse = await request(
    url.toString(),
    { headers: { accept: "text/html,application/xhtml+xml" } },
    "Marley Spoon page"
  );
  const html = await pageResponse.text();
  const token = bootstrapToken(html);
  const response = await request(
    GRAPHQL_URL,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: "Bearer " + token
      },
      body: JSON.stringify({
        query: RECIPE_QUERY,
        variables: { recipeId: url.pathname.match(/^\/(?:menu|archive)\/(\d+)/)[1] }
      })
    },
    "Marley Spoon recipe API"
  );

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ImportError("FAILED", "Marley Spoon recipe API returned invalid JSON");
  }
  if (body.errors?.length) {
    throw new ImportError("FAILED", "Marley Spoon recipe API rejected the recipe query");
  }
  const recipe = body.data?.recipe;
  if (!recipe) {
    throw new ImportError("FAILED", "Marley Spoon returned no recipe for this URL");
  }

  const pageUrl = canonicalUrl(html, url.toString());
  const nutrition = recipe.nutritionalInformation || [];
  return {
    source: {
      site: "marley-spoon",
      url: pageUrl,
      id: String(recipe.id),
      retrievedAt: new Date().toISOString()
    },
    recipe: {
      title: clean(recipe.title),
      subtitle: clean(recipe.subtitle),
      description: clean(recipe.description),
      servings: null,
      duration: recipe.duration
        ? {
            from: recipe.duration.from,
            to: recipe.duration.to,
            unit: clean(recipe.duration.unit)
          }
        : null,
      difficulty: clean(recipe.difficulty),
      macros: {
        perServing: {
          kcal: perPortion(nutrition, "energy_kcal"),
          protein: perPortion(nutrition, "protein"),
          carbs: perPortion(nutrition, "total_carbs"),
          fat: perPortion(nutrition, "total_fat")
        }
      },
      allergens: (recipe.allergens || []).map((allergen) => clean(allergen.name)).filter(Boolean),
      ingredients: [
        ...(recipe.shippedIngredients || []).map((item) => ({
          text: clean(item.nameWithQuantity || item.name),
          kind: "shipped",
          allergens: (item.allergens || []).map((allergen) => clean(allergen.name)).filter(Boolean)
        })),
        ...(recipe.assumedIngredients || []).map((item) => ({
          text: clean(item.name),
          kind: "assumed",
          allergens: []
        }))
      ].filter((item) => item.text),
      steps: (recipe.steps || [])
        .map((step) => ({ title: clean(step.title), text: clean(step.description) }))
        .filter((step) => step.title || step.text),
      utensils: (recipe.utensils || []).map((item) => clean(item.name)).filter(Boolean),
      images: [metadata(html, "og:image")].filter(Boolean).map((image) => ({ url: image, kind: "hero" }))
    }
  };
}

module.exports = { ImportError, extract, isMarleyHost, parseRecipeUrl };
