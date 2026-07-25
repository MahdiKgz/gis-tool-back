import express, { Application } from "express";
import cors from "cors";
import { router as authRouter } from "./routes/auth.route";
import { globalErrorHandler } from "./middlewares/errorHandler";
import { router as uploadRouter } from "./routes/upload.route";
import { router as healRouter } from "./routes/heal.route";

import "./workers/gis.worker";

const app: Application = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/register", authRouter);

app.use("/upload", uploadRouter);
app.use("/heal", healRouter);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", message: "GIS Backend is running!" });
});

app.use(globalErrorHandler);

export default app;
