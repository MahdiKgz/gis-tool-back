const errorResponses = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "500": { $ref: "#/components/responses/InternalError" },
};

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "SnapGIS API",
    version: "1.0.0",
    description:
      "Authentication and topology analysis/healing API. Access tokens are short-lived Bearer JWTs. The refresh token is rotated in an HttpOnly cookie and is never exposed to JavaScript.",
  },
  servers: [{ url: "/api", description: "Current server" }],
  tags: [
    { name: "System", description: "Service health" },
    { name: "Authentication", description: "Account and session lifecycle" },
    { name: "Topology", description: "GIS validation and healing workflow" },
    { name: "Files", description: "Authenticated file ownership and management" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        summary: "Check API health",
        responses: {
          "200": {
            description: "API is running",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                  required: ["status", "timestamp"],
                },
              },
            },
          },
        },
      },
    },
    "/auth/register": {
      post: {
        tags: ["Authentication"],
        summary: "Create an account",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RegisterRequest" },
            },
          },
        },
        responses: {
          "201": { $ref: "#/components/responses/AuthSuccess" },
          "409": {
            description: "Phone already registered",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": { $ref: "#/components/responses/RateLimited" },
          ...errorResponses,
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Authentication"],
        summary: "Sign in",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/AuthSuccess" },
          "429": { $ref: "#/components/responses/RateLimited" },
          ...errorResponses,
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["Authentication"],
        summary: "Rotate the refresh session and obtain an access token",
        security: [{ refreshCookie: [] }],
        responses: {
          "200": { $ref: "#/components/responses/AuthSuccess" },
          "429": { $ref: "#/components/responses/RateLimited" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Authentication"],
        summary: "Revoke the current refresh session",
        security: [{ refreshCookie: [] }],
        responses: {
          "204": { description: "Signed out" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Authentication"],
        summary: "Get the authenticated account",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Current account",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    data: {
                      type: "object",
                      properties: { user: { $ref: "#/components/schemas/User" } },
                      required: ["user"],
                    },
                  },
                  required: ["success", "data"],
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/upload": {
      post: {
        tags: ["Topology"],
        summary: "Upload and dry-run analyze a GIS file",
        description: "Accepts GeoJSON, JSON, KML, KMZ, SHP, or a ZIP shapefile bundle up to 5 MB. No repair is performed by this request.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    minLength: 2,
                    maxLength: 150,
                    description: "User-facing name for identifying the uploaded dataset",
                  },
                  file: { type: "string", format: "binary" },
                  tolerance: {
                    type: "number",
                    minimum: 0,
                    maximum: 100000,
                    default: 25,
                    description: "Topology tolerance in millimeters",
                  },
                },
                required: ["name", "file"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Dry run completed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/UploadResponse" } } },
          },
          "413": { description: "File is larger than 5 MB" },
          "422": { description: "GIS file could not be parsed" },
          ...errorResponses,
        },
      },
    },
    "/files": {
      get: {
        tags: ["Files"],
        summary: "List files owned by the authenticated user",
        security: [{ bearerAuth: [] }],
        parameters: [
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
        responses: {
          "200": {
            description: "Current user's file page",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FileListResponse" },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/files/summary": {
      get: {
        tags: ["Files"],
        summary: "Get the authenticated user's dashboard summary",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Current plan and persisted upload activity totals",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DashboardSummaryResponse" },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/files/{fileId}": {
      parameters: [{ $ref: "#/components/parameters/FileId" }],
      get: {
        tags: ["Files"],
        summary: "Get an owned file with its analysis and healing details",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Owned file detail",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FileDetailResponse" },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          ...errorResponses,
        },
      },
      patch: {
        tags: ["Files"],
        summary: "Rename an owned file",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 2, maxLength: 150 },
                },
                required: ["name"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Renamed file summary",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FileSummaryResponse" },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          ...errorResponses,
        },
      },
      delete: {
        tags: ["Files"],
        summary: "Delete an owned file and its managed artifacts",
        security: [{ bearerAuth: [] }],
        responses: {
          "204": { description: "File deleted" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "Healing is queued or processing" },
          ...errorResponses,
        },
      },
    },
    "/heal/{jobId}": {
      parameters: [{ $ref: "#/components/parameters/JobId" }],
      post: {
        tags: ["Topology"],
        summary: "Queue healing for a completed dry run",
        security: [{ bearerAuth: [] }],
        responses: {
          "202": { $ref: "#/components/responses/HealStatus" },
          "404": { $ref: "#/components/responses/NotFound" },
          "410": { description: "Uploaded source file has expired" },
          ...errorResponses,
        },
      },
      get: {
        tags: ["Topology"],
        summary: "Read healing status",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { $ref: "#/components/responses/HealStatus" },
          "404": { $ref: "#/components/responses/NotFound" },
          ...errorResponses,
        },
      },
    },
    "/heal/{jobId}/events": {
      get: {
        tags: ["Topology"],
        summary: "Stream healing lifecycle events",
        description:
          "Authenticated SSE stream. Emits snapshot, progress, completed, and failed events, plus heartbeat comments every 20 seconds.",
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/JobId" }],
        responses: {
          "200": {
            description: "Healing lifecycle event stream",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          ...errorResponses,
        },
      },
    },
    "/heal/{jobId}/output": {
      get: {
        tags: ["Topology"],
        summary: "Preview healed GeoJSON",
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/JobId" }],
        responses: {
          "200": {
            description: "Healed GeoJSON",
            content: { "application/geo+json": { schema: { type: "object" } } },
          },
          "409": { description: "Healing has not completed" },
          "410": { description: "Output has expired" },
          "404": { $ref: "#/components/responses/NotFound" },
          ...errorResponses,
        },
      },
    },
    "/heal/{jobId}/download": {
      get: {
        tags: ["Topology"],
        summary: "Download healed output",
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: "#/components/parameters/JobId" }],
        responses: {
          "200": {
            description: "GeoJSON attachment",
            content: { "application/geo+json": { schema: { type: "string", format: "binary" } } },
          },
          "409": { description: "Healing has not completed" },
          "410": { description: "Output has expired" },
          "404": { $ref: "#/components/responses/NotFound" },
          ...errorResponses,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      refreshCookie: { type: "apiKey", in: "cookie", name: "snapgis_refresh" },
    },
    parameters: {
      JobId: {
        name: "jobId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      FileId: {
        name: "fileId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
    },
    schemas: {
      LoginRequest: {
        type: "object",
        properties: {
          phone: { type: "string", pattern: "^09[0-9]{9}$", example: "09123456789" },
          password: { type: "string", format: "password", minLength: 8, maxLength: 128 },
        },
        required: ["phone", "password"],
      },
      RegisterRequest: {
        allOf: [
          { $ref: "#/components/schemas/LoginRequest" },
          {
            type: "object",
            properties: { name: { type: "string", minLength: 2, maxLength: 100 } },
            required: ["name"],
          },
        ],
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          phone: { type: "string" },
          roles: { type: "array", items: { type: "string" } },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "phone", "roles", "createdAt"],
      },
      AuthResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              accessToken: { type: "string", description: "Short-lived Bearer access token" },
              user: { $ref: "#/components/schemas/User" },
            },
            required: ["accessToken", "user"],
          },
        },
        required: ["success", "data"],
      },
      Error: {
        type: "object",
        properties: {
          success: { type: "boolean", example: false },
          code: { type: "string", example: "INVALID_REQUEST" },
          message: { type: "string" },
        },
        required: ["success", "code", "message"],
      },
      UploadResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          message: { type: "string" },
          data: {
            type: "object",
            properties: {
              jobId: { type: "string", format: "uuid" },
              userId: { type: "string", format: "uuid" },
              name: { type: "string" },
              status: { type: "string", example: "dry-run-complete" },
              originalName: { type: "string" },
              sizeInBytes: { type: "integer" },
              appliedTolerance: { type: "number" },
              report: { type: "object", additionalProperties: true },
              heal: {
                type: "object",
                properties: { method: { type: "string" }, path: { type: "string" } },
              },
            },
            required: ["jobId", "userId", "name", "status", "report", "heal"],
          },
        },
        required: ["success", "data"],
      },
      FileSummary: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          originalName: { type: "string" },
          sizeInBytes: { type: "integer" },
          uploadedAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          status: {
            type: "string",
            enum: ["dry-run-complete", "queued", "processing", "completed", "failed", "unavailable"],
          },
          isHealed: { type: "boolean" },
          issuesFound: { type: "integer", nullable: true },
        },
        required: ["id", "name", "originalName", "sizeInBytes", "uploadedAt", "updatedAt", "status", "isHealed", "issuesFound"],
      },
      DashboardSummaryResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              plan: {
                type: "object",
                properties: {
                  code: { type: "string", enum: ["free"] },
                  name: { type: "string", example: "رایگان" },
                  expiresAt: { type: "string", format: "date-time", nullable: true },
                  remainingDays: { type: "integer", nullable: true },
                },
                required: ["code", "name", "expiresAt", "remainingDays"],
              },
              usage: {
                type: "object",
                properties: {
                  files: { type: "integer", minimum: 0 },
                  identifiedIssues: { type: "integer", minimum: 0 },
                  healedIssues: { type: "integer", minimum: 0 },
                },
                required: ["files", "identifiedIssues", "healedIssues"],
              },
            },
            required: ["plan", "usage"],
          },
        },
        required: ["success", "data"],
      },
      FileSummaryResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: { $ref: "#/components/schemas/FileSummary" },
        },
        required: ["success", "data"],
      },
      FileListResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { $ref: "#/components/schemas/FileSummary" },
              },
              pagination: {
                type: "object",
                properties: {
                  skip: { type: "integer" },
                  limit: { type: "integer" },
                  total: { type: "integer" },
                  hasMore: { type: "boolean" },
                },
                required: ["skip", "limit", "total", "hasMore"],
              },
            },
            required: ["items", "pagination"],
          },
        },
        required: ["success", "data"],
      },
      FileDetailResponse: {
        type: "object",
        properties: {
          success: { type: "boolean", example: true },
          data: {
            allOf: [
              { $ref: "#/components/schemas/FileSummary" },
              {
                type: "object",
                properties: {
                  mimeType: { type: "string" },
                  report: { type: "object", nullable: true, additionalProperties: true },
                  healing: { type: "object", additionalProperties: true },
                },
                required: ["mimeType", "report", "healing"],
              },
            ],
          },
        },
        required: ["success", "data"],
      },
      HealStatus: {
        type: "object",
        properties: {
          jobId: { type: "string", format: "uuid" },
          dryRunJobId: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["dry-run-complete", "queued", "processing", "completed", "failed"] },
          progress: { type: "number", minimum: 0, maximum: 100 },
          queuedAt: { type: "string", format: "date-time", nullable: true },
          startedAt: { type: "string", format: "date-time", nullable: true },
          completedAt: { type: "string", format: "date-time", nullable: true },
          failedAt: { type: "string", format: "date-time", nullable: true },
          error: { type: "string", nullable: true },
          progressDetail: {
            type: "object",
            nullable: true,
            properties: {
              value: { type: "number", minimum: 0, maximum: 100 },
              stage: {
                type: "string",
                enum: ["parsing", "error-detection", "healing", "report-generation"],
              },
              issueCounts: {
                type: "object",
                properties: {
                  gap: { type: "integer", minimum: 0 },
                  sliver: { type: "integer", minimum: 0 },
                  kink: { type: "integer", minimum: 0 },
                  spike: { type: "integer", minimum: 0 },
                },
                required: ["gap", "sliver", "kink", "spike"],
              },
            },
            required: ["value", "stage", "issueCounts"],
          },
          result: { type: "object", nullable: true, additionalProperties: true },
          links: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["jobId", "dryRunJobId", "status", "progress", "progressDetail", "links"],
      },
    },
    responses: {
      AuthSuccess: {
        description: "Authenticated. Also sets the rotating HttpOnly refresh cookie.",
        headers: { "Set-Cookie": { schema: { type: "string" } } },
        content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } },
      },
      HealStatus: {
        description: "Healing lifecycle status",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                success: { type: "boolean", example: true },
                data: { $ref: "#/components/schemas/HealStatus" },
              },
            },
          },
        },
      },
      BadRequest: {
        description: "Invalid request",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      Unauthorized: {
        description: "Authentication failed",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      NotFound: {
        description: "Job not found or not owned by the authenticated user",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      RateLimited: {
        description: "Authentication rate limit exceeded",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      InternalError: {
        description: "Unexpected server error",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
};
