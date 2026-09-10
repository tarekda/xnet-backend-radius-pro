import { csrfProtectionMiddleware } from "../csrfProtection";
import { Request, Response, NextFunction } from "express";

function createMockReqRes(overrides: Partial<Request> = {}) {
  const req: Partial<Request> = {
    method: "POST",
    path: "/api/subscriber/invoices/1/pay-from-wallet",
    originalUrl: "/api/subscriber/invoices/1/pay-from-wallet",
    headers: {},
    ...overrides,
  };

  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const res: Partial<Response> = {
    status: statusMock,
    json: jsonMock,
  };

  const next: NextFunction = jest.fn();

  return {
    req: req as Request,
    res: res as Response,
    next,
    statusMock,
    jsonMock,
  };
}

describe("csrfProtectionMiddleware", () => {
  const middleware = csrfProtectionMiddleware();

  it("exempts safe HTTP methods like GET and OPTIONS", () => {
    const { req, res, next } = createMockReqRes({ method: "GET" });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("exempts /api/auth/subscriber/login without custom headers", () => {
    const { req, res, next } = createMockReqRes({
      method: "POST",
      path: "/api/auth/subscriber/login",
      originalUrl: "/api/auth/subscriber/login",
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("exempts /api/auth/subscriber/refresh and /api/auth/subscriber/logout", () => {
    const { req, res, next } = createMockReqRes({
      method: "POST",
      path: "/api/auth/subscriber/refresh",
      originalUrl: "/api/auth/subscriber/refresh",
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("exempts /api/auth/mobile/ endpoints", () => {
    const { req, res, next } = createMockReqRes({
      method: "POST",
      path: "/api/auth/mobile/login",
      originalUrl: "/api/auth/mobile/login",
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("allows requests with X-Requested-With header", () => {
    const { req, res, next } = createMockReqRes({
      method: "POST",
      path: "/api/subscriber/buy-voucher",
      originalUrl: "/api/subscriber/buy-voucher",
      headers: { "x-requested-with": "XMLHttpRequest" },
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("allows requests with Authorization: Bearer token", () => {
    const { req, res, next } = createMockReqRes({
      method: "POST",
      path: "/api/subscriber/buy-voucher",
      originalUrl: "/api/subscriber/buy-voucher",
      headers: { authorization: "Bearer some-token" },
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("blocks state-changing unauthenticated requests with no custom headers or matching origin", () => {
    const { req, res, next, statusMock } = createMockReqRes({
      method: "POST",
      path: "/api/subscriber/buy-voucher",
      originalUrl: "/api/subscriber/buy-voucher",
      headers: { host: "api.example.com", origin: "https://evil.com" },
    });
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(403);
  });
});
