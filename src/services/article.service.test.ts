import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../middlewares/errorHandler";
import {
  createArticleCursor,
  parseArticleCursor,
  parseArticleInput,
} from "./article.service";

const valid = {
  title: " راهنمای کنترل توپولوژی ",
  excerpt: "خلاصه‌ای کاربردی برای کنترل کیفیت داده‌های مکانی است.",
  content:
    "این متن مقاله است و برای عبور از حداقل طول، توضیحات کافی درباره داده‌های مکانی دارد.",
  category: "آموزش GIS",
  keywords: [" GIS ", "gis", "توپولوژي", "توپولوژی"],
  status: "published",
  coverImageUrl: "https://example.com/cover.jpg",
};

test("normalizes article keywords as distinct filterable values", () => {
  const parsed = parseArticleInput(valid);
  assert.deepEqual(parsed.keywords, ["gis", "توپولوژی"]);
  assert.equal(parsed.title, "راهنمای کنترل توپولوژی");
  assert.equal(parsed.status, "published");
});

test("accepts drafts without a cover image", () => {
  const parsed = parseArticleInput({
    ...valid,
    status: "draft",
    coverImageUrl: "",
  });
  assert.equal(parsed.coverImageUrl, null);
  assert.equal(parsed.status, "draft");
});

test("preserves paragraph breaks in article content", () => {
  const content = `${valid.content}\n\nپاراگراف دوم برای نمایش خواناتر متن.`;
  assert.equal(parseArticleInput({ ...valid, content }).content, content);
});

test("round-trips an opaque stable article cursor and rejects malformed input", () => {
  const boundary = {
    id: "6c2d5ee6-9852-4ddd-86db-f62582ef93de",
    publishedAt: new Date("2026-09-13T10:00:00.000Z"),
  };
  assert.deepEqual(parseArticleCursor(createArticleCursor(boundary)), boundary);
  assert.throws(
    () => parseArticleCursor("not-a-cursor"),
    (error: AppError) => error.code === "INVALID_CURSOR",
  );
});

for (const body of [
  { ...valid, status: "hidden" },
  {
    ...valid,
    keywords: Array.from({ length: 13 }, (_, index) => `keyword-${index}`),
  },
  { ...valid, coverImageUrl: "javascript:alert(1)" },
  { ...valid, content: "کوتاه" },
]) {
  test("rejects invalid article input", () => {
    assert.throws(() => parseArticleInput(body), AppError);
  });
}
