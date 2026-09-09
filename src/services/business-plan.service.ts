import type { PlanCode } from "@prisma/client";
import { AppError } from "../middlewares/errorHandler";
import { database } from "./database.service";

export const PLANS = [
  {
    code: "starter",
    name: "پایه (استارتاپ)",
    monthlyPrice: 490000,
    annualMonthlyPrice: 390000,
    employeeLimit: 0,
    isCompany: false,
  },
  {
    code: "pro",
    name: "حرفه‌ای (Pro)",
    monthlyPrice: 990000,
    annualMonthlyPrice: 790000,
    employeeLimit: 0,
    isCompany: false,
  },
  {
    code: "advanced",
    name: "شرکتی GIS (پیشرفته)",
    monthlyPrice: 1990000,
    annualMonthlyPrice: 1590000,
    employeeLimit: 3,
    isCompany: true,
  },
] as const;
export const planByCode = (code: PlanCode) =>
  PLANS.find((plan) => plan.code === code)!;
export const parsePlanCode = (value: unknown): PlanCode => {
  if (!PLANS.some((plan) => plan.code === value))
    throw new AppError(400, "پلن انتخاب‌شده معتبر نیست.", "INVALID_PLAN");
  return value as PlanCode;
};
export const getUserPlan = async (userId: string) => {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: { planCode: true },
  });
  if (!user) throw new AppError(401, "کاربر پیدا نشد.", "USER_NOT_FOUND");
  return { ...planByCode(user.planCode), expiresAt: null, remainingDays: null };
};
