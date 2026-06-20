import express, { Request, Response } from "express";

const router = express.Router();

router.route("/").get((req: Request, res: Response) => {
  return res.json({ message: "yes baby it works" });
});

export { router };
