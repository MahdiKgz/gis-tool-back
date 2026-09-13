const auth = [{ bearerAuth: [] }];
const articleBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: [
          "title",
          "excerpt",
          "content",
          "category",
          "keywords",
          "status",
        ],
        properties: {
          title: { type: "string", minLength: 4, maxLength: 180 },
          excerpt: { type: "string", minLength: 20, maxLength: 360 },
          content: { type: "string", minLength: 50, maxLength: 100000 },
          category: { type: "string", minLength: 2, maxLength: 80 },
          keywords: {
            type: "array",
            maxItems: 12,
            items: { type: "string", maxLength: 48 },
          },
          status: { type: "string", enum: ["draft", "published"] },
          coverImageUrl: { type: "string", format: "uri", nullable: true },
        },
      },
    },
  },
};
export const articlePaths = {
  "/articles": {
    get: {
      tags: ["Articles"],
      summary: "Infinite published article feed",
      parameters: [
        {
          name: "cursor",
          in: "query",
          schema: { type: "string" },
          description: "Opaque nextCursor returned by the previous page",
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 24 },
        },
        ...["search", "category", "keyword"].map((name) => ({
          name,
          in: "query",
          schema: { type: "string" },
        })),
      ],
      responses: {
        "200": { description: "Published items and nextCursor" },
        "400": { description: "Invalid filters or cursor" },
      },
    },
  },
  "/articles/categories": {
    get: {
      tags: ["Articles"],
      summary: "Published article categories and counts",
      responses: { "200": { description: "Category counts" } },
    },
  },
  "/articles/{slug}": {
    get: {
      tags: ["Articles"],
      summary: "Published article detail",
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": { description: "Published article" },
        "404": { description: "Article not found" },
      },
    },
  },
  "/articles/writer/mine": {
    get: {
      tags: ["Articles"],
      summary: "Writer-owned paginated articles",
      security: auth,
      responses: {
        "200": { description: "Own drafts and published articles" },
        "403": { description: "Writer role required" },
      },
    },
    post: {
      tags: ["Articles"],
      summary: "Create an article",
      security: auth,
      requestBody: articleBody,
      responses: {
        "201": { description: "Article created" },
        "403": { description: "Writer role required" },
      },
    },
  },
  "/articles/writer/mine/{articleId}": {
    get: {
      tags: ["Articles"],
      summary: "Load own article for editing",
      security: auth,
      responses: { "200": { description: "Complete own article" } },
    },
    put: {
      tags: ["Articles"],
      summary: "Update or publish own article",
      security: auth,
      requestBody: articleBody,
      responses: { "200": { description: "Article updated" } },
    },
    delete: {
      tags: ["Articles"],
      summary: "Delete own article",
      security: auth,
      responses: { "200": { description: "Article deleted" } },
    },
  },
};
