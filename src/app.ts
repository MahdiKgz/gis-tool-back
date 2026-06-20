import express, { Application } from "express";
import cors from "cors";
import { router as authRouter } from "./routes/auth.route";

const app: Application = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/register", authRouter);

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", message: "GIS Backend is running!" });
});

export default app;
