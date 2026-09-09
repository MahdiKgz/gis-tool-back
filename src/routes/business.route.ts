import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  getAuthenticatedUserId,
  requireAuthentication,
} from "../middlewares/auth.middleware";
import { authRateLimit } from "../middlewares/auth-rate-limit.middleware";
import { PLANS } from "../services/business-plan.service";
import * as company from "../services/company.service";

const router = express.Router();
const handle =
  (operation: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await operation(req);
      res.setHeader("Cache-Control", "no-store");
      res.status(status).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
router.get("/plans", (_req, res) => res.json({ success: true, data: PLANS }));
router.use(requireAuthentication);
router.get(
  "/me",
  handle((req) => company.getBusinessContext(getAuthenticatedUserId(req))),
);
router.get(
  "/admin/users",
  handle((req) =>
    company.listPlanUsers(getAuthenticatedUserId(req), req.query),
  ),
);
router.patch(
  "/admin/users/:userId/plan",
  handle((req) =>
    company.assignUserPlan(
      getAuthenticatedUserId(req),
      company.parseBusinessId(req.params.userId),
      req.body?.planCode,
    ),
  ),
);
router.get(
  "/company",
  handle((req) => company.getCompanyDashboard(getAuthenticatedUserId(req))),
);
router.patch(
  "/company",
  handle((req) =>
    company.renameCompany(getAuthenticatedUserId(req), req.body?.name),
  ),
);
router.post(
  "/company/lookup",
  authRateLimit(20),
  handle((req) =>
    company.lookupColleague(getAuthenticatedUserId(req), req.body?.phone),
  ),
);
router.post(
  "/company/members",
  handle(
    (req) =>
      company.addColleague(
        getAuthenticatedUserId(req),
        company.parseBusinessId(req.body?.userId),
        req.body?.mode,
      ),
    201,
  ),
);
router.delete(
  "/company/members/:userId",
  handle((req) =>
    company.removeCompanyMember(
      getAuthenticatedUserId(req),
      company.parseBusinessId(req.params.userId),
    ),
  ),
);
router.delete(
  "/company/invitations/:invitationId",
  handle((req) =>
    company.revokeCompanyInvitation(
      getAuthenticatedUserId(req),
      company.parseBusinessId(req.params.invitationId),
    ),
  ),
);
router.post(
  "/invitations/:invitationId/respond",
  handle((req) =>
    company.respondToInvitation(
      getAuthenticatedUserId(req),
      company.parseBusinessId(req.params.invitationId),
      req.body?.action,
    ),
  ),
);
export { router };
