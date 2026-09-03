import { AppError } from "../middlewares/errorHandler";

const MIN_UPLOAD_NAME_LENGTH = 2;
const MAX_UPLOAD_NAME_LENGTH = 150;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export const parseUploadName = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new AppError(400, "name is required", "INVALID_UPLOAD_NAME");
  }

  const name = value.trim();
  if (
    name.length < MIN_UPLOAD_NAME_LENGTH ||
    name.length > MAX_UPLOAD_NAME_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(name)
  ) {
    throw new AppError(
      400,
      `name must contain between ${MIN_UPLOAD_NAME_LENGTH} and ` +
        `${MAX_UPLOAD_NAME_LENGTH} characters without control characters`,
      "INVALID_UPLOAD_NAME",
    );
  }

  return name;
};
