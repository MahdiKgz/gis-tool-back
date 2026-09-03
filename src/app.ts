import "dotenv/config";
import express, { Application } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import swaggerUi from "swagger-ui-express";
import { router as authRouter } from "./routes/auth.route";
import { globalErrorHandler } from "./middlewares/errorHandler";
import { router as uploadRouter } from "./routes/upload.route";
import { router as healRouter } from "./routes/heal.route";
import { router as fileRouter } from "./routes/file.route";
import { openApiDocument } from "./docs/openapi";
import { AppError } from "./middlewares/errorHandler";

const app: Application = express();

app.set("trust proxy", 1);
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim());
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.includes(origin));
    },
  }),
);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/api/docs.json", (_req, res) => res.json(openApiDocument));
app.use(
  "/api/docs",
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, { customSiteTitle: "SnapGIS API Documentation" }),
);

app.use("/api/auth", authRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/heal", healRouter);
app.use("/api/files", fileRouter);

app.get(["/health", "/api/health"], (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use((_req, _res, next) => next(new AppError(404, "Route not found", "ROUTE_NOT_FOUND")));
app.use(globalErrorHandler);

export default app;
