import cors from "cors";

export const createCorsMiddleware = (
  configuredOrigins = process.env.CORS_ORIGIN || "http://localhost:5173",
) => {
  const allowedOrigins = new Set(
    configuredOrigins.split(",").map((origin) => origin.trim()).filter(Boolean),
  );
  return cors({
    credentials: true,
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    },
  });
};
