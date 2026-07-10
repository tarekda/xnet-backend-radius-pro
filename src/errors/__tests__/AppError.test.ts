import { BadRequestError, coerceToAppError, ForbiddenError, NotFoundError } from "../AppError";

describe("AppError / coerceToAppError", () => {
  it("maps not-found messages to 404", () => {
    const err = coerceToAppError(new Error("Invoice not found"));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.statusCode).toBe(404);
    expect(err.expose).toBe(true);
  });

  it("maps forbidden messages to 403", () => {
    const err = coerceToAppError(new Error("Forbidden"));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.statusCode).toBe(403);
  });

  it("maps validation-ish messages to 400", () => {
    const err = coerceToAppError(new Error("Only cash invoices can be reconciled"));
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.statusCode).toBe(400);
  });

  it("hides unknown 500 messages from clients", () => {
    const err = coerceToAppError(new Error("ECONNRESET weird db"));
    expect(err.statusCode).toBe(500);
    expect(err.expose).toBe(false);
  });
});
