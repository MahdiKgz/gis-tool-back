ALTER TABLE "analyses" ADD COLUMN "report" JSONB;
UPDATE "analyses" SET "report" = "payload"->'report', "payload" = "payload" - 'report' WHERE "payload" ? 'report';
