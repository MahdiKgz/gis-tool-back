import express, { NextFunction, Request, Response } from "express";
import {
  getAuthenticatedUserId,
  requireAuthentication,
} from "../middlewares/auth.middleware";
import * as articles from "../services/article.service";

const router = express.Router();
const handle =
  (operation: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await operation(req) });
    } catch (error) {
      next(error);
    }
  };

router.get(
  "/",
  handle((req) => articles.listPublishedArticles(req.query)),
);
router.get(
  "/categories",
  handle(() => articles.listPublishedCategories()),
);
router.get(
  "/:slug",
  handle((req) => articles.getPublishedArticle(String(req.params.slug))),
);
router.use(requireAuthentication);
router.get(
  "/writer/mine",
  handle((req) =>
    articles.listOwnArticles(getAuthenticatedUserId(req), req.query),
  ),
);
router.get(
  "/writer/mine/:articleId",
  handle((req) =>
    articles.getOwnArticle(
      getAuthenticatedUserId(req),
      String(req.params.articleId),
    ),
  ),
);
router.post(
  "/writer/mine",
  handle(
    (req) => articles.createArticle(getAuthenticatedUserId(req), req.body),
    201,
  ),
);
router.put(
  "/writer/mine/:articleId",
  handle((req) =>
    articles.updateArticle(
      getAuthenticatedUserId(req),
      String(req.params.articleId),
      req.body,
    ),
  ),
);
router.delete(
  "/writer/mine/:articleId",
  handle(async (req) => {
    await articles.deleteArticle(
      getAuthenticatedUserId(req),
      String(req.params.articleId),
    );
    return null;
  }),
);

export { router };
