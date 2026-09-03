import express from "express";
import { login, logout, me, refresh, register } from "../controllers/auth.controller";
import { authRateLimit } from "../middlewares/auth-rate-limit.middleware";
import { requireAuthentication } from "../middlewares/auth.middleware";

const router = express.Router();

router.post("/register", authRateLimit(5), register);
router.post("/login", authRateLimit(10), login);
router.post("/refresh", authRateLimit(30), refresh);
router.post("/logout", logout);
router.get("/me", requireAuthentication, me);

export { router };
