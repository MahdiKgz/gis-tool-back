import { AppError } from "../middlewares/errorHandler";
import { normalizePhone } from "./auth.service";

export const parseAdminProfile = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AppError(
      400,
      "اطلاعات کاربر معتبر نیست.",
      "INVALID_REQUEST_BODY",
    );
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "name" && key !== "phone"))
    throw new AppError(
      400,
      "فقط نام و شماره همراه قابل ویرایش است.",
      "INVALID_PROFILE_FIELDS",
    );
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const phone =
    typeof input.phone === "string" ? normalizePhone(input.phone) : "";
  if (name.length < 2 || name.length > 100 || /[\x00-\x1f\x7f]/.test(name))
    throw new AppError(
      400,
      "نام باید بین ۲ تا ۱۰۰ نویسه باشد.",
      "INVALID_NAME",
    );
  if (!/^09\d{9}$/.test(phone))
    throw new AppError(400, "شماره همراه معتبر وارد کنید.", "INVALID_PHONE");
  return { name, phone };
};

const DAY = 86400000;
export const parseReportRange = (
  query: { from?: unknown; to?: unknown },
  now = new Date(),
) => {
  const parse = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new AppError(
        400,
        "بازهٔ تاریخ معتبر نیست.",
        "INVALID_REPORT_RANGE",
      );
    const result = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isFinite(result.getTime()) ||
      result.toISOString().slice(0, 10) !== value
    )
      throw new AppError(
        400,
        "بازهٔ تاریخ معتبر نیست.",
        "INVALID_REPORT_RANGE",
      );
    return result;
  };
  const end =
    query.to === undefined
      ? parse(now.toISOString().slice(0, 10))
      : parse(query.to);
  const start =
    query.from === undefined
      ? new Date(end.getTime() - 29 * DAY)
      : parse(query.from);
  const days = (end.getTime() - start.getTime()) / DAY + 1;
  if (days < 1 || days > 366)
    throw new AppError(
      400,
      "بازهٔ گزارش باید بین ۱ تا ۳۶۶ روز باشد.",
      "INVALID_REPORT_RANGE",
    );
  return {
    start,
    endExclusive: new Date(end.getTime() + DAY),
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    days,
  };
};
