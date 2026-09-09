const security = [{ bearerAuth: [] }];
const responses = {
  "200": { description: "Success envelope: { success: true, data }" },
  "400": { description: "Invalid input" },
  "401": { description: "Authentication required" },
  "403": { description: "Admin or active company-owner permission required" },
  "404": { description: "Resource not found or not owned" },
  "409": { description: "Capacity, membership or invitation conflict" },
};
const id = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
});
const body = (properties: object, required: string[]) => ({
  required: true,
  content: {
    "application/json": { schema: { type: "object", required, properties } },
  },
});
const operation = (summary: string) => ({
  tags: ["Business"],
  summary,
  security,
  responses,
});
export const businessPaths = {
  "/business/plans": {
    get: {
      ...operation(
        "Public catalog: starter, pro and advanced (company, manager + 3 employees)",
      ),
      security: [],
    },
  },
  "/business/me": {
    get: operation(
      "Own personal/effective plan, company role and active incoming invitations",
    ),
  },
  "/business/admin/users": {
    get: {
      ...operation("Admin: search and filter accounts by assigned plan"),
      parameters: [
        {
          name: "search",
          in: "query",
          schema: { type: "string", maxLength: 100 },
        },
        {
          name: "plan",
          in: "query",
          schema: { type: "string", enum: ["starter", "pro", "advanced"] },
        },
        {
          name: "skip",
          in: "query",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      ],
    },
  },
  "/business/admin/users/{userId}/plan": {
    patch: {
      ...operation(
        "Admin: assign a plan and record the change in an audit log",
      ),
      parameters: [id("userId")],
      requestBody: body(
        { planCode: { type: "string", enum: ["starter", "pro", "advanced"] } },
        ["planCode"],
      ),
    },
  },
  "/business/company": {
    get: operation(
      "Owner: cumulative company and current-member activity, seats and invitations",
    ),
    patch: {
      ...operation("Owner: rename company"),
      requestBody: body(
        { name: { type: "string", minLength: 2, maxLength: 150 } },
        ["name"],
      ),
    },
  },
  "/business/company/lookup": {
    post: {
      ...operation(
        "Active owner: review a registered colleague by exact phone before confirming",
      ),
      requestBody: body({ phone: { type: "string", example: "09123456789" } }, [
        "phone",
      ]),
      responses: {
        ...responses,
        "429": { description: "Phone lookup rate limit exceeded" },
      },
    },
  },
  "/business/company/members": {
    post: {
      ...operation(
        "Active owner: directly add or invite a reviewed colleague; pending invites reserve a seat for 7 days",
      ),
      requestBody: body(
        {
          userId: { type: "string", format: "uuid" },
          mode: { type: "string", enum: ["direct", "invite"] },
        },
        ["userId", "mode"],
      ),
      responses: {
        ...responses,
        "201": {
          description: "Created membership or invitation: data { id, mode }",
        },
      },
    },
  },
  "/business/company/members/{userId}": {
    delete: {
      ...operation(
        "Owner removes colleague, or colleague leaves; historical activity retained",
      ),
      parameters: [id("userId")],
    },
  },
  "/business/company/invitations/{invitationId}": {
    delete: {
      ...operation("Owner revokes a pending invitation and releases its seat"),
      parameters: [id("invitationId")],
    },
  },
  "/business/invitations/{invitationId}/respond": {
    post: {
      ...operation("Invitee accepts or declines an invitation"),
      parameters: [id("invitationId")],
      requestBody: body(
        { action: { type: "string", enum: ["accept", "decline"] } },
        ["action"],
      ),
      responses: { ...responses, "410": { description: "Invitation expired" } },
    },
  },
};
