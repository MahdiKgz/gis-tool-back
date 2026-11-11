import express from "express";
import {
  accountEmail,
  forgotPassword,
  login,
  logout,
  me,
  refresh,
  register,
  resetPassword,
  sendEmailVerification,
  verifyEmail,
} from "../controllers/auth.controller";
import { authRateLimit } from "../middlewares/auth-rate-limit.middleware";
import { requireAuthentication } from "../middlewares/auth.middleware";

const router = express.Router();

router.post("/register", authRateLimit(5), register);
router.post("/login", authRateLimit(10), login);
router.post("/refresh", authRateLimit(30), refresh);
router.post("/logout", logout);
router.get("/me", requireAuthentication, me);

router.get("/email", requireAuthentication, accountEmail);
router.post("/email", requireAuthentication, authRateLimit(5, 300), sendEmailVerification);
router.post("/email/verify", requireAuthentication, authRateLimit(10), verifyEmail);
router.post("/forgot-password", authRateLimit(5, 300), forgotPassword);
router.post("/reset-password", authRateLimit(10), resetPassword);

export { router };
