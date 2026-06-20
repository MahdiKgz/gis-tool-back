import { Request, Response } from "express";
import { gisQueue } from "../services/queue.service";

export const uploadGeoJson = async (
  req: Request,
  res: Response,
  next: (err: Error | unknown) => void,
) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "فایلی دریافت نشد." });
      return;
    }

    console.log(`[API] 📥 فایل جی‌آی‌آس ذخیره شد: ${req.file.filename}`);

    const job = await gisQueue.add("clean-gis-file", {
      fileName: req.file.filename,
      originalName: req.file.originalname,
      filePath: req.file.path,
      size: req.file.size,
    });

    console.log(`🚀 [Queue] Job added to queue with ID: ${job.id}`);

    res.status(202).json({
      success: true,
      message: "فایل با موفقیت آپلود شد و در صف پردازش قرار گرفت.",
      data: {
        jobId: job.id,
        originalName: req.file.originalname,
        sizeInBytes: req.file.size,
      },
    });
  } catch (err) {
    next(err);
  }
};
