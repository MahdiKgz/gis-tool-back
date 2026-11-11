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
  "/business/company/spatial-images": {
    get: operation("List the active company's shared spatial images and quota"),
  },
  "/business/company/spatial-images/presign": {
    post: {
      ...operation("Reserve a company image slot and sign a size-bound MinIO POST"),
      requestBody: body({
        fileName: { type: "string", maxLength: 255, example: "orthophoto.tiff" },
        size: { type: "integer", format: "int64", minimum: 1, maximum: 5368709120 },
      }, ["fileName", "size"]),
      responses: { ...responses, "201": { description: "Reservation ID, URL, signed form fields and expiry" } },
    },
  },
  "/business/company/spatial-images/{imageId}/complete": {
    post: {
      ...operation("Confirm the direct upload and schedule map tile preparation"),
      parameters: [id("imageId")],
      responses: { ...responses, "202": { description: "Image status" } },
    },
  },
  "/business/company/spatial-images/{imageId}/preview": {
    get: {
      ...operation("Sign a short-lived Range-readable PMTiles URL for a ready image"),
      parameters: [id("imageId")],
    },
  },
  "/business/company/spatial-images/{imageId}": {
    delete: {
      ...operation("Delete a spatial image as its uploader or the company owner"),
      parameters: [id("imageId")],
    },
  },
  "/business/admin/users": {
    get: {
      ...operation(
        "Admin: search/filter accounts with cumulative upload usage and retained file counts",
      ),
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
          name: "role",
          in: "query",
          description:
            "Membership in the roles array; an account can have multiple roles. Empty value means no filter.",
          schema: { type: "string", enum: ["user", "writer", "admin"] },
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
  "/business/admin/users/{userId}": {
    get: {
      ...operation(
        "Admin: account with cumulative upload usage and latest 10 retained files (safe metadata only)",
      ),
      parameters: [id("userId")],
    },
    patch: {
      ...operation(
        "Admin: update name and Iranian mobile number; returns the full account list item; extra fields rejected",
      ),
      parameters: [id("userId")],
      requestBody: {
        ...body(
          {
            name: { type: "string", minLength: 2, maxLength: 100 },
            phone: { type: "string", example: "09123456789" },
          },
          ["name", "phone"],
        ),
      },
      responses: {
        ...responses,
        "409": { description: "Phone already belongs to another account" },
      },
    },
  },
  "/business/admin/reports": {
    get: {
      ...operation(
        "Admin: aggregate system report, UTC upload-date buckets including deleted history; current account/company/plan snapshot",
      ),
      description:
        "Defaults to the last 30 UTC calendar days. Inclusive from/to, maximum 366 days. Completed/failed counts represent current status of uploads created in the period, not completion event timestamps. Recent failures only include retained files; no stack traces, object keys or internal paths. See Admin_Management.md for the response contract.",
      parameters: ["from", "to"].map((name) => ({
        name,
        in: "query",
        schema: { type: "string", format: "date" },
      })),
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
  "/business/admin/users/{userId}/writer-role": {
    patch: {
      ...operation("Admin: grant or revoke article publishing access"),
      parameters: [id("userId")],
      requestBody: body({ enabled: { type: "boolean" } }, ["enabled"]),
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
        "Active owner: invite a reviewed colleague; membership requires invitee acceptance; pending invites reserve a seat for 7 days",
      ),
      requestBody: body(
        {
          userId: { type: "string", format: "uuid" },
        },
        ["userId"],
      ),
      responses: {
        ...responses,
        "201": {
          description:
            "Created invitation: data { id, mode: invite }. Legacy direct-add requests are rejected.",
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
