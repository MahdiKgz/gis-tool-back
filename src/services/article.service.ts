import { randomUUID } from "node:crypto";
import { ArticleStatus, Prisma } from "@prisma/client";
import { AppError } from "../middlewares/errorHandler";
import { database } from "./database.service";

const articleSummarySelect = {
  id: true,
  title: true,
  slug: true,
  excerpt: true,
  coverImageUrl: true,
  category: true,
  keywords: true,
  status: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true } },
} as const;

const cleanText = (value: unknown) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
const normalizeKeyword = (value: string) =>
  value.trim().replace(/ي/g, "ی").replace(/ك/g, "ک").toLocaleLowerCase("fa-IR");

const boundedText = (
  value: unknown,
  field: string,
  min: number,
  max: number,
) => {
  const text = cleanText(value);
  if (
    text.length < min ||
    text.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
  )
    throw new AppError(
      400,
      `${field} باید بین ${min} تا ${max} نویسه باشد.`,
      "INVALID_ARTICLE_INPUT",
    );
  return text;
};
const boundedContent = (value: unknown) => {
  const text =
    typeof value === "string" ? value.trim().replace(/\r\n?/g, "\n") : "";
  if (
    text.length < 50 ||
    text.length > 100_000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
  )
    throw new AppError(
      400,
      "متن مقاله باید بین ۵۰ تا ۱۰۰٬۰۰۰ نویسه باشد.",
      "INVALID_ARTICLE_INPUT",
    );
  return text;
};
const parseArticleId = (value: unknown) => {
  const id = cleanText(value);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      id,
    )
  )
    throw new AppError(400, "شناسه مقاله معتبر نیست.", "INVALID_ARTICLE_ID");
  return id;
};
export const createArticleCursor = (article: {
  id: string;
  publishedAt: Date | null;
}) =>
  Buffer.from(
    JSON.stringify({
      id: article.id,
      publishedAt: article.publishedAt?.toISOString(),
    }),
    "utf8",
  ).toString("base64url");
export const parseArticleCursor = (value: unknown) => {
  try {
    const decoded = JSON.parse(
      Buffer.from(cleanText(value), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const id = parseArticleId(decoded.id);
    const publishedAt = new Date(String(decoded.publishedAt));
    if (!Number.isFinite(publishedAt.getTime())) throw new Error();
    return { id, publishedAt };
  } catch (error) {
    if (error instanceof AppError && error.code !== "INVALID_ARTICLE_ID")
      throw error;
    throw new AppError(400, "نشانگر صفحه معتبر نیست.", "INVALID_CURSOR");
  }
};

export const parseArticleInput = (body: unknown) => {
  if (!body || typeof body !== "object")
    throw new AppError(400, "اطلاعات مقاله لازم است.", "INVALID_ARTICLE_INPUT");
  const value = body as Record<string, unknown>;
  const status =
    value.status === "published"
      ? ArticleStatus.published
      : value.status === "draft"
        ? ArticleStatus.draft
        : null;
  if (!status)
    throw new AppError(
      400,
      "وضعیت مقاله معتبر نیست.",
      "INVALID_ARTICLE_STATUS",
    );
  const keywords = Array.isArray(value.keywords)
    ? [
        ...new Set(
          value.keywords
            .filter((item): item is string => typeof item === "string")
            .map(normalizeKeyword)
            .filter(Boolean),
        ),
      ]
    : [];
  if (keywords.length > 12 || keywords.some((item) => item.length > 48))
    throw new AppError(
      400,
      "حداکثر ۱۲ کلمه کلیدی ۴۸ نویسه‌ای مجاز است.",
      "INVALID_KEYWORDS",
    );
  let coverImageUrl: string | null = null;
  if (cleanText(value.coverImageUrl)) {
    try {
      const url = new URL(cleanText(value.coverImageUrl));
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      coverImageUrl = url.toString();
    } catch {
      throw new AppError(
        400,
        "نشانی تصویر شاخص معتبر نیست.",
        "INVALID_COVER_URL",
      );
    }
  }
  return {
    title: boundedText(value.title, "عنوان", 4, 180),
    excerpt: boundedText(value.excerpt, "خلاصه", 20, 360),
    content: boundedContent(value.content),
    category: boundedText(value.category, "دسته‌بندی", 2, 80),
    keywords,
    status,
    coverImageUrl,
  };
};

const requireWriter = async (userId: string) => {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: { roles: true },
  });
  if (!user?.roles.includes("writer"))
    throw new AppError(
      403,
      "این بخش فقط برای نویسندگان است.",
      "WRITER_REQUIRED",
    );
};

const slugBase = (title: string) =>
  title
    .toLocaleLowerCase("fa-IR")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180) || "article";

export const createArticle = async (authorId: string, body: unknown) => {
  await requireWriter(authorId);
  const input = parseArticleInput(body);
  return database.article.create({
    data: {
      ...input,
      authorId,
      slug: `${slugBase(input.title)}-${randomUUID().slice(0, 8)}`,
      publishedAt: input.status === "published" ? new Date() : null,
    },
    select: articleSummarySelect,
  });
};

export const getOwnArticle = async (authorId: string, articleId: string) => {
  await requireWriter(authorId);
  articleId = parseArticleId(articleId);
  const article = await database.article.findFirst({
    where: { id: articleId, authorId },
    include: { author: { select: { id: true, name: true } } },
  });
  if (!article) throw new AppError(404, "مقاله پیدا نشد.", "ARTICLE_NOT_FOUND");
  return article;
};

export const updateArticle = async (
  authorId: string,
  articleId: string,
  body: unknown,
) => {
  await requireWriter(authorId);
  articleId = parseArticleId(articleId);
  const input = parseArticleInput(body);
  const current = await database.article.findFirst({
    where: { id: articleId, authorId },
    select: { status: true },
  });
  if (!current) throw new AppError(404, "مقاله پیدا نشد.", "ARTICLE_NOT_FOUND");
  return database.article.update({
    where: { id: articleId },
    data: {
      ...input,
      ...(input.status === "published"
        ? current.status === "published"
          ? {}
          : { publishedAt: new Date() }
        : { publishedAt: null }),
    },
    select: articleSummarySelect,
  });
};

export const deleteArticle = async (authorId: string, articleId: string) => {
  await requireWriter(authorId);
  articleId = parseArticleId(articleId);
  const result = await database.article.deleteMany({
    where: { id: articleId, authorId },
  });
  if (!result.count)
    throw new AppError(404, "مقاله پیدا نشد.", "ARTICLE_NOT_FOUND");
};

const parseListFilters = (query: Record<string, unknown>) => {
  const search = cleanText(query.search);
  const category = cleanText(query.category);
  const keyword = normalizeKeyword(cleanText(query.keyword));
  if (search.length > 100 || category.length > 80 || keyword.length > 48)
    throw new AppError(
      400,
      "فیلترهای مقاله معتبر نیستند.",
      "INVALID_ARTICLE_FILTERS",
    );
  return { search, category, keyword };
};

export const listOwnArticles = async (
  authorId: string,
  query: Record<string, unknown>,
) => {
  await requireWriter(authorId);
  const { search, category, keyword } = parseListFilters(query);
  const status =
    query.status === "draft" || query.status === "published"
      ? query.status
      : undefined;
  if (query.status && !status)
    throw new AppError(
      400,
      "فیلتر وضعیت معتبر نیست.",
      "INVALID_ARTICLE_STATUS",
    );
  const skip = query.skip === undefined ? 0 : Number(query.skip);
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if (
    !Number.isSafeInteger(skip) ||
    skip < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new AppError(400, "صفحه‌بندی معتبر نیست.", "INVALID_PAGINATION");
  const where: Prisma.ArticleWhereInput = {
    authorId,
    ...(status ? { status } : {}),
    ...(category
      ? { category: { equals: category, mode: "insensitive" } }
      : {}),
    ...(keyword ? { keywords: { has: keyword } } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { excerpt: { contains: search, mode: "insensitive" } },
            { keywords: { has: normalizeKeyword(search) } },
          ],
        }
      : {}),
  };
  const [items, total] = await database.$transaction([
    database.article.findMany({
      where,
      select: articleSummarySelect,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip,
      take: limit,
    }),
    database.article.count({ where }),
  ]);
  return {
    items,
    pagination: { skip, limit, total, hasMore: skip + items.length < total },
  };
};

export const listPublishedArticles = async (query: Record<string, unknown>) => {
  const { search, category, keyword } = parseListFilters(query);
  const limit = query.limit === undefined ? 8 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24)
    throw new AppError(400, "اندازه صفحه معتبر نیست.", "INVALID_PAGINATION");
  let cursorFilter: Prisma.ArticleWhereInput = {};
  if (query.cursor) {
    const cursor = parseArticleCursor(query.cursor);
    cursorFilter = {
      OR: [
        { publishedAt: { lt: cursor.publishedAt } },
        { publishedAt: cursor.publishedAt, id: { lt: cursor.id } },
      ],
    };
  }
  const where: Prisma.ArticleWhereInput = {
    status: "published",
    publishedAt: { not: null },
    ...(Object.keys(cursorFilter).length ? { AND: [cursorFilter] } : {}),
    ...(category
      ? { category: { equals: category, mode: "insensitive" } }
      : {}),
    ...(keyword ? { keywords: { has: keyword } } : {}),
    ...(search
      ? {
          AND: [
            cursorFilter,
            {
              OR: [
                { title: { contains: search, mode: "insensitive" } },
                { excerpt: { contains: search, mode: "insensitive" } },
                { keywords: { has: normalizeKeyword(search) } },
              ],
            },
          ],
        }
      : {}),
  };
  const items = await database.article.findMany({
    where,
    select: articleSummarySelect,
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return {
    items: page,
    nextCursor: hasMore ? createArticleCursor(page.at(-1)!) : null,
  };
};

export const listPublishedCategories = async () => {
  const groups = await database.article.groupBy({
    by: ["category"],
    where: { status: "published" },
    _count: { _all: true },
    orderBy: { category: "asc" },
  });
  return groups.map((group) => ({
    name: group.category,
    count: group._count._all,
  }));
};

export const getPublishedArticle = async (slug: string) => {
  if (!slug || slug.length > 220)
    throw new AppError(404, "مقاله پیدا نشد.", "ARTICLE_NOT_FOUND");
  const article = await database.article.findFirst({
    where: { slug, status: "published" },
    include: { author: { select: { id: true, name: true } } },
  });
  if (!article) throw new AppError(404, "مقاله پیدا نشد.", "ARTICLE_NOT_FOUND");
  return article;
};
