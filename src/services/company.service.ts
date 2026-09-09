import type { Prisma } from "@prisma/client";
import { database } from "./database.service";
import { AppError } from "../middlewares/errorHandler";
import { normalizePhone } from "./auth.service";
import { parsePlanCode, planByCode } from "./business-plan.service";

type Client = Prisma.TransactionClient;
const publicPerson = {
  id: true,
  name: true,
  phone: true,
  createdAt: true,
} as const;
const companyInclude = {
  owner: { select: { ...publicPerson, planCode: true } },
} as const;
const INVITATION_DAYS = 7;
export const parseBusinessId = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new AppError(400, "شناسه معتبر نیست.", "INVALID_ID");
  return value;
};
export const parseColleaguePhone = (value: unknown) => {
  const phone = typeof value === "string" ? normalizePhone(value) : "";
  if (!/^09\d{9}$/.test(phone))
    throw new AppError(
      400,
      "شماره تلفن همراه معتبر وارد کنید.",
      "INVALID_PHONE",
    );
  return phone;
};
export const parseCompanyName = (value: unknown) => {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 2 || name.length > 150 || /[\x00-\x1f\x7f]/.test(name))
    throw new AppError(
      400,
      "نام شرکت باید بین ۲ تا ۱۵۰ نویسه باشد.",
      "INVALID_COMPANY_NAME",
    );
  return name;
};
const requireAdmin = async (tx: Client, actorId: string) => {
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    select: { roles: true },
  });
  if (!actor?.roles.includes("admin"))
    throw new AppError(
      403,
      "این بخش فقط برای مدیر سامانه است.",
      "ADMIN_REQUIRED",
    );
};
const lockUser = async (tx: Client, id: string) => {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
};
const lockCompany = async (tx: Client, id: string) => {
  await tx.$queryRaw`SELECT id FROM companies WHERE id = ${id}::uuid FOR UPDATE`;
};
const ownedCompany = async (tx: Client, ownerId: string, active = true) => {
  const company = await tx.company.findUnique({
    where: { ownerId },
    include: companyInclude,
  });
  if (!company)
    throw new AppError(
      403,
      "این قابلیت به پلن شرکتی نیاز دارد.",
      "COMPANY_PLAN_REQUIRED",
    );
  if (active && company.owner.planCode !== "advanced")
    throw new AppError(403, "پلن شرکتی فعال نیست.", "COMPANY_PLAN_REQUIRED");
  return company;
};
const memberCandidate = async (
  tx: Client,
  companyId: string,
  userId: string,
) => {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      ...publicPerson,
      ownedCompany: { select: { id: true } },
      companyMembership: { select: { companyId: true } },
    },
  });
  if (!user)
    throw new AppError(
      404,
      "کاربری با این شماره ثبت‌نام نکرده است.",
      "COLLEAGUE_NOT_FOUND",
    );
  if (user.ownedCompany)
    throw new AppError(
      409,
      "این کاربر مدیر یک شرکت است.",
      "COLLEAGUE_IS_OWNER",
    );
  if (user.companyMembership)
    throw new AppError(
      409,
      user.companyMembership.companyId === companyId
        ? "این همکار قبلاً اضافه شده است."
        : "این کاربر عضو شرکت دیگری است.",
      "COLLEAGUE_ALREADY_MEMBER",
    );
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    createdAt: user.createdAt,
  };
};
const reservedSeats = async (tx: Client, companyId: string) => {
  const [members, invitations] = await Promise.all([
    tx.companyMember.count({ where: { companyId } }),
    tx.companyInvitation.count({
      where: { companyId, status: "pending", expiresAt: { gt: new Date() } },
    }),
  ]);
  return { members, invitations, total: members + invitations };
};

export const assignUserPlan = async (
  actorId: string,
  userId: string,
  value: unknown,
) => {
  const planCode = parsePlanCode(value);
  return database.$transaction(async (tx) => {
    await requireAdmin(tx, actorId);
    const existingCompany = await tx.company.findUnique({
      where: { ownerId: userId },
      select: { id: true },
    });
    if (existingCompany) await lockCompany(tx, existingCompany.id);
    await lockUser(tx, userId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { companyMembership: true },
    });
    if (!user) throw new AppError(404, "کاربر پیدا نشد.", "USER_NOT_FOUND");
    if (planCode === "advanced" && user.companyMembership)
      throw new AppError(
        409,
        "کاربر ابتدا باید از شرکت فعلی خارج شود.",
        "COLLEAGUE_ALREADY_MEMBER",
      );
    if (planCode === "advanced")
      await tx.company.upsert({
        where: { ownerId: userId },
        create: { ownerId: userId, name: `شرکت ${user.name}` },
        update: {},
      });
    if (user.planCode !== planCode) {
      await tx.user.update({ where: { id: userId }, data: { planCode } });
      await tx.planAssignment.create({
        data: {
          userId,
          actorId,
          previousPlan: user.planCode,
          nextPlan: planCode,
        },
      });
    }
    return { ...planByCode(planCode), userId };
  });
};
export const listPlanUsers = async (
  actorId: string,
  query: { search?: unknown; plan?: unknown; skip?: unknown; limit?: unknown },
) => {
  await requireAdmin(database, actorId);
  const search = typeof query.search === "string" ? query.search.trim() : "";
  if (search.length > 100)
    throw new AppError(
      400,
      "عبارت جست‌وجو بیش از حد طولانی است.",
      "INVALID_SEARCH",
    );
  const skip = query.skip === undefined ? 0 : Number(query.skip);
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if (
    !Number.isSafeInteger(skip) ||
    skip < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new AppError(400, "صفحه‌بندی معتبر نیست.", "INVALID_PAGINATION");
  const where: Prisma.UserWhereInput = {
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            ...(normalizePhone(search)
              ? [{ phone: { contains: normalizePhone(search) } }]
              : []),
          ],
        }
      : {}),
    ...(query.plan ? { planCode: parsePlanCode(query.plan) } : {}),
  };
  const [items, total] = await database.$transaction([
    database.user.findMany({
      where,
      select: { ...publicPerson, planCode: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip,
      take: limit,
    }),
    database.user.count({ where }),
  ]);
  return {
    items: items.map((user) => ({ ...user, plan: planByCode(user.planCode) })),
    pagination: { skip, limit, total },
  };
};
export const getBusinessContext = async (userId: string) => {
  const user = await database.user.findUnique({
    where: { id: userId },
    include: {
      ownedCompany: { include: companyInclude },
      companyMembership: { include: { company: { include: companyInclude } } },
    },
  });
  if (!user) throw new AppError(401, "کاربر پیدا نشد.", "USER_NOT_FOUND");
  const company = user.ownedCompany ?? user.companyMembership?.company;
  const active = company?.owner.planCode === "advanced";
  const invitations = await database.companyInvitation.findMany({
    where: {
      userId,
      status: "pending",
      expiresAt: { gt: new Date() },
      company: { owner: { planCode: "advanced" } },
    },
    include: {
      company: { select: { name: true, owner: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return {
    plan: planByCode(user.planCode),
    effectivePlan: planByCode(active ? "advanced" : user.planCode),
    company: company
      ? {
          id: company.id,
          name: company.name,
          role: company.ownerId === userId ? "owner" : "member",
          active,
          joinedAt: user.companyMembership?.joinedAt ?? company.createdAt,
        }
      : null,
    invitations: invitations.map((invite) => ({
      id: invite.id,
      companyName: invite.company.name,
      managerName: invite.company.owner.name,
      expiresAt: invite.expiresAt,
    })),
  };
};
export const lookupColleague = async (ownerId: string, value: unknown) => {
  const phone = parseColleaguePhone(value);
  const company = await ownedCompany(database, ownerId);
  const user = await database.user.findUnique({
    where: { phone },
    select: { id: true },
  });
  if (!user)
    throw new AppError(
      404,
      "کاربری با این شماره ثبت‌نام نکرده است.",
      "COLLEAGUE_NOT_FOUND",
    );
  return memberCandidate(database, company.id, user.id);
};
export const addColleague = async (
  ownerId: string,
  userId: string,
  mode: unknown,
) => {
  if (mode !== "direct" && mode !== "invite")
    throw new AppError(
      400,
      "روش افزودن همکار معتبر نیست.",
      "INVALID_MEMBER_MODE",
    );
  return database.$transaction(async (tx) => {
    const initial = await ownedCompany(tx, ownerId);
    await lockCompany(tx, initial.id);
    const company = await ownedCompany(tx, ownerId);
    await lockUser(tx, userId);
    await memberCandidate(tx, company.id, userId);
    const pending = await tx.companyInvitation.findFirst({
      where: {
        companyId: company.id,
        userId,
        status: "pending",
        expiresAt: { gt: new Date() },
      },
    });
    if (pending)
      throw new AppError(
        409,
        "دعوت این همکار هنوز در انتظار پاسخ است.",
        "INVITATION_ALREADY_PENDING",
      );
    if (
      (await reservedSeats(tx, company.id)).total >=
      planByCode("advanced").employeeLimit
    )
      throw new AppError(
        409,
        "ظرفیت سه همکار تکمیل است؛ دعوت‌های در انتظار نیز ظرفیت رزرو می‌کنند.",
        "COMPANY_SEATS_FULL",
      );
    if (mode === "direct") {
      const member = await tx.companyMember.create({
        data: { companyId: company.id, userId },
      });
      await tx.companyInvitation.updateMany({
        where: { userId, status: "pending" },
        data: { status: "revoked", respondedAt: new Date() },
      });
      return { mode, id: member.id };
    }
    const invitation = await tx.companyInvitation.create({
      data: {
        companyId: company.id,
        userId,
        expiresAt: new Date(Date.now() + INVITATION_DAYS * 86400000),
      },
    });
    return { mode, id: invitation.id };
  });
};
export const respondToInvitation = async (
  userId: string,
  invitationId: string,
  action: unknown,
) => {
  if (action !== "accept" && action !== "decline")
    throw new AppError(
      400,
      "پاسخ دعوت معتبر نیست.",
      "INVALID_INVITATION_ACTION",
    );
  return database.$transaction(async (tx) => {
    const initial = await tx.companyInvitation.findFirst({
      where: { id: invitationId, userId },
    });
    if (!initial)
      throw new AppError(404, "دعوت پیدا نشد.", "INVITATION_NOT_FOUND");
    await lockCompany(tx, initial.companyId);
    await lockUser(tx, userId);
    const invite = await tx.companyInvitation.findUnique({
      where: { id: invitationId },
      include: { company: { include: companyInclude } },
    });
    if (!invite || invite.status !== "pending")
      throw new AppError(
        409,
        "این دعوت قبلاً پاسخ داده شده است.",
        "INVITATION_NOT_PENDING",
      );
    if (invite.expiresAt <= new Date())
      throw new AppError(410, "دعوت منقضی شده است.", "INVITATION_EXPIRED");
    if (action === "accept") {
      if (invite.company.owner.planCode !== "advanced")
        throw new AppError(
          403,
          "پلن شرکتی فعال نیست.",
          "COMPANY_PLAN_REQUIRED",
        );
      await memberCandidate(tx, invite.companyId, userId);
      if ((await reservedSeats(tx, invite.companyId)).members >= 3)
        throw new AppError(409, "ظرفیت شرکت تکمیل است.", "COMPANY_SEATS_FULL");
      await tx.companyMember.create({
        data: { companyId: invite.companyId, userId },
      });
    }
    await tx.companyInvitation.update({
      where: { id: invitationId },
      data: {
        status: action === "accept" ? "accepted" : "declined",
        respondedAt: new Date(),
      },
    });
    if (action === "accept")
      await tx.companyInvitation.updateMany({
        where: { userId, status: "pending" },
        data: { status: "revoked", respondedAt: new Date() },
      });
    return { accepted: action === "accept" };
  });
};
export const revokeCompanyInvitation = async (ownerId: string, id: string) =>
  database.$transaction(async (tx) => {
    const company = await ownedCompany(tx, ownerId, false);
    await lockCompany(tx, company.id);
    const result = await tx.companyInvitation.updateMany({
      where: { id, companyId: company.id, status: "pending" },
      data: { status: "revoked", respondedAt: new Date() },
    });
    if (!result.count)
      throw new AppError(404, "دعوت پیدا نشد.", "INVITATION_NOT_FOUND");
  });
export const removeCompanyMember = async (actorId: string, userId: string) =>
  database.$transaction(async (tx) => {
    const member = await tx.companyMember.findUnique({
      where: { userId },
      include: { company: true },
    });
    if (!member || (actorId !== userId && member.company.ownerId !== actorId))
      throw new AppError(404, "همکار پیدا نشد.", "MEMBER_NOT_FOUND");
    await lockCompany(tx, member.companyId);
    await lockUser(tx, userId);
    // Match the observed company as well: never remove a membership created elsewhere meanwhile.
    await tx.companyMember.deleteMany({
      where: { userId, companyId: member.companyId },
    });
  });
export const renameCompany = async (ownerId: string, value: unknown) => {
  const company = await ownedCompany(database, ownerId, false);
  return database.company.update({
    where: { id: company.id },
    data: { name: parseCompanyName(value) },
    select: { id: true, name: true },
  });
};
const aggregateUsage = async (companyId: string, userId?: string) => {
  const aggregate = await database.uploadActivity.aggregate({
    where: { companyId, ...(userId ? { userId } : {}) },
    _count: { _all: true },
    _sum: { sizeInBytes: true, identifiedIssues: true, healedIssues: true },
  });
  return {
    uploads: aggregate._count._all,
    bytes: aggregate._sum.sizeInBytes ?? 0,
    identifiedIssues: aggregate._sum.identifiedIssues ?? 0,
    healedIssues: aggregate._sum.healedIssues ?? 0,
  };
};
export const getCompanyDashboard = async (ownerId: string) => {
  const company = await ownedCompany(database, ownerId, false);
  const [members, invitations, seats, usage, storedFiles] = await Promise.all([
    database.companyMember.findMany({
      where: { companyId: company.id },
      include: { user: { select: publicPerson } },
      orderBy: { joinedAt: "asc" },
    }),
    database.companyInvitation.findMany({
      where: {
        companyId: company.id,
        status: "pending",
        expiresAt: { gt: new Date() },
      },
      include: { user: { select: publicPerson } },
      orderBy: { createdAt: "desc" },
    }),
    reservedSeats(database, company.id),
    aggregateUsage(company.id),
    database.uploadActivity.count({
      where: { companyId: company.id, deletedAt: null },
    }),
  ]);
  const people = [
    { user: company.owner, role: "owner", joinedAt: company.createdAt },
    ...members.map((member) => ({
      user: member.user,
      role: "member",
      joinedAt: member.joinedAt,
    })),
  ];
  return {
    id: company.id,
    name: company.name,
    active: company.owner.planCode === "advanced",
    seats: { ...seats, limit: 3 },
    usage: { ...usage, storedFiles },
    members: await Promise.all(
      people.map(async (person) => ({
        id: person.user.id,
        name: person.user.name,
        phone: person.user.phone,
        role: person.role,
        joinedAt: person.joinedAt,
        usage: await aggregateUsage(company.id, person.user.id),
      })),
    ),
    invitations: invitations.map((invite) => ({
      id: invite.id,
      user: invite.user,
      expiresAt: invite.expiresAt,
    })),
  };
};

// At upload persistence time, attribution is immutable; personal history is never backfilled to a company.
export const activityCompanyId = async (tx: Client, userId: string) => {
  const owned = await tx.company.findUnique({
    where: { ownerId: userId },
    include: companyInclude,
  });
  if (owned?.owner.planCode === "advanced") return owned.id;
  const member = await tx.companyMember.findUnique({
    where: { userId },
    include: { company: { include: companyInclude } },
  });
  return member?.company.owner.planCode === "advanced"
    ? member.companyId
    : null;
};
