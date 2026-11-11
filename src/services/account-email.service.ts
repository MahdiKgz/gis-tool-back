import nodemailer from "nodemailer";
import { AppError } from "../middlewares/errorHandler";

const mailUnavailable = () =>
  new AppError(503, "Account email is temporarily unavailable", "ACCOUNT_EMAIL_UNAVAILABLE");

export const getAccountMailer = () => {
  const { APP_PUBLIC_ORIGIN, SMTP_URL, SMTP_FROM, NODE_ENV } = process.env;
  if (!APP_PUBLIC_ORIGIN || !SMTP_URL || !SMTP_FROM) throw mailUnavailable();

  let origin: URL;
  let smtp: URL;
  let username: string;
  let password: string;
  try {
    origin = new URL(APP_PUBLIC_ORIGIN);
    smtp = new URL(SMTP_URL);
    username = decodeURIComponent(smtp.username);
    password = decodeURIComponent(smtp.password);
  } catch {
    throw mailUnavailable();
  }
  const production = NODE_ENV === "production";
  if (
    !(origin.protocol === "https:" || (!production && origin.protocol === "http:")) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !["smtp:", "smtps:"].includes(smtp.protocol) ||
    !smtp.hostname
  ) {
    throw mailUnavailable();
  }

  const localRelay = !production && ["localhost", "127.0.0.1", "[::1]"].includes(smtp.hostname);
  const transport = nodemailer.createTransport({
    host: smtp.hostname.replace(/^\[|\]$/g, ""),
    port: smtp.port ? Number(smtp.port) : smtp.protocol === "smtps:" ? 465 : 587,
    secure: smtp.protocol === "smtps:",
    requireTLS: !localRelay,
    auth: username ? { user: username, pass: password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  return async (to: string, purpose: "verify" | "reset", token: string, minutes: number) => {
    const path = purpose === "verify" ? "/dashboard/security" : "/auth/reset";
    const link = new URL(path, origin);
    link.hash = new URLSearchParams({ token }).toString();
    const subject = purpose === "verify" ? "تأیید ایمیل حساب SnapGIS" : "بازیابی رمز عبور SnapGIS";
    const action = purpose === "verify" ? "ایمیل حساب خود را تأیید کنید" : "رمز عبور جدیدی انتخاب کنید";
    try {
      await transport.sendMail({
        from: SMTP_FROM,
        to: { name: "", address: to },
        subject,
        text: `${action}. این لینک یک‌بارمصرف است و تا ${minutes.toLocaleString("fa-IR")} دقیقه اعتبار دارد.\n\n${link.href}\n\nاگر این درخواست را ثبت نکرده‌اید، می‌توانید این ایمیل را نادیده بگیرید.`,
      });
    } catch {
      throw mailUnavailable();
    }
  };
};
