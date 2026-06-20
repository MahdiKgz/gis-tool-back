import { Request, Response } from "express";

export const uploadGeoJson = async (
  req: Request,
  res: Response,
  next: (err: Error | unknown) => void,
) => {
  try {
    console.log(req.file);
  } catch (err) {
    next(err);
  }
};
